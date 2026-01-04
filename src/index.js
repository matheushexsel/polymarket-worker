// src/index.js

import express from "express";
import { Buffer } from "buffer";

// IMPORTANT: Use ethers v5 (not v6)
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";

import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

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

// L2 API credentials
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

// Optional provider: some flows work without it, but v5 wallet is happier with one.
// We'll use Polygon public RPC by default (can override with POLYGON_RPC_URL).
const POLYGON_RPC_URL =
  process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const provider = new JsonRpcProvider(POLYGON_RPC_URL);

async function initClient() {
  if (clobClient) return clobClient;
  if (clientInitPromise) return clientInitPromise;

  clientInitPromise = (async () => {
    try {
      console.log("[Worker] Initializing CLOB client (ethers v5 signer)...");
      console.log(`[Worker] Host: ${PM_CLOB_HOST}, ChainId: ${CHAIN_ID}, SignatureType: ${PM_SIGNATURE_TYPE}`);

      wallet = new Wallet(PM_PRIVATE_KEY, provider);
      walletAddress = await wallet.getAddress();
      console.log(`[Worker] Wallet: ${walletAddress}`);

      // IMPORTANT: most clob-client versions expect credential keys EXACTLY:
      // apiKey, secret, passphrase
      const creds = {
        apiKey: PM_API_KEY,
        secret: PM_API_SECRET,
        passphrase: PM_API_PASSPHRASE
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

function getClientMethodNames(client) {
  try {
    const proto = Object.getPrototypeOf(client);
    const names = new Set([
      ...Object.getOwnPropertyNames(proto || {}),
      ...Object.keys(client || {})
    ]);
    return Array.from(names).sort();
  } catch {
    return [];
  }
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
    timestamp: new Date().toISOString()
  });
});

// MUST work (proves correct deploy + shows supported methods)
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
        hasPostOrder: typeof client.postOrder === "function",
        hasCreateOrder: typeof client.createOrder === "function",
        hasGetOpenOrders: typeof client.getOpenOrders === "function",
        hasGetOrders: typeof client.getOrders === "function",
        hasGetBalanceAllowance: typeof client.getBalanceAllowance === "function",
        hasCancelOrder: typeof client.cancelOrder === "function"
      },
      clientMethods: methods
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Open orders
app.get("/orders", requireAuth, async (req, res) => {
  try {
    const client = await initClient();

    if (typeof client.getOpenOrders !== "function") {
      return res.status(500).json({ success: false, error: "getOpenOrders_not_supported_by_installed_sdk" });
    }

    const orders = await client.getOpenOrders();
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

    console.log(`[Worker] ${dryRun ? "[DRY-RUN] " : ""}PLACE ${normalizedSide} token=${String(tokenId).slice(0, 18)}... price=${price} size=${size}`);

    const client = await initClient();

    if (typeof client.createAndPostOrder !== "function") {
      return res.status(500).json({ success: false, error: "createAndPostOrder_not_supported_by_installed_sdk" });
    }

    if (dryRun) {
      return res.json({ success: true, dryRun: true, message: "validated_only" });
    }

    const sideEnum = normalizedSide === "BUY" ? Side.BUY : Side.SELL;

    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price, size, side: sideEnum },
      { tickSize, negRisk },
      OrderType.GTC
    );

    const orderId = resp?.orderID || resp?.id || resp?.order_id || null;

    return res.json({ success: true, dryRun: false, orderId, response: resp });
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

    if (typeof client.cancelOrder !== "function") {
      return res.status(500).json({ success: false, error: "cancelOrder_not_supported_by_installed_sdk" });
    }

    if (dryRun) {
      return res.json({ success: true, dryRun: true, cancelled: false, message: "validated_only" });
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
