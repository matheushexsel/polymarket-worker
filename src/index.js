// src/index.js

import express from "express";
import { ethers } from "ethers";
import { Buffer } from "buffer";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

// Buffer polyfill for ESM runtimes / SDK internals
globalThis.Buffer = Buffer;

const app = express();
app.use(express.json());

/* =======================
   ENV
======================= */
const WORKER_SECRET = process.env.WORKER_SECRET;

const PM_PRIVATE_KEY = process.env.PM_PRIVATE_KEY;
const PM_CLOB_HOST = process.env.PM_CLOB_HOST || "https://clob.polymarket.com";
const PM_GAMMA_HOST = process.env.PM_GAMMA_HOST || "https://gamma-api.polymarket.com";
const PM_SIGNATURE_TYPE = Number(process.env.PM_SIGNATURE_TYPE || 0);

const PM_API_KEY = process.env.PM_API_KEY;
const PM_API_SECRET = process.env.PM_API_SECRET;
const PM_API_PASSPHRASE = process.env.PM_API_PASSPHRASE;

const PORT = Number(process.env.PORT || 3000);
const CHAIN_ID = 137; // Polygon mainnet

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!WORKER_SECRET) die("Missing WORKER_SECRET");
if (!PM_PRIVATE_KEY) die("Missing PM_PRIVATE_KEY");
if (!PM_API_KEY) die("Missing PM_API_KEY");
if (!PM_API_SECRET) die("Missing PM_API_SECRET");
if (!PM_API_PASSPHRASE) die("Missing PM_API_PASSPHRASE");

/* =======================
   AUTH
======================= */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${WORKER_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function isDryRun(req) {
  return req.headers["x-dry-run"] === "1" || req.headers["x-dry-run"] === "true";
}

/* =======================
   CLOB CLIENT INIT
======================= */
let wallet = null;
let walletAddress = null;
let clobClient = null;
let clientInitPromise = null;

async function initClient() {
  if (clobClient) return clobClient;
  if (clientInitPromise) return clientInitPromise;

  clientInitPromise = (async () => {
    try {
      console.log("[Worker] Initializing CLOB client (explicit L2 creds)...");
      console.log(`[Worker] Host: ${PM_CLOB_HOST}, ChainId: ${CHAIN_ID}, SignatureType: ${PM_SIGNATURE_TYPE}`);

      wallet = new ethers.Wallet(PM_PRIVATE_KEY);
      walletAddress = await wallet.getAddress();
      console.log(`[Worker] Wallet: ${walletAddress}`);

      // IMPORTANT: many clob-client versions expect these EXACT keys:
      // apiKey, secret, passphrase
      const creds = {
        apiKey: PM_API_KEY,
        secret: PM_API_SECRET,
        passphrase: PM_API_PASSPHRASE,
      };

      clobClient = new ClobClient(PM_CLOB_HOST, CHAIN_ID, wallet, creds, PM_SIGNATURE_TYPE);
      console.log("[Worker] CLOB client ready");
      return clobClient;
    } catch (err) {
      console.error("[Worker] CLOB init failed:", err?.message || err);
      clientInitPromise = null;
      throw err;
    }
  })();

  return clientInitPromise;
}

/* =======================
   SDK HELPERS
======================= */
function getClientMethodNames(client) {
  try {
    const proto = Object.getPrototypeOf(client);
    const names = new Set([
      ...Object.getOwnPropertyNames(proto || {}),
      ...Object.keys(client || {}),
    ]);
    return Array.from(names).sort();
  } catch {
    return [];
  }
}

async function safeGetOrders(client) {
  // Try common variations across versions
  if (typeof client.getOrders === "function") return await client.getOrders();
  if (typeof client.getOpenOrders === "function") return await client.getOpenOrders();
  if (typeof client.getActiveOrders === "function") return await client.getActiveOrders();
  if (typeof client.listOrders === "function") return await client.listOrders();
  throw new Error("No supported orders method found on client (expected getOrders/getOpenOrders/etc).");
}

async function safePlaceOrder(client, params, options) {
  // options: { tickSize, negRisk, orderType }
  const orderType = options?.orderType ?? OrderType?.GTC;

  // Preferred method
  if (typeof client.createAndPostOrder === "function") {
    return await client.createAndPostOrder(params, options, orderType);
  }

  // Next best: createOrder + postOrder
  if (typeof client.createOrder === "function" && typeof client.postOrder === "function") {
    const created = await client.createOrder(params, options, orderType);
    // Some versions return a signed order object that you then submit
    return await client.postOrder(created);
  }

  // Some versions accept postOrder directly with params
  if (typeof client.postOrder === "function") {
    return await client.postOrder(params, options, orderType);
  }

  // As a last resort, at least create the order (won’t execute trade)
  if (typeof client.createOrder === "function") {
    const created = await client.createOrder(params, options, orderType);
    return { createdOnly: true, created };
  }

  throw new Error("No supported place-order method found on client (expected createAndPostOrder/createOrder+postOrder/postOrder).");
}

/* =======================
   ROUTES
======================= */

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    walletAddress: walletAddress || null,
    clientStatus: clobClient ? "ready" : clientInitPromise ? "initializing" : "not_initialized",
    clobHost: PM_CLOB_HOST,
    gammaHost: PM_GAMMA_HOST,
    signatureType: PM_SIGNATURE_TYPE,
    nodeVersion: process.version,
    bufferType: typeof globalThis.Buffer,
    timestamp: new Date().toISOString(),
  });
});

