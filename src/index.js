// src/index.js
import express from "express";
import { webcrypto } from "node:crypto";

// ---- Node18 crypto.subtle polyfill (required by some SDK paths) ----
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { Wallet } from "ethers"; // ethers v5 (see package.json)
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

const VERSION = "scalper-mm-v5-maker";

// -------------------- ENV --------------------
const WORKER_SECRET = (process.env.WORKER_SECRET || "").trim();

const PM_PRIVATE_KEY = (process.env.PM_PRIVATE_KEY || "").trim();
const PM_CLOB_HOST = (process.env.PM_CLOB_HOST || "https://clob.polymarket.com").trim();
const PM_GAMMA_HOST = (process.env.PM_GAMMA_HOST || "https://gamma-api.polymarket.com").trim();

const PM_SIGNATURE_TYPE = Number(process.env.PM_SIGNATURE_TYPE || "2"); // 2 = GNOSIS_SAFE (Polymarket account via browser wallet)
const PM_FUNDER_ADDRESS = (process.env.PM_FUNDER_ADDRESS || process.env.FUNDER_ADDRESS || "").trim();

const RUNNER_ENABLED = (process.env.RUNNER_ENABLED || "0").trim() === "1";
const RUNNER_INTERVAL_MS = Math.max(2000, Number(process.env.RUNNER_INTERVAL_MS || "15000"));

// Optional pre-derived USER API creds (preferred to DERIVE automatically, but supported)
const PM_API_KEY = (process.env.PM_API_KEY || "").trim();
const PM_API_SECRET = (process.env.PM_API_SECRET || "").trim();
const PM_API_PASSPHRASE = (process.env.PM_API_PASSPHRASE || "").trim();

// Strategy gates (tune via env without redeploy)
const MIN_BID = Number(process.env.MIN_BID || "0.02");
const MAX_ASK = Number(process.env.MAX_ASK || "0.98");
const MAX_SPREAD_BPS = Number(process.env.MAX_SPREAD_BPS || "3500");
const MIN_EDGE_BPS = Number(process.env.MIN_EDGE_BPS || "80");

const MIN_ASK_DEPTH_USD = Number(process.env.MIN_ASK_DEPTH_USD || "10");
const MIN_BID_DEPTH_USD = Number(process.env.MIN_BID_DEPTH_USD || "10");
const ORDER_USD_PER_TRADE = Number(process.env.ORDER_USD_PER_TRADE || "3");

const MAX_OPEN_ORDERS_PER_TOKEN = Number(process.env.MAX_OPEN_ORDERS_PER_TOKEN || "2");

const TAKE_PROFIT_USD = Number(process.env.TAKE_PROFIT_USD || "0.02"); // $/share
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || "0.05");

// Maker mode controls
const MAKER_TICK_IMPROVE = Number(process.env.MAKER_TICK_IMPROVE || "1");
const MAKER_MAX_IMPROVE_BPS = Number(process.env.MAKER_MAX_IMPROVE_BPS || "50");
const REQUOTE_BPS = Number(process.env.REQUOTE_BPS || "30");

const PORT = Number(process.env.PORT || "3000");
const CHAIN_ID = 137; // Polygon mainnet

// -------------------- VALIDATION --------------------
if (!WORKER_SECRET) {
  console.error("[BOOT] Missing WORKER_SECRET");
  process.exit(1);
}
if (!PM_PRIVATE_KEY) {
  console.error("[BOOT] Missing PM_PRIVATE_KEY");
  process.exit(1);
}
if ((PM_SIGNATURE_TYPE === 1 || PM_SIGNATURE_TYPE === 2) && !PM_FUNDER_ADDRESS) {
  console.error("[BOOT] Missing PM_FUNDER_ADDRESS (required for signature type 1 or 2)");
  process.exit(1);
}

// -------------------- APP --------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${WORKER_SECRET}`) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  next();
}

function isDryRun(req) {
  const v = req.headers["x-dry-run"];
  return v === "1" || v === "true";
}

