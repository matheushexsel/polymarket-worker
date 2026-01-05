import express from "express";
import { webcrypto } from "node:crypto";
import { Wallet } from "ethers"; // ethers v5
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

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

const PM_SIGNATURE_TYPE = Number(process.env.PM_SIGNATURE_TYPE ?? 2);
const PM_FUNDER_ADDRESS =
  process.env.PM_FUNDER_ADDRESS || "0xEa50b96ea3F25BD138d9A8A04B19570058e84929";

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
   CLIENT INIT
======================= */
let signer = null;
let signerAddress = null;
let clobClient = null;
let clientInitPromise = null;

async function initClient() {
  if (clobClient) return clobClient;
  if (clientInitPromise) return clientInitPromise;

  clientInitPromise = (async () => {
    signer = new Wallet(PM_PRIVATE_KEY);
    signerAddress = await signer.getAddress();

    const tmp = new ClobClient(PM_CLOB_HOST, CHAIN_ID, signer);
    const userApiCreds = await tmp.createOrDeriveApiKey();

    clobClient = new ClobClient(
      PM_CLOB_HOST,
      CHAIN_ID,
      signer,
      userApiCreds,
      PM_SIGNATURE_TYPE,
      PM_FUNDER_ADDRESS
    );

    return clobClient;
  })();

  return clientInitPromise;
}

/* =======================
   ROUTES
======================= */
app.get("/version", (req, res) => {
  res.json({
    version: "fok-ticksize-v1",
    node: process.version,
    signer: signerAddress || null,
    funder: PM_FUNDER_ADDRESS,
    signatureType: PM_SIGNATURE_TYPE,
    clobHost: PM_CLOB_HOST,
    gammaHost: PM_GAMMA_HOST,
    timestamp: new Date().toISOString()
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    clientStatus: clobClient ? "ready" : clientInitPromise ? "initializing" : "not_initialized",
    signer: signerAddress || null,
    funder: PM_FUNDER_ADDRESS,
    signatureType: PM_SIGNATURE_TYPE,
    clobHost: PM_CLOB_HOST,
    gammaHost: PM_GAMMA_HOST,
    timestamp: new Date().toISOString()
  });
});

app.get("/orders", requireAuth, async (req, res) => {
  try {
    const client = await initClient();
    const openOrders = await client.getOpenOrders();
    return res.json({ success: true, count: openOrders?.length || 0, orders: openOrders });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

/**
 * POST /place
 * Body: { tokenId, side, price, size, tickSize, negRisk, orderType? }
 * orderType: "FOK" | "IOC" | "GTC" (default FOK)
 */
app.post("/place", requireAuth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const {
      tokenId,
      side,
      price,
      size,
      tickSize,
      negRisk,
      orderType = "FOK"
    } = req.body || {};

    if (!tokenId || !side || typeof price !== "number" || typeof size !== "number") {
      return res.status(400).json({ success: false, error: "invalid_body" });
    }

    const normalizedSide = String(side).toUpperCase();
    if (normalizedSide !== "BUY" && normalizedSide !== "SELL") {
      return res.status(400).json({ success: false, error: "side_must_be_BUY_or_SELL" });
    }

    if (!tickSize || typeof tickSize !== "string") {
      return res.status(400).json({ success: false, error: "tickSize_required_as_string" });
    }
    if (typeof negRisk !== "boolean") {
      return res.status(400).json({ success: false, error: "negRisk_required_as_boolean" });
    }

    // Safety clamp: SDK requires 0 < price < 1
    const tick = Number(tickSize);
    const clampedPrice = Math.max(tick, Math.min(price, 0.999));

    if (!(clampedPrice > 0 && clampedPrice < 1)) {
      return res.status(400).json({ success: false, error: "price_must_be_between_0_and_1" });
    }
    if (!(size > 0)) {
      return res.status(400).json({ success: false, error: "size_must_be_positive" });
    }

    const client = await initClient();

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        orderId: null,
        message: "validated_only",
        params: { tokenId, side: normalizedSide, price: clampedPrice, size, tickSize, negRisk, orderType }
      });
    }

    const sideEnum = normalizedSide === "BUY" ? Side.BUY : Side.SELL;

    const ot = String(orderType).toUpperCase();
    const orderTypeEnum =
      ot === "IOC" ? OrderType.IOC :
      ot === "GTC" ? OrderType.GTC :
      OrderType.FOK;

    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price: clampedPrice, size, side: sideEnum },
      { tickSize, negRisk },
      orderTypeEnum
    );

    const orderId = resp?.orderID || resp?.id || resp?.order_id || null;

    return res.json({ success: true, dryRun: false, orderId, response: resp });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
      details: err?.response?.data || null
    });
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
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`[Worker] listening on ${PORT}`);
  initClient().catch((e) => console.error("[Worker] init failed:", e?.message || e));
});
