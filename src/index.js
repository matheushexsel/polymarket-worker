import express from "express";
import { Wallet } from "ethers"; // ethers v5
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { webcrypto } from "node:crypto";

const app = express();
app.use(express.json());

/* =======================
   GLOBAL WEBCRYPTO (Node 18)
   clob-client uses WebCrypto in some environments
======================= */
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

/* =======================
   ENV
======================= */
const WORKER_SECRET = process.env.WORKER_SECRET;

const PM_PRIVATE_KEY = process.env.PM_PRIVATE_KEY;

// For Polymarket account trading:
const PM_SIGNATURE_TYPE = Number(process.env.PM_SIGNATURE_TYPE ?? "2"); // you said 2
const PM_FUNDER_ADDRESS = process.env.PM_FUNDER_ADDRESS; // proxy wallet address

const PM_CLOB_HOST = process.env.PM_CLOB_HOST || "https://clob.polymarket.com";
const PORT = Number(process.env.PORT || 3000);
const CHAIN_ID = 137;

// Optional switches
const TRADING_ENABLED = (process.env.TRADING_ENABLED ?? "true") === "true";
const DEFAULT_TICK_SIZE = process.env.DEFAULT_TICK_SIZE || "0.01";
const DEFAULT_NEG_RISK = (process.env.DEFAULT_NEG_RISK ?? "false") === "true";

/* =======================
   VALIDATION
======================= */
if (!WORKER_SECRET) {
  console.error("Missing WORKER_SECRET");
  process.exit(1);
}
if (!PM_PRIVATE_KEY) {
  console.error("Missing PM_PRIVATE_KEY");
  process.exit(1);
}
if (Number.isNaN(PM_SIGNATURE_TYPE)) {
  console.error("PM_SIGNATURE_TYPE must be a number (0/1/2)");
  process.exit(1);
}
if (PM_SIGNATURE_TYPE === 2 && !PM_FUNDER_ADDRESS) {
  console.error("Missing PM_FUNDER_ADDRESS (proxy wallet) for SIGNATURE_TYPE=2");
  process.exit(1);
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
   - Step 1: init with signer
   - Step 2: createOrDeriveApiKey (USER creds)
   - Step 3: re-init with signature type + funder address
======================= */
let signer = null;
let signerAddress = null;

let userApiCreds = null;
let client = null;
let initPromise = null;

async function initClient() {
  if (client) return client;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log("[BOOT] version=acct-sigtype2-fok-v1");
      console.log(`[Worker] host=${PM_CLOB_HOST} chain=${CHAIN_ID} sigType=${PM_SIGNATURE_TYPE}`);

      signer = new Wallet(PM_PRIVATE_KEY);
      signerAddress = await signer.getAddress();
      console.log(`[Worker] signer=${signerAddress}`);

      // Step 1: init minimal
      const temp = new ClobClient(PM_CLOB_HOST, CHAIN_ID, signer);

      // Step 2: derive USER creds (this is the correct “User API” flow)
      console.log("[Worker] deriving user api creds (createOrDeriveApiKey) ...");
      userApiCreds = await temp.createOrDeriveApiKey();
      console.log(`[Worker] user apiKey=${String(userApiCreds.apiKey).slice(0, 8)}...`);

      // Step 3: funder address is required for Polymarket account modes
      const funder = PM_SIGNATURE_TYPE === 0 ? signerAddress : PM_FUNDER_ADDRESS;

      client = new ClobClient(
        PM_CLOB_HOST,
        CHAIN_ID,
        signer,
        userApiCreds,
        PM_SIGNATURE_TYPE,
        funder
      );

      console.log(`[Worker] client ready. funder=${funder}`);
      return client;
    } catch (e) {
      console.error("[Worker] init failed:", e?.message || e);
      initPromise = null;
      throw e;
    }
  })();

  return initPromise;
}

/* =======================
   HELPERS
======================= */
function clampPrice(p) {
  // must be strictly between 0 and 1 for clob-client validations
  if (p <= 0) return 0.01;
  if (p >= 1) return 0.99;
  return p;
}

function normalizeSide(side) {
  const s = String(side || "").toUpperCase();
  if (s !== "BUY" && s !== "SELL") return null;
  return s;
}

function normalizeOrderType(orderType) {
  const t = String(orderType || "GTC").toUpperCase();
  // Polymarket uses OrderType enum; common values: GTC, FOK
  if (t !== "GTC" && t !== "FOK") return null;
  return t;
}

/* =======================
   ROUTES
======================= */