// -------------------- CLIENT INIT --------------------
let signer = null;
let signerAddress = null;

let clobClient = null;
let userApiCreds = null;
let initPromise = null;

function safePrefix(x, n = 8) {
  if (!x) return null;
  return `${String(x).slice(0, n)}…`;
}

// Helper: enforce strict numeric bounds
function clampPrice(p) {
  // Polymarket SDK expects strictly between 0 and 1
  if (p <= 0) return 0.01;
  if (p >= 1) return 0.99;
  return p;
}

async function initClob() {
  if (clobClient) return clobClient;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    console.log(`[BOOT] version=${VERSION}`);
    console.log(`[BOOT] node=${process.version}`);
    console.log(`[BOOT] clob=${PM_CLOB_HOST}`);
    console.log(`[BOOT] gamma=${PM_GAMMA_HOST}`);
    console.log(`[BOOT] signatureType=${PM_SIGNATURE_TYPE}`);
    console.log(`[BOOT] funder=${PM_FUNDER_ADDRESS ? PM_FUNDER_ADDRESS : "(none)"}`);

    signer = new Wallet(PM_PRIVATE_KEY);
    signerAddress = await signer.getAddress();
    console.log(`[BOOT] signer=${signerAddress}`);

    // Step 1: initial client (no creds)
    const baseClient = new ClobClient(PM_CLOB_HOST, CHAIN_ID, signer);

    // Step 2: USER creds
    // If you provided PM_API_* we use them; otherwise derive them.
    if (PM_API_KEY && PM_API_SECRET && PM_API_PASSPHRASE) {
      // NOTE: exact key names expected by clob-client are: apiKey, secret, passphrase
      userApiCreds = {
        apiKey: PM_API_KEY,
        secret: PM_API_SECRET,
        passphrase: PM_API_PASSPHRASE,
      };
      console.log(`[BOOT] using provided user api creds: key=${safePrefix(userApiCreds.apiKey)}`);
    } else {
      console.log("[BOOT] deriving user api creds via createOrDeriveApiKey()");
      userApiCreds = await baseClient.createOrDeriveApiKey();
      console.log(`[BOOT] derived user api creds: key=${safePrefix(userApiCreds.apiKey)}`);
      // DO NOT log secret/passphrase
    }

    // Step 3+4: re-init fully authenticated client with signatureType + funder
    const funder =
      PM_SIGNATURE_TYPE === 0 ? signerAddress : PM_FUNDER_ADDRESS;

    clobClient = new ClobClient(
      PM_CLOB_HOST,
      CHAIN_ID,
      signer,
      userApiCreds,
      PM_SIGNATURE_TYPE,
      funder
    );

    console.log("[BOOT] clob client ready");
    return clobClient;
  })();

  return initPromise;
}

// -------------------- ORDERBOOK HELPERS --------------------
function bps(spread) {
  return Math.round(spread * 10000);
}

function parseTop(book) {
  // clob orderbook formats can vary; normalize
  // Expecting something like { bids: [{price, size}], asks: [{price,size}] }
  const bids = book?.bids || [];
  const asks = book?.asks || [];

  const bestBid = bids.length ? Number(bids[0].price) : 0;
  const bestAsk = asks.length ? Number(asks[0].price) : 1;

  const bidSize = bids.length ? Number(bids[0].size) : 0;
  const askSize = asks.length ? Number(asks[0].size) : 0;

  return { bestBid, bestAsk, bidSize, askSize };
}

// -------------------- ROUTES --------------------
app.get("/version", (req, res) => {
  res.json({
    version: VERSION,
    node: process.version,
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    node: process.version,
    signer: signerAddress || null,
    signatureType: PM_SIGNATURE_TYPE,
    funder: PM_SIGNATURE_TYPE === 0 ? signerAddress : PM_FUNDER_ADDRESS,
    clientStatus: clobClient ? "ready" : initPromise ? "initializing" : "not_initialized",
    clobHost: PM_CLOB_HOST,
    gammaHost: PM_GAMMA_HOST,
    timestamp: new Date().toISOString(),
  });
});

