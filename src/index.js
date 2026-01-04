import express from "express";
import { webcrypto } from "node:crypto";

// Ensure WebCrypto is available (Node 18 sometimes needs this explicitly)
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { ethers } from "ethers"; // MUST be ethers v5 (see package.json)
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

const app = express();
app.use(express.json());

/* =======================
   ENV
======================= */
const WORKER_SECRET = process.env.WORKER_SECRET;

const PM_PRIVATE_KEY = process.env.PM_PRIVATE_KEY;
const PM_CLOB_HOST = (process.env.PM_CLOB_HOST || "https://clob.polymarket.com").trim();
const PM_GAMMA_HOST = (process.env.PM_GAMMA_HOST || "https://gamma-api.polymarket.com").trim();
const PM_SIGNATURE_TYPE = Number(process.env.PM_SIGNATURE_TYPE || 0);

// L2 API creds (these must come from Polymarket API keys page)
const PM_API_KEY = (process.env.PM_API_KEY || "").trim();
const PM_API_SECRET = (process.env.PM_API_SECRET || "").trim();
const PM_API_PASSPHRASE = (process.env.PM_API_PASSPHRASE || "").trim();

const PORT = Number(process.env.PORT || 3000);
const CHAIN_ID = 137; // Polygon mainnet

// Version marker so you can confirm Railway deployed the right build
const VERSION = "ethers5-webcrypto-v2";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!WORKER_SECRET) die("Missing WORKER_SECRET");
if (!PM_PRIVATE_KEY) die("Missing PM_PRIVATE_KEY");
if (!PM_API_KEY || !PM_API_SECRET || !PM_API_PASSPHRASE) {
  die("Missing one or more L2 API credentials: PM_API_KEY / PM_API_SECRET / PM_API_PASSPHRASE");
}

/* =======================
   AUTH
======================= */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${WORKER_SECRET}`) {
    return res.status(401).json({ success: false, error: "unauthorized" });
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
let initPromise = null;

async function initClient() {
  if (clobClient) return clobClient;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log(`[BOOT] version=${VERSION}`);
      console.log(`[Worker] CLOB Host: ${PM_CLOB_HOST}`);
      console.log(`[Worker] Gamma Host: ${PM_GAMMA_HOST}`);
      console.log(`[Worker] Chain ID: ${CHAIN_ID}`);
      console.log(`[Worker] Signature Type: ${PM_SIGNATURE_TYPE}`);

      // ethers v5 wallet (has _signTypedData which the SDK expects)
      wallet = new ethers.Wallet(PM_PRIVATE_KEY);
      walletAddress = await wallet.getAddress();
      console.log(`[Worker] Wallet: ${walletAddress}`);

      // IMPORTANT: Polymarket docs use keys: apiKey, secret, passphrase
      // (NOT apiSecret/apiPassphrase)
      const creds = {
        apiKey: PM_API_KEY,
        secret: PM_API_SECRET,
        passphrase: PM_API_PASSPHRASE,
      };

      clobClient = new ClobClient(PM_CLOB_HOST, CHAIN_ID, wallet, creds, PM_SIGNATURE_TYPE);

      console.log("[Worker] CLOB client initialized");
      return clobClient;
    } catch (err) {
      console.error("[Worker] init failed:", err?.message || err);
      clobClient = null;
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/* =======================
   ROUTES
======================= */

// No auth: lets you confirm the deployed build
app.get("/version", (req, res) => {
  res.json({
    version: VERSION,
    node: process.version,
    timestamp: new Date().toISOString(),
  });
});

// No auth: does not force init
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    walletAddress: walletAddress || null,
    clientStatus: clobClient ? "ready" : initPromise ? "initializing" : "not_initialized",
    clobHost: PM_CLOB_HOST,
    gammaHost: PM_GAMMA_HOST,
    timestamp: new Date().toISOString(),
  });
});

// Auth: list open orders (useful for verifying L2 calls)
app.get("/orders", requireAuth, async (req, res) => {
  try {
    const client = await initClient();

    // SDK variants differ; this is the most commonly documented one in practice.
    // If your SDK build exposes getOpenOrders(), use it.
    if (typeof client.getOpenOrders !== "function") {
      return res.status(500).json({
        success: false,
        error: "SDK missing getOpenOrders() - check @polymarket/clob-client version",
      });
    }

    const orders = await client.getOpenOrders();
    return res.json({ success: true, count: Array.isArray(orders) ? orders.length : null, orders });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// Auth: place limit order
// Body: { tokenId, side, price, size, tickSize?, negRisk? }
// Header optional: X-Dry-Run: 1
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
      `[Worker] ${dryRun ? "[DRY-RUN] " : ""}PLACE ${normalizedSide} token=${String(tokenId).slice(
        0,
        18
      )}... price=${price} size=${size}`
    );

    const client = await initClient();

    if (dryRun) {
      return res.json({ success: true, dryRun: true, orderId: null, message: "validated_only" });
    }

    if (typeof client.createAndPostOrder !== "function") {
      return res.status(500).json({
        success: false,
        error: "SDK missing createAndPostOrder() - check @polymarket/clob-client version",
      });
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
    // If you see "Attention Required | Cloudflare", that is not a coding bug.
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// Auth: cancel order
app.post("/cancel", requireAuth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, error: "missing_orderId" });

    console.log(`[Worker] ${dryRun ? "[DRY-RUN] " : ""}CANCEL orderId=${orderId}`);

    const client = await initClient();

    if (dryRun) {
      return res.json({ success: true, dryRun: true, cancelled: false, message: "validated_only" });
    }

    if (typeof client.cancelOrder !== "function") {
      return res.status(500).json({
        success: false,
        error: "SDK missing cancelOrder() - check @polymarket/clob-client version",
      });
    }

    const result = await client.cancelOrder(orderId);
    return res.json({ success: true, dryRun: false, cancelled: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// Auth: positions
app.get("/positions", requireAuth, async (req, res) => {
  try {
    const tokenId = req.query.tokenId;
    if (!tokenId) return res.status(400).json({ success: false, error: "missing_tokenId" });

    const client = await initClient();

    if (typeof client.getBalanceAllowance !== "function") {
      return res.status(500).json({
        success: false,
        error: "SDK missing getBalanceAllowance() - check @polymarket/clob-client version",
      });
    }

    const bal = await client.getBalanceAllowance(tokenId);
    const shares = Number(bal?.balance || 0);

    return res.json({ success: true, tokenId, shares, raw: bal });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

/* =======================
   START
======================= */
app.listen(PORT, () => {
  console.log(`[Worker] listening on ${PORT}`);
});