// THIS IS THE KEY DEBUG ENDPOINT — MUST NOT 404
app.get("/sdk", requireAuth, async (req, res) => {
  try {
    const client = await initClient();
    const methods = getClientMethodNames(client);

    res.json({
      ok: true,
      nodeVersion: process.version,
      bufferType: typeof globalThis.Buffer,
      clobHost: PM_CLOB_HOST,
      signatureType: PM_SIGNATURE_TYPE,
      walletAddress: walletAddress || null,
      sdk: {
        hasCreateAndPostOrder: typeof client.createAndPostOrder === "function",
        hasCreateOrder: typeof client.createOrder === "function",
        hasPostOrder: typeof client.postOrder === "function",
        hasGetOrders: typeof client.getOrders === "function",
        hasGetOpenOrders: typeof client.getOpenOrders === "function",
        hasGetBalanceAllowance: typeof client.getBalanceAllowance === "function",
        hasCancelOrder: typeof client.cancelOrder === "function",
      },
      clientMethods: methods,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get("/orders", requireAuth, async (req, res) => {
  try {
    const client = await initClient();
    const orders = await safeGetOrders(client);
    return res.json({ success: true, count: orders?.length || 0, orders });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

/**
 * Place limit order
 * Body: { tokenId, side, price, size, tickSize?, negRisk? }
 * Headers: X-Dry-Run: 1 (optional)
 */
app.post("/place", requireAuth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const { tokenId, side, price, size, tickSize = "0.01", negRisk = false } = req.body || {};

    if (!tokenId || !side || typeof price !== "number" || typeof size !== "number") {
      return res.status(400).json({ success: false, error: "invalid_body" });
    }

    const normalizedSide = String(side).toUpperCase();
    if (normalizedSide !== "BUY" && normalizedSide !== "SELL") {
      return res.status(400).json({ success: false, error: "side_must_be_BUY_or_SELL" });
    }
    if (price <= 0 || price >= 1) {
      return res.status(400).json({ success: false, error: "price_must_be_between_0_and_1" });
    }
    if (size <= 0) {
      return res.status(400).json({ success: false, error: "size_must_be_positive" });
    }

    console.log(
      `[Worker] ${dryRun ? "[DRY-RUN] " : ""}PLACE ${normalizedSide} token=${String(tokenId).slice(0, 18)}... price=${price} size=${size}`
    );

    const client = await initClient();

    if (dryRun) {
      // Validate client supports placing orders
      const canPlace =
        typeof client.createAndPostOrder === "function" ||
        (typeof client.createOrder === "function" && typeof client.postOrder === "function") ||
        typeof client.postOrder === "function";

      return res.json({
        success: true,
        dryRun: true,
        canPlace,
        orderId: null,
        message: "validated_only",
      });
    }

    const sideEnum = normalizedSide === "BUY" ? Side.BUY : Side.SELL;

    const resp = await safePlaceOrder(
      client,
      { tokenID: tokenId, price, size, side: sideEnum },
      { tickSize, negRisk, orderType: OrderType?.GTC }
    );

    const orderId = resp?.orderID || resp?.id || resp?.order_id || null;

    return res.json({
      success: true,
      dryRun: false,
      orderId,
      response: resp,
    });
  } catch (err) {
    console.error("[Worker] /place error:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

/**
 * Cancel order
 * Body: { orderId }
 */
app.post("/cancel", requireAuth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, error: "missing_orderId" });

    const client = await initClient();

    if (dryRun) {
      return res.json({ success: true, dryRun: true, cancelled: false, message: "validated_only" });
    }

    if (typeof client.cancelOrder !== "function") {
      return res.status(500).json({ success: false, error: "cancelOrder_not_supported_by_installed_sdk" });
    }

    const result = await client.cancelOrder(orderId);
    return res.json({ success: true, dryRun: false, cancelled: true, result });
  } catch (err) {
    console.error("[Worker] /cancel error:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

/**
 * Positions for token (shares)
 * Query: ?tokenId=...
 */
app.get("/positions", requireAuth, async (req, res) => {
  try {
    const tokenId = req.query.tokenId;
    if (!tokenId) return res.status(400).json({ success: false, error: "missing_tokenId" });

    const client = await initClient();

    if (typeof client.getBalanceAllowance !== "function") {
      return res.status(500).json({ success: false, error: "getBalanceAllowance_not_supported_by_installed_sdk" });
    }

    const bal = await client.getBalanceAllowance(tokenId);
    const shares = Number(bal?.balance || 0);

    return res.json({ success: true, tokenId, shares, raw: bal });
  } catch (err) {
    console.error("[Worker] /positions error:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

/* =======================
   START
======================= */
app.listen(PORT, () => {
  console.log(`[Worker] listening on ${PORT}`);
  initClient().catch((e) => console.error("[Worker] init on start failed:", e?.message || e));
});