// Use this to verify deployment
app.get("/version", (req, res) => {
  res.json({
    version: "acct-sigtype2-fok-v1",
    node: process.version,
    signer: signerAddress || null,
    sigType: PM_SIGNATURE_TYPE,
    funder: PM_FUNDER_ADDRESS || null,
    tradingEnabled: TRADING_ENABLED,
    timestamp: new Date().toISOString()
  });
});

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    clientStatus: client ? "ready" : initPromise ? "initializing" : "not_initialized",
    signer: signerAddress || null,
    sigType: PM_SIGNATURE_TYPE,
    funder: PM_FUNDER_ADDRESS || null,
    host: PM_CLOB_HOST,
    timestamp: new Date().toISOString()
  });
});

// List open orders
app.get("/orders", requireAuth, async (req, res) => {
  try {
    const c = await initClient();
    const orders = await c.getOpenOrders();
    res.json({ success: true, count: orders?.length || 0, orders });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// Position / balance for a token
app.get("/positions", requireAuth, async (req, res) => {
  try {
    const tokenId = req.query.tokenId;
    if (!tokenId) return res.status(400).json({ success: false, error: "missing_tokenId" });

    const c = await initClient();
    const bal = await c.getBalanceAllowance(tokenId);
    const shares = Number(bal?.balance || 0);

    res.json({ success: true, tokenId, shares, raw: bal });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// Place order: supports GTC + FOK
app.post("/place", requireAuth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const { tokenId, side, price, size, tickSize, negRisk, orderType } = req.body || {};
    if (!tokenId) return res.status(400).json({ success: false, error: "missing_tokenId" });

    const s = normalizeSide(side);
    if (!s) return res.status(400).json({ success: false, error: "side_must_be_BUY_or_SELL" });

    const t = normalizeOrderType(orderType);
    if (!t) return res.status(400).json({ success: false, error: "orderType_must_be_GTC_or_FOK" });

    if (typeof price !== "number" || typeof size !== "number") {
      return res.status(400).json({ success: false, error: "price_and_size_must_be_numbers" });
    }

    const px = clampPrice(price);
    if (size <= 0) return res.status(400).json({ success: false, error: "size_must_be_positive" });

    const ts = String(tickSize ?? DEFAULT_TICK_SIZE); // SDK wants string
    const nr = typeof negRisk === "boolean" ? negRisk : DEFAULT_NEG_RISK;

    console.log(
      `[Worker] ${dryRun ? "[DRYRUN] " : ""}${t} ${s} token=${String(tokenId).slice(0, 14)}... price=${px} size=${size} tickSize=${ts} negRisk=${nr}`
    );

    if (!TRADING_ENABLED) {
      return res.json({
        success: true,
        dryRun: true,
        orderId: null,
        message: "TRADING_ENABLED=false (simulated)",
        echoed: { tokenId, side: s, orderType: t, price: px, size, tickSize: ts, negRisk: nr }
      });
    }

    const c = await initClient();

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        orderId: null,
        message: "validated_only"
      });
    }

    const sideEnum = s === "BUY" ? Side.BUY : Side.SELL;
    const orderTypeEnum = t === "FOK" ? OrderType.FOK : OrderType.GTC;

    const resp = await c.createAndPostOrder(
      { tokenID: tokenId, price: px, size, side: sideEnum },
      { tickSize: ts, negRisk: nr },
      orderTypeEnum
    );

    const orderId = resp?.orderID || resp?.id || resp?.order_id || null;

    res.json({ success: true, dryRun: false, orderId, response: resp });
  } catch (e) {
    console.error("[Worker] /place error:", e?.message || e);
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// Cancel order
app.post("/cancel", requireAuth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, error: "missing_orderId" });

    console.log(`[Worker] ${dryRun ? "[DRYRUN] " : ""}cancel orderId=${orderId}`);

    if (!TRADING_ENABLED) {
      return res.json({
        success: true,
        dryRun: true,
        cancelled: false,
        message: "TRADING_ENABLED=false (simulated)"
      });
    }

    const c = await initClient();

    if (dryRun) {
      return res.json({ success: true, dryRun: true, cancelled: false, message: "validated_only" });
    }

    const result = await c.cancelOrder(orderId);
    res.json({ success: true, dryRun: false, cancelled: true, result });
  } catch (e) {
    console.error("[Worker] /cancel error:", e?.message || e);
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

/* =======================
   START
======================= */
app.listen(PORT, () => {
  console.log(`[Worker] listening on ${PORT}`);
  // do not crash on init; surface errors via endpoints
  initClient().catch((e) => console.error("[Worker] init on start failed:", e?.message || e));
});
