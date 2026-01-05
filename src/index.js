import express from "express";
import { webcrypto } from "node:crypto";
import { Wallet } from "ethers"; // MUST be ethers v5.x
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

// Ensure crypto.subtle exists in Node 18 (Railway often runs Node 18)
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const app = express();
app.use(express.json());

/* =======================
   ENV
======================= */
const WORKER_SECRET = process.env.WORKER_SECRET;

const PM_PRIVATE_KEY = process.env.PM_PRIVATE_KEY;
const PM_CLOB_HOST = process.env.PM_CLOB_HOST || "https://clob.polymarket.com";
const PM_GAMMA_HOST = process.env.PM_GAMMA_HOST || "https://gamma-api.polymarket.com";

// You said: trade through Polymarket.com account (browser wallet connection)
const PM_SIGNATURE_TYPE = Number(process.env.PM_SIGNATURE_TYPE || 2); // MUST be 2 for GNOSIS_SAFE (browser wallet)
const PM_FUNDER_ADDRESS = process.env.PM_FUNDER_ADDRESS; // Your proxy wallet address

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
if (!PM_FUNDER_ADDRESS) {
  console.error("Missing PM_FUNDER_ADDRESS (proxy wallet address)");
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
   IMPORTANT: For Polymarket.com proxy mode, DO NOT paste API keys.
   You MUST derive user creds via createOrDeriveApiKey() using your private key.
======================= */
let signer = null;
let signerAddress = null;
let client = null;
let initPromise = null;

async function initClient() {
  if (client) return client;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log("[BOOT] version=pm-proxy-v1");
      console.log(`[Worker] Host=${PM_CLOB_HOST} ChainId=${CHAIN_ID}`);
      console.log(`[Worker] SignatureType=${PM_SIGNATURE_TYPE} Funder=${PM_FUNDER_ADDRESS}`);

      // ethers v5 wallet signer
      signer = new Wallet(PM_PRIVATE_KEY);
      signerAddress = await signer.getAddress();
      console.log(`[Worker] Signer address=${signerAddress}`);

      // Step 1: temp client
      const temp = new ClobClient(PM_CLOB_HOST, CHAIN_ID, signer);

      // Step 2: derive USER creds (this is the key fix)
      const userApiCreds = await temp.createOrDeriveApiKey();
      console.log(`[Worker] Derived user API key=${String(userApiCreds?.apiKey || "").slice(0, 8)}...`);

      // Step 3/4: full authenticated client in proxy mode
      client = new ClobClient(
        PM_CLOB_HOST,
        CHAIN_ID,
        signer,
        userApiCreds,
        PM_SIGNATURE_TYPE,
        PM_FUNDER_ADDRESS
      );

      console.log("[Worker] CLOB client ready");
      return client;
    } catch (err) {
      console.error("[Worker] initClient failed:", err?.message || err);
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/* =======================
   ROUTES
======================= */

// Version endpoint so you can confirm Railway deployed THIS code
app.get("/version", (req, res) => {
  res.json({
    version: "pm-proxy-v1",
    node: process.version,
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    version: "pm-proxy-v1",
    signerAddress: signerAddress || null,
    clientStatus: client ? "ready" : initPromise ? "initializing" : "not_initialized",
    clobHost: PM_CLOB_HOST,
    gammaHost: PM_GAMMA_HOST,
    signatureType: PM_SIGNATURE_TYPE,
    funderAddress: PM_FUNDER_ADDRESS,
    timestamp: new Date().toISOString(),
  });
});

app.get("/orders", requireAuth, async (req, res) => {
  try {
    const c = await initClient();
    const openOrders = await c.getOpenOrders();
    return res.json({ success: true, count: openOrders?.length || 0, orders: openOrders });
  } catch (err) {
    console.error("[Worker] /orders error:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// Place limit order
// Body: { tokenId, side, price, size }
// Optional: X-Dry-Run: 1
app.post("/place", requireAuth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const { tokenId, side, price, size } = req.body || {};

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

    const c = await initClient();

    if (dryRun) {
      return res.json({ success: true, dryRun: true, orderId: null, message: "validated_only" });
    }

    const sideEnum = normalizedSide === "BUY" ? Side.BUY : Side.SELL;

    // IMPORTANT: get market to use correct tickSize/negRisk
    const market = await c.getMarket(tokenId);

    const resp = await c.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: sideEnum,
      },
      {
        tickSize: market?.tickSize,
        negRisk: market?.negRisk,
      },
      OrderType.GTC
    );

    return res.json({
      success: true,
      dryRun: false,
      orderId: resp?.orderID || null,
      status: resp?.status || null,
      response: resp,
    });
  } catch (err) {
    console.error("[Worker] /place error:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post("/cancel", requireAuth, async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, error: "missing_orderId" });

    console.log(`[Worker] CANCEL orderId=${orderId}`);

    const c = await initClient();
    const result = await c.cancelOrder(orderId);

    return res.json({ success: true, cancelled: true, result });
  } catch (err) {
    console.error("[Worker] /cancel error:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.get("/positions", requireAuth, async (req, res) => {
  try {
    const tokenId = req.query.tokenId;
    if (!tokenId) return res.status(400).json({ success: false, error: "missing_tokenId" });

    const c = await initClient();
    const bal = await c.getBalanceAllowance(tokenId);
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
});
