import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import express from "express";
import { ethers } from "ethers"; // ethers v5 now
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

const app = express();
app.use(express.json());

/* =======================
   ENV (trimmed)
======================= */
const trimOrNull = (v) => (typeof v === "string" ? v.trim() : null);

const WORKER_SECRET = trimOrNull(process.env.WORKER_SECRET);

const PM_PRIVATE_KEY = trimOrNull(process.env.PM_PRIVATE_KEY);
const PM_CLOB_HOST = trimOrNull(process.env.PM_CLOB_HOST) || "https://clob.polymarket.com";
const PM_GAMMA_HOST = trimOrNull(process.env.PM_GAMMA_HOST) || "https://gamma-api.polymarket.com";
const PM_SIGNATURE_TYPE = Number(trimOrNull(process.env.PM_SIGNATURE_TYPE) || 0);

const PM_API_KEY = trimOrNull(process.env.PM_API_KEY);
const PM_API_SECRET = trimOrNull(process.env.PM_API_SECRET);
const PM_API_PASSPHRASE = trimOrNull(process.env.PM_API_PASSPHRASE);

const PORT = Number(process.env.PORT || 3000);
const CHAIN_ID = 137;

if (!WORKER_SECRET) {
  console.error("Missing WORKER_SECRET");
  process.exit(1);
}
if (!PM_PRIVATE_KEY) {
  console.error("Missing PM_PRIVATE_KEY");
  process.exit(1);
}
if (!PM_API_KEY || !PM_API_SECRET || !PM_API_PASSPHRASE) {
  console.error("Missing L2 API credentials: PM_API_KEY / PM_API_SECRET / PM_API_PASSPHRASE");
  process.exit(1);
}

/* =======================
   AUTH
======================= */
function requireAuth(req, res, next) {
  const auth = (req.headers.authorization || "").trim();
  if (auth !== `Bearer ${WORKER_SECRET}`) {
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
    console.log("[BOOT] version=ethers5-webcrypto-v1");
    console.log(`[Worker] Node=${process.version}`);
    console.log(`[Worker] Host=${PM_CLOB_HOST} ChainId=${CHAIN_ID} SignatureType=${PM_SIGNATURE_TYPE}`);

    // ethers v5 Wallet has _signTypedData (what clob-client expects)
    wallet = new ethers.Wallet(PM_PRIVATE_KEY);
    walletAddress = await wallet.getAddress();
    console.log(`[Worker] Wallet=${walletAddress}`);

    // clob-client expects these exact keys: apiKey, secret, passphrase
    const creds = {
      apiKey: PM_API_KEY,
      secret: PM_API_SECRET,
      passphrase: PM_API_PASSPHRASE
    };

    clobClient = new ClobClient(PM_CLOB_HOST, CHAIN_ID, wallet, creds, PM_SIGNATURE_TYPE);
    console.log("[Worker] CLOB client ready");
    return clobClient;
  })();

  return clientInitPromise;
}

/* =======================
   ROUTES
======================= */

app.get("/version", (req, res) => {
  res.json({
    version: "ethers5-webcrypto-v1",
    node: process.version,
    wallet: walletAddress || null,
    timestamp: new Date().toISOString()
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "ethers5-webcrypto-v1",
    walletAddress: walletAddress || null,
    clientStatus: clobClient ? "ready" : clientInitPromise ? "initializing" : "not_initialized",
    clobHost: PM_CLOB_HOST,
    gammaHost: PM_GAMMA_HOST,
    signatureType: PM_SIGNATURE_TYPE,
    node: process.version,
    timestamp: new Date().toISOString()
  });
});

app.get("/orders", requireAuth, async (req, res) => {
  try {
    const client = await initClient();

    // Some SDK builds return { data: [...] }, others return [...]
    const resp = await client.getOpenOrders();
    const orders = Array.isArray(resp) ? resp : Array.isArray(resp?.data) ? resp.data : [];

    return res.json({ success: true, count: orders.length, orders });
  } catch (err) {
    console.error("[Worker] /orders error:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

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

    const client = await initClient();

    if (dryRun) {
      return res.json({ success: true, dryRun: true, orderId: null, message: "validated_only" });
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

app.post("/cancel", requireAuth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, error: "missing_orderId" });

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
  console.log(`[Worker] listening on ${PORT}`);
  initClient().catch((e) => console.error("[Worker] init on start failed:", e?.message || e));
});
