import { webcrypto } from "node:crypto";

// Node 18 compatibility: @polymarket/clob-client expects globalThis.crypto.subtle
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

import express from "express";
import { ethers } from "ethers";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

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

// Explicit L2 creds
const PM_API_KEY = process.env.PM_API_KEY;
const PM_API_SECRET = process.env.PM_API_SECRET;
const PM_API_PASSPHRASE = process.env.PM_API_PASSPHRASE;

const PORT = Number(process.env.PORT || 3000);
const CHAIN_ID = 137; // Polygon mainnet

// Trim credentials defensively (handles pasted whitespace)
const trimOrNull = (v) => (typeof v === "string" ? v.trim() : null);

const WORKER_SECRET_T = trimOrNull(WORKER_SECRET);
const PM_PRIVATE_KEY_T = trimOrNull(PM_PRIVATE_KEY);
const PM_API_KEY_T = trimOrNull(PM_API_KEY);
const PM_API_SECRET_T = trimOrNull(PM_API_SECRET);
const PM_API_PASSPHRASE_T = trimOrNull(PM_API_PASSPHRASE);

if (!WORKER_SECRET_T) {
  console.error("Missing WORKER_SECRET");
  process.exit(1);
}
if (!PM_PRIVATE_KEY_T) {
  console.error("Missing PM_PRIVATE_KEY");
  process.exit(1);
}
if (!PM_API_KEY_T || !PM_API_SECRET_T || !PM_API_PASSPHRASE_T) {
  console.error("Missing one or more L2 API credentials: PM_API_KEY / PM_API_SECRET / PM_API_PASSPHRASE");
  process.exit(1);
}

/* =======================
   AUTH
======================= */
function requireAuth(req, res, next) {
  const auth = (req.headers.authorization || "").trim();
  if (auth !== `Bearer ${WORKER_SECRET_T}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function isDryRun(req) {
  const v = req.headers["x-dry-run"];
  return v === "1" || v === "true";
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
      console.log("[BOOT] version=credstrim-v1");
      console.log("[Worker] Initializing CLOB client (explicit L2 creds + webcrypto polyfill)...");
      console.log(`[Worker] Host: ${PM_CLOB_HOST}, ChainId: ${CHAIN_ID}, SignatureType: ${PM_SIGNATURE_TYPE}`);

      wallet = new ethers.Wallet(PM_PRIVATE_KEY_T);
      walletAddress = await wallet.getAddress();
      console.log(`[Worker] Wallet: ${walletAddress}`);

      // IMPORTANT: credential key names expected by the SDK
      const creds = {
        apiKey: PM_API_KEY_T,
        secret: PM_API_SECRET_T,
        passphrase: PM_API_PASSPHRASE_T
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
   ROUTES
======================= */

// No auth: used to confirm deployment
app.get("/version", (req, res) => {
  res.json({
    version: "credstrim-v1",
    node: process.version,
    wallet: walletAddress || null,
    timestamp: new Date().toISOString()
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "credstrim-v1",
    walletAddress: walletAddress || null,
    clientStatus: clobClient ? "ready" : clientInitPromise ? "initializing" : "not_initialized",
    clobHost: PM_CLOB_HOST,
    gammaHost: PM_GAMMA_HOST,
    signatureType: PM_SIGNATURE_TYPE,
    node: process.version,
    timestamp: new Date().toISOString()
  });
});

// List open orders
app.get("/orders", requireAuth, async (req, res) => {
  try {
    const client = await initClient();
    const orders = await client.getOpenOrders();
    return res.json({ success: true, count: orders?.length || 0, orders });
  } catch (err) {
    console.error("[Worker] /orders error:", err?.message || err);
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
      `[Worker] ${dryRun ? "[DRY-RUN] " : ""}PLACE ${normalizedSide} token=${String(tokenId).slice(0, 16)}... price=${price} size=${size}`
    );

    const client = await initClient();

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        orderId: null,
        message: "validated_only"
      });
    }

    const sideEnum = normalizedSide === "BUY" ? Side.BUY : Side.SELL;

    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price, size, side: sideEnum },
      { tickSize, negRisk },
      OrderType.GTC
    );

    const orderId = resp?.orderID || resp?.id || resp?.order_id || null;

    return res.json({
      success: true,
      dryRun: false,
      orderId,
      response: resp
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

    console.log(`[Worker] ${dryRun ? "[DRY-RUN] " : ""}CANCEL orderId=${orderId}`);

    const client = await initClient();

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
  console.log(`[Worker] worker listening on ${PORT}`);
  // Pre-init client; endpoints will still work if this fails
  initClient().catch((e) => console.error("[Worker] init on start failed:", e?.message || e));
});