// GET open orders
app.get("/orders", requireAuth, async (req, res) => {
  try {
    const client = await initClob();
    const orders = await client.getOpenOrders();
    res.json({ success: true, count: orders?.length || 0, orders });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// POST place order
// Body: { tokenId, side, price, size, tickSize, negRisk, orderType? }
// orderType: "GTC" (default) or "FOK"
app.post("/place", requireAuth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const {
      tokenId,
      side,
      price,
      size,
      tickSize,
      negRisk = false,
      orderType = "GTC",
    } = req.body || {};

    if (!tokenId) return res.status(400).json({ success: false, error: "missing_tokenId" });
    if (!side) return res.status(400).json({ success: false, error: "missing_side" });
    if (typeof price !== "number") return res.status(400).json({ success: false, error: "price_must_be_number" });
    if (typeof size !== "number") return res.status(400).json({ success: false, error: "size_must_be_number" });
    if (!tickSize || typeof tickSize !== "string") return res.status(400).json({ success: false, error: "tickSize_required_as_string" });

    const s = String(side).toUpperCase();
    if (s !== "BUY" && s !== "SELL") return res.status(400).json({ success: false, error: "side_must_be_BUY_or_SELL" });

    const p = clampPrice(price);
    if (!(p > 0 && p < 1)) return res.status(400).json({ success: false, error: "price_must_be_between_0_and_1" });
    if (size <= 0) return res.status(400).json({ success: false, error: "size_must_be_positive" });

    const ot = String(orderType).toUpperCase();
    const otEnum = ot === "FOK" ? OrderType.FOK : OrderType.GTC;

    console.log(`[PLACE] ${dryRun ? "[DRY] " : ""}${ot} ${s} token=${String(tokenId).slice(0, 18)}… price=${p} size=${size} tick=${tickSize}`);

    const client = await initClob();

    if (dryRun) {
      return res.json({ success: true, dryRun: true, message: "validated_only" });
    }

    const resp = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: p,
        size,
        side: s === "BUY" ? Side.BUY : Side.SELL,
      },
      { tickSize, negRisk },
      otEnum
    );

    const orderId = resp?.orderID || resp?.id || resp?.order_id || null;

    res.json({ success: true, dryRun: false, orderId, response: resp });
  } catch (e) {
    console.error("[/place] error:", e?.message || e);
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// POST cancel order
app.post("/cancel", requireAuth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, error: "missing_orderId" });

    console.log(`[CANCEL] ${dryRun ? "[DRY] " : ""}orderId=${orderId}`);

    const client = await initClob();

    if (dryRun) return res.json({ success: true, dryRun: true, cancelled: false, message: "validated_only" });

    const resp = await client.cancelOrder(orderId);
    res.json({ success: true, dryRun: false, cancelled: true, response: resp });
  } catch (e) {
    console.error("[/cancel] error:", e?.message || e);
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// -------------------- RUNNER LOOP (optional) --------------------
// This runner is intentionally conservative about DB assumptions.
// It can still run “stat-only” and you can wire “targets” later.
// What matters right now: it proves v5 is deployed and running at 15s cadence.

function nowIso() {
  return new Date().toISOString();
}

async function runnerCycle() {
  const stats = {
    version: VERSION,
    at: nowIso(),
    tokens_checked: 0,
    gtc_buys: 0,
    gtc_sells: 0,
    fok_entries: 0,
    fok_exits: 0,
    skipped: [], // array of {reason, tokenIdPrefix, ...}
    errors: 0,
  };

  try {
    const client = await initClob();

    // Placeholder “targets”: set WATCH_TOKEN_IDS env as comma-separated token IDs if you want to test live quickly
    const watch = (process.env.WATCH_TOKEN_IDS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    if (!watch.length) {
      stats.skipped.push({ reason: "no_watch_tokens_configured" });
      console.log("[RUN]", JSON.stringify(stats));
      return;
    }

    for (const tokenId of watch) {
      stats.tokens_checked++;

      // Pull book
      const book = await client.getOrderBook(tokenId);
      const { bestBid, bestAsk, bidSize, askSize } = parseTop(book);

      const spread = bestAsk - bestBid;
      const spreadBps = bps(spread);

      // basic gates
      if (bestBid < MIN_BID) {
        stats.skipped.push({ reason: "bid_below_min", token: safePrefix(tokenId, 10), bestBid, bestAsk });
        continue;
      }
      if (bestAsk > MAX_ASK) {
        stats.skipped.push({ reason: "ask_above_max", token: safePrefix(tokenId, 10), bestBid, bestAsk });
        continue;
      }
      if (spreadBps > MAX_SPREAD_BPS) {
        stats.skipped.push({ reason: "spread_too_wide", token: safePrefix(tokenId, 10), spreadBps, bestBid, bestAsk });
        continue;
      }
      if (spreadBps < MIN_EDGE_BPS) {
        stats.skipped.push({ reason: "spread_too_tight_no_edge", token: safePrefix(tokenId, 10), spreadBps });
        continue;
      }

      // depth approx (very rough): top size * price (you may refine to actual USDC rules)
      const bidUsd = bidSize * bestBid;
      const askUsd = askSize * bestAsk;
      if (bidUsd < MIN_BID_DEPTH_USD || askUsd < MIN_ASK_DEPTH_USD) {
        stats.skipped.push({ reason: "insufficient_top_depth", token: safePrefix(tokenId, 10), bidUsd, askUsd });
        continue;
      }

      // “Maker quote” example: place a GTC buy improving bid by 1 tick (you will want cancel/replace logic later)
      // We need tickSize + negRisk; for now fetch market metadata
      const market = await client.getMarket(tokenId);
      const tickSize = String(market?.tickSize || "0.01");
      const negRisk = !!market?.negRisk;

      // improve bid slightly but cap improvement bps
      let quoteBid = bestBid + Number(tickSize) * MAKER_TICK_IMPROVE;
      const improveBps = bps((quoteBid - bestBid) / Math.max(bestBid, 1e-6));
      if (improveBps > MAKER_MAX_IMPROVE_BPS) quoteBid = bestBid; // don’t over-improve

      // Order sizing: $ amount / price
      const size = Math.max(1, Number((ORDER_USD_PER_TRADE / Math.max(quoteBid, 0.01)).toFixed(2)));

      // Limit how many open orders we create per token (simple check)
      const openOrders = await client.getOpenOrders();
      const openForToken = (openOrders || []).filter((o) => o?.tokenID === tokenId || o?.tokenId === tokenId);
      if (openForToken.length >= MAX_OPEN_ORDERS_PER_TOKEN) {
        stats.skipped.push({ reason: "max_open_orders_per_token", token: safePrefix(tokenId, 10), count: openForToken.length });
        continue;
      }

      // Place maker buy
      const resp = await client.createAndPostOrder(
        { tokenID: tokenId, price: clampPrice(quoteBid), size, side: Side.BUY },
        { tickSize, negRisk },
        OrderType.GTC
      );

      if (resp?.orderID) stats.gtc_buys++;
    }

    console.log("[RUN]", JSON.stringify(stats));
  } catch (e) {
    stats.errors++;
    console.error("[RUN] cycle error:", e?.message || e);
    console.log("[RUN]", JSON.stringify(stats));
  }
}

let runnerTimer = null;

function startRunner() {
  if (!RUNNER_ENABLED) return;

  console.log(`[RUNNER] enabled=1 interval_ms=${RUNNER_INTERVAL_MS}`);
  const tick = async () => {
    await runnerCycle();
  };

  // start immediately then interval
  tick().catch(() => {});
  runnerTimer = setInterval(() => tick().catch(() => {}), RUNNER_INTERVAL_MS);
}

// -------------------- START --------------------
app.listen(PORT, () => {
  console.log(`[BOOT] http listening on :${PORT}`);
  // init in background (don’t crash if auth fails; endpoints will surface)
  initClob().catch((e) => console.error("[BOOT] init failed:", e?.message || e));
  startRunner();
});
