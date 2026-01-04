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

// Explicit L2 creds (required for this version)
const PM_API_KEY = process.env.PM_API_KEY;
const PM_API_SECRET = process.env.PM_API_SECRET;
const PM_API_PASSPHRASE = process.env.PM_API_PASSPHRASE;

const PORT = Number(process.env.PORT || 3000);
const CHAIN_ID = 137; // Polygon mainnet

if (!WORKER_SECRET) {
  console.error("Missing WORKER_SECRET");
  process.exit(1);
}
if (!PM_PRIVATE_KEY) {
  console.error("Missing PM_PRIVATE_KEY");
  process.exit(1);
}
if (!PM_API_KEY || !PM_API_SECRET || !PM_API_PASSPHRASE) {
  console.error("Missing one or more L2 API credentials: PM_API_KEY / PM_API_SECRET / PM_API_PASSPHRASE");
  process.exit(1);
}

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

      // IMPORTANT: credential key names
      const creds = {
        apiKey: PM_API_KEY,
        apiSecret: PM_API_SECRET,
        apiPassphrase: PM_API_PASSPHRASE
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

app.get("/health", async (req, res) => {
  // We do NOT force-init here; /orders or /place will.
  res.json({
    ok: true,
    walletAddress: walletAddress || null,
    clientStatus: clobClient ? "ready" : clientInitPromise ? "initializing" : "not_initialized",
    clobHost: PM_CLOB_HOST,
    gammaHost: PM_GAMMA_HOST,
    signatureType: PM_SIGNATURE_TYPE,
    timestamp: new Date().toISOString()
  });
});

// List open orders (proves you're on the new build)
app.get("/orders", requireAuth, async (req, res) => {
  try {
    const client = await initClient();
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

    console.log(`[Worker] ${dryRun ? "[DRY-RUN] " : ""}PLACE ${normalizedSide} token=${String(tokenId).slice(0, 16)}... price=${price} size=${size}`);

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
  // Don't crash service if init fails at startup; endpoints will surface the error.
  initClient().catch((e) => console.error("[Worker] init on start failed:", e?.message || e));
});
