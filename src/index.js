// v6-seed-target-2026-01-05
// Polymarket Micro MM Worker (Targeted slug / token mode + Seeding)

// NOTE: This is a strategy shift:
// - Instead of "wait for tight books", it can SEED empty books (0.01/0.99)
// - Instead of scanning only first 50 markets, it can TARGET a slug or tokenIds directly

import express from "express";
import cors from "cors";
import { webcrypto } from "node:crypto";
import { ethers } from "ethers";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

// Ensure crypto.subtle exists on Node 18
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// =============================================================================
// CONFIG
// =============================================================================

const PORT = Number(process.env.PORT || 3000);

const PM_PRIVATE_KEY = process.env.PM_PRIVATE_KEY?.trim();
const PM_CLOB_HOST = process.env.PM_CLOB_HOST?.trim() || "https://clob.polymarket.com";
const PM_GAMMA_HOST = process.env.PM_GAMMA_HOST?.trim() || "https://gamma-api.polymarket.com";
const WORKER_SECRET = process.env.WORKER_SECRET?.trim();

const PM_SIGNATURE_TYPE = Number(process.env.PM_SIGNATURE_TYPE || "2");
const PM_FUNDER_ADDRESS =
  process.env.PM_FUNDER_ADDRESS?.trim() ||
  process.env.FUNDER_ADDRESS?.trim() ||
  "0xEa50b96ea3F25BD138d9A8A04B19570058e84929";

const CHAIN_ID = 137;

// Runner config
const RUNNER_ENABLED = process.env.RUNNER_ENABLED === "1";
const RUNNER_INTERVAL_MS = Number(process.env.RUNNER_INTERVAL_MS || "15000");
const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

const BOOK_STALE_MS = Number(process.env.BOOK_STALE_MS || "5000");

// Strategy toggles
const TARGET_MODE_ENABLED = process.env.TARGET_MODE_ENABLED === "1"; // if 1, prefer target slug/token ids
const SEED_ENABLED = process.env.SEED_ENABLED === "1"; // if 1, seed empty books

// Seeding parameters
const SEED_FAIR_PRICE = Number(process.env.SEED_FAIR_PRICE || "0.5"); // MVP: constant fair
const SEED_HALF_SPREAD_BPS = Number(process.env.SEED_HALF_SPREAD_BPS || "200"); // 200 = 2% around fair
const MAX_ORDERS_PER_SIDE = Number(process.env.MAX_ORDERS_PER_SIDE || "1"); // 1 bid + 1 ask per token

// Risk / trade sizing
const CONFIG = {
  // These "liquidity gates" are still used in NON-SEED paths
  MIN_BID: Number(process.env.MIN_BID || "0.02"),
  MAX_ASK: Number(process.env.MAX_ASK || "0.98"),
  MAX_SPREAD_BPS: Number(process.env.MAX_SPREAD_BPS || "3500"),

  MIN_ASK_DEPTH_USD: Number(process.env.MIN_ASK_DEPTH_USD || "10"),
  MIN_BID_DEPTH_USD: Number(process.env.MIN_BID_DEPTH_USD || "10"),
  MIN_TOP_SUM_DEPTH_USD: Number(process.env.MIN_TOP_SUM_DEPTH_USD || "25"),

  FOK_MIN_DEPTH_USD: Number(process.env.FOK_MIN_DEPTH_USD || "15"),

  MAKER_TICK_IMPROVE: Number(process.env.MAKER_TICK_IMPROVE || "1"),
  MAKER_MAX_IMPROVE_BPS: Number(process.env.MAKER_MAX_IMPROVE_BPS || "50"),

  MIN_EDGE_BPS: Number(process.env.MIN_EDGE_BPS || "80"),

  ORDER_USD_PER_TRADE: Number(process.env.ORDER_USD_PER_TRADE || "2"), // you asked for ~$2 clips
  MAX_POSITION_USD_PER_TOKEN: Number(process.env.MAX_POSITION_USD_PER_TOKEN || "25"),
  MAX_TOTAL_POSITION_USD: Number(process.env.MAX_TOTAL_POSITION_USD || "100"),
  MAX_OPEN_ORDERS_PER_TOKEN: Number(process.env.MAX_OPEN_ORDERS_PER_TOKEN || "2"), // legacy cap; seeding uses MAX_ORDERS_PER_SIDE
  MIN_ORDER_SIZE: Number(process.env.MIN_ORDER_SIZE || "1"), // IMPORTANT: set default to 1 for micro

  STALE_MS: Number(process.env.STALE_MS || "45000"),
  REQUOTE_BPS: Number(process.env.REQUOTE_BPS || "30"),

  TAKE_PROFIT_BPS: Number(process.env.TAKE_PROFIT_BPS || "100"),
  TAKE_PROFIT_USD: Number(process.env.TAKE_PROFIT_USD || "0.02"),
  MIN_PROFIT_USD: Number(process.env.MIN_PROFIT_USD || "0.05"),
  STOP_LOSS_ENABLED: process.env.STOP_LOSS_ENABLED === "1",
  STOP_LOSS_USD: Number(process.env.STOP_LOSS_USD || "0.05"),

  CLOSEOUT_SECONDS: Number(process.env.CLOSEOUT_SECONDS || "60"),
};

const VERSION = "scalper-mm-v6-seed-target";

// =============================================================================
// VALIDATION
// =============================================================================

if (!PM_PRIVATE_KEY) {
  console.error("[Worker] FATAL: PM_PRIVATE_KEY is required");
  process.exit(1);
}
if (!WORKER_SECRET) {
  console.error("[Worker] FATAL: WORKER_SECRET is required");
  process.exit(1);
}
if ((PM_SIGNATURE_TYPE === 1 || PM_SIGNATURE_TYPE === 2) && !PM_FUNDER_ADDRESS) {
  console.error("[Worker] FATAL: PM_FUNDER_ADDRESS required for signature type 1 or 2");
  process.exit(1);
}

let bootWalletAddress = null;
try {
  const bootWallet = new ethers.Wallet(PM_PRIVATE_KEY);
  bootWalletAddress = bootWallet.address;
} catch (e) {
  console.error("[Worker] FATAL: Invalid PM_PRIVATE_KEY:", e.message);
  process.exit(1);
}

// =============================================================================
// BOOT LOGS (PROOF)
// =============================================================================

console.log("[Worker] ========================================");
console.log(`[Worker] Version: ${VERSION}`);
console.log(`[Worker] Wallet: ${bootWalletAddress}`);
console.log(`[Worker] Funder: ${PM_FUNDER_ADDRESS}`);
console.log(`[Worker] Signature Type: ${PM_SIGNATURE_TYPE}`);
console.log(`[Worker] CLOB: ${PM_CLOB_HOST}`);
console.log(`[Worker] Gamma: ${PM_GAMMA_HOST}`);
console.log(`[Worker] Runner: ${RUNNER_ENABLED ? `ON (${RUNNER_INTERVAL_MS}ms)` : "OFF"}`);
console.log(`[Worker] TARGET_MODE_ENABLED: ${TARGET_MODE_ENABLED ? "ON" : "OFF"}`);
console.log(`[Worker] SEED_ENABLED: ${SEED_ENABLED ? "ON" : "OFF"}`);
console.log(`[Worker] SEED_FAIR_PRICE: ${SEED_FAIR_PRICE}`);
console.log(`[Worker] SEED_HALF_SPREAD_BPS: ${SEED_HALF_SPREAD_BPS}`);
console.log(`[Worker] MAX_ORDERS_PER_SIDE: ${MAX_ORDERS_PER_SIDE}`);
console.log(`[Env] TARGET_SLUG_BTC: ${process.env.TARGET_SLUG_BTC || ""}`);
console.log(`[Env] TARGET_SLUG_ETH: ${process.env.TARGET_SLUG_ETH || ""}`);
console.log(`[Env] TARGET_SLUG_SOL: ${process.env.TARGET_SLUG_SOL || ""}`);
console.log(`[Env] TARGET_YES_TOKEN_ID_BTC: ${process.env.TARGET_YES_TOKEN_ID_BTC || ""}`);
console.log(`[Env] TARGET_NO_TOKEN_ID_BTC: ${process.env.TARGET_NO_TOKEN_ID_BTC || ""}`);
console.log("[Worker] ========================================");

// =============================================================================
// CLOB CLIENT
// =============================================================================

let clobClient = null;
let clientInitPromise = null;
let walletAddress = null;

async function initClient() {
  if (clobClient) return clobClient;
  if (clientInitPromise) return clientInitPromise;

  clientInitPromise = (async () => {
    console.log("[Client] Initializing...");
    const wallet = new ethers.Wallet(PM_PRIVATE_KEY);
    walletAddress = await wallet.getAddress();

    const tempClient = new ClobClient(PM_CLOB_HOST, CHAIN_ID, wallet);
    const derivedCreds = await tempClient.createOrDeriveApiKey();

    clobClient = new ClobClient(
      PM_CLOB_HOST,
      CHAIN_ID,
      wallet,
      derivedCreds,
      PM_SIGNATURE_TYPE,
      PM_SIGNATURE_TYPE === 0 ? walletAddress : PM_FUNDER_ADDRESS
    );

    console.log("[Client] Ready");
    return clobClient;
  })();

  return clientInitPromise;
}

// =============================================================================
// SUPABASE HELPERS (REST)
// =============================================================================

async function supabaseFetch(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }

  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 250)}`);

  return text ? JSON.parse(text) : null;
}

async function getEnabledAssets() {
  return (await supabaseFetch("/pm_assets?enabled=eq.true&select=asset")) || [];
}

async function getPosition(asset, slug, tokenId) {
  const rows =
    (await supabaseFetch(
      `/pm_positions?asset=eq.${asset}&slug=eq.${slug}&token_id=eq.${encodeURIComponent(tokenId)}&select=*`
    )) || [];
  return rows[0] || null;
}

async function getAllPositions() {
  return (await supabaseFetch("/pm_positions?select=*")) || [];
}

async function upsertPosition(pos) {
  return supabaseFetch("/pm_positions", {
    method: "POST",
    body: JSON.stringify(pos),
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
}

async function getActiveOrdersForToken(asset, slug, tokenId) {
  return (
    (await supabaseFetch(
      `/pm_orders?asset=eq.${asset}&slug=eq.${slug}&token_id=eq.${encodeURIComponent(tokenId)}&status=eq.ACTIVE&select=*`
    )) || []
  );
}

async function insertOrder(order) {
  return supabaseFetch("/pm_orders", {
    method: "POST",
    body: JSON.stringify({
      ...order,
      placed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

async function updateOrderStatus(orderId, status, error = null) {
  const patch = { status, updated_at: new Date().toISOString() };
  if (error) patch.last_error = error;

  return supabaseFetch(`/pm_orders?order_id=eq.${orderId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

async function insertRun(run) {
  return supabaseFetch("/pm_runs", {
    method: "POST",
    body: JSON.stringify(run),
  });
}

// =============================================================================
// TARGET MARKET RESOLUTION
// =============================================================================

// You can resolve markets in 2 ways:
//
// (A) BEST: set token IDs directly (no Gamma dependency)
//   TARGET_YES_TOKEN_ID_BTC, TARGET_NO_TOKEN_ID_BTC
//   TARGET_YES_TOKEN_ID_ETH, TARGET_NO_TOKEN_ID_ETH
//   TARGET_YES_TOKEN_ID_SOL, TARGET_NO_TOKEN_ID_SOL
//
// (B) set slug + use Gamma scan with large limit and exact slug match
//   TARGET_SLUG_BTC, TARGET_SLUG_ETH, TARGET_SLUG_SOL

function envKeyFor(asset, base) {
  return `${base}_${String(asset).toUpperCase()}`;
}

function getTargetConfig(asset) {
  const yesTokenId = process.env[envKeyFor(asset, "TARGET_YES_TOKEN_ID")]?.trim();
  const noTokenId = process.env[envKeyFor(asset, "TARGET_NO_TOKEN_ID")]?.trim();
  const slug = process.env[envKeyFor(asset, "TARGET_SLUG")]?.trim();

  return {
    yesTokenId: yesTokenId || null,
    noTokenId: noTokenId || null,
    slug: slug || null,
  };
}

async function resolveMarketFromGammaBySlugExact(slug) {
  // We avoid relying on undocumented slug endpoints.
  // Instead we scan a large page and exact-match by slug.
  const url = `${PM_GAMMA_HOST}/markets?closed=false&active=true&_limit=500`;
  const resp = await fetch(url);
  const status = resp.status;

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Gamma not ok status=${status} body=${t.slice(0, 200)}`);
  }

  const all = await resp.json();
  if (!Array.isArray(all)) throw new Error("Gamma markets response not an array");

  const match = all.find((m) => String(m.slug || "").toLowerCase() === String(slug).toLowerCase());
  if (!match) return null;

  const endDateStr = match.endDate || match.end_date_iso || match.endDateIso;
  const endMs = endDateStr ? new Date(endDateStr).getTime() : 0;

  let tokenIds = [];
  if (match.clobTokenIds) tokenIds = typeof match.clobTokenIds === "string" ? JSON.parse(match.clobTokenIds) : match.clobTokenIds;

  if (!Array.isArray(tokenIds) || tokenIds.length < 2) return null;

  return {
    slug: match.slug,
    yesTokenId: String(tokenIds[0]),
    noTokenId: String(tokenIds[1]),
    negRisk: Boolean(match.negRisk),
    tickSize: parseFloat(match.orderPriceMinTickSize) || 0.01,
    endDateMs: endMs,
  };
}

async function resolveActiveMarket(asset) {
  const target = getTargetConfig(asset);

  // If target token IDs exist, skip Gamma entirely.
  if (TARGET_MODE_ENABLED && target.yesTokenId && target.noTokenId) {
    return {
      slug: target.slug || `TARGET_${asset}`,
      yesTokenId: target.yesTokenId,
      noTokenId: target.noTokenId,
      negRisk: false,
      tickSize: 0.01,
      endDateMs: Date.now() + 10 * 60 * 1000, // placeholder; not needed for trading loop
    };
  }

  // If target slug exists, resolve via Gamma (exact match).
  if (TARGET_MODE_ENABLED && target.slug) {
    console.log(`[Discovery] ${asset} mode=TARGET_SLUG slug=${target.slug}`);
    const m = await resolveMarketFromGammaBySlugExact(target.slug);
    if (!m) return null;
    return m;
  }

  // Fallback: your old dynamic scan (but with better logs + larger limit)
  console.log(`[Discovery] ${asset} mode=SCAN`);
  const url = `${PM_GAMMA_HOST}/markets?closed=false&active=true&_limit=500`;
  const resp = await fetch(url);
  console.log(`[Discovery] ${asset} scan status=${resp.status}`);

  if (!resp.ok) return null;

  const all = await resp.json();
  if (!Array.isArray(all)) return null;

  const now = Date.now();
  const assetLower = asset.toLowerCase();

  const out = [];
  for (const m of all) {
    const question = String(m.question || "").toLowerCase();
    const slug = String(m.slug || "").toLowerCase();
    const desc = String(m.description || "").toLowerCase();

    const isUpDown =
      (question.includes(assetLower) || slug.includes(assetLower)) &&
      (question.includes("up or down") || slug.includes("updown"));
    const is15m =
      slug.includes("15m") ||
      question.includes("15 minute") ||
      question.includes("15-minute") ||
      desc.includes("15 minute");

    if (!isUpDown || !is15m) continue;

    const endDateStr = m.endDate || m.end_date_iso || m.endDateIso;
    if (!endDateStr) continue;

    const endMs = new Date(endDateStr).getTime();
    if (!endMs || Number.isNaN(endMs)) continue;
    if (endMs <= now) continue;

    let tokenIds = [];
    if (m.clobTokenIds) tokenIds = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    if (!Array.isArray(tokenIds) || tokenIds.length < 2) continue;

    const secsToEnd = Math.floor((endMs - now) / 1000);
    if (secsToEnd <= 30) continue;

    out.push({
      slug: m.slug,
      yesTokenId: String(tokenIds[0]),
      noTokenId: String(tokenIds[1]),
      negRisk: Boolean(m.negRisk),
      tickSize: parseFloat(m.orderPriceMinTickSize) || 0.01,
      endDateMs: endMs,
      secsToEnd,
    });
  }

  out.sort((a, b) => (a.endDateMs || 0) - (b.endDateMs || 0));
  return out[0] || null;
}

// =============================================================================
// ORDERBOOK
// =============================================================================

async function fetchOrderBook(tokenId) {
  const t0 = Date.now();
  const resp = await fetch(`${PM_CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!resp.ok) return null;

  const data = await resp.json();
  const fetchMs = Date.now() - t0;

  if (fetchMs > BOOK_STALE_MS) return { stale: true, reason: "fetch_slow", fetchMs };

  const bids = Array.isArray(data.bids) ? data.bids : [];
  const asks = Array.isArray(data.asks) ? data.asks : [];

  const bestBid = bids.length ? Number(bids[0].price) : 0;
  const bestAsk = asks.length ? Number(asks[0].price) : 1;

  const bidSize = bids.length ? Number(bids[0].size) : 0;
  const askSize = asks.length ? Number(asks[0].size) : 0;

  const bidDepthUsd = bidSize * bestBid;
  const askDepthUsd = askSize * bestAsk;

  return {
    stale: false,
    bestBid,
    bestAsk,
    bidSize,
    askSize,
    bidDepthUsd,
    askDepthUsd,
    topSumDepthUsd: bidDepthUsd + askDepthUsd,
    tickSize: Number(data.tick_size) || 0.01,
  };
}

// =============================================================================
// ORDER HELPERS
// =============================================================================

function roundToTick(price, tick) {
  const t = Number(tick) || 0.01;
  return Math.round(price / t) * t;
}

function clamp(price, min, max) {
  return Math.max(min, Math.min(max, price));
}

async function placeOrder(client, { tokenId, side, price, size, orderType, tickSize, negRisk }) {
  const sideEnum = String(side).toUpperCase() === "SELL" ? Side.SELL : Side.BUY;
  const otEnum = String(orderType).toUpperCase() === "FOK" ? OrderType.FOK : OrderType.GTC;

  const p = clamp(Number(price), 0.01, 0.99);
  const s = Number(size);

  const resp = await client.createAndPostOrder(
    { tokenID: String(tokenId), price: p, size: s, side: sideEnum },
    { tickSize: String(tickSize || "0.01"), negRisk: Boolean(negRisk) },
    otEnum
  );

  const orderId = resp?.orderID || resp?.order_id || resp?.id || null;
  return { orderId, resp };
}

async function cancelOrder(client, orderId) {
  await client.cancelOrder(orderId);
  return true;
}

// =============================================================================
// BOOK STATE + ELIGIBILITY
// =============================================================================

function classifyBook(book) {
  const empty = (book.bestBid <= 0.01 && book.bestAsk >= 0.99) || book.bestBid <= 0 || book.bestAsk >= 1.0;
  const thin = !empty && (book.topSumDepthUsd < CONFIG.MIN_TOP_SUM_DEPTH_USD || book.bidDepthUsd < 1 || book.askDepthUsd < 1);
  if (empty) return "EMPTY";
  if (thin) return "THIN";
  return "REAL";
}

function spreadBpsMid(bestBid, bestAsk) {
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  return mid > 0 ? Math.round((spread / mid) * 10000) : 99999;
}

function checkEligibilityNonSeed(book, side, mode = "MAKER") {
  const { bestBid, bestAsk, bidDepthUsd, askDepthUsd, topSumDepthUsd } = book;
  const spreadBps = spreadBpsMid(bestBid, bestAsk);

  if (bestBid <= 0.01 && bestAsk >= 0.99) return { eligible: false, reason: "DEAD_BOOK" };
  if (!bestAsk || bestAsk >= 1.0) return { eligible: false, reason: "NO_ASK" };
  if (!bestBid || bestBid <= 0.0) return { eligible: false, reason: "NO_BID" };
  if (bestBid < CONFIG.MIN_BID) return { eligible: false, reason: "MIN_BID" };
  if (bestAsk > CONFIG.MAX_ASK) return { eligible: false, reason: "MAX_ASK" };
  if (spreadBps > CONFIG.MAX_SPREAD_BPS) return { eligible: false, reason: "SPREAD" };
  if (topSumDepthUsd < CONFIG.MIN_TOP_SUM_DEPTH_USD) return { eligible: false, reason: "SUM_DEPTH" };

  if (mode === "FOK") {
    if (bidDepthUsd < CONFIG.FOK_MIN_DEPTH_USD) return { eligible: false, reason: "FOK_BID_DEPTH" };
    if (askDepthUsd < CONFIG.FOK_MIN_DEPTH_USD) return { eligible: false, reason: "FOK_ASK_DEPTH" };
  }

  if (String(side).toUpperCase() === "BUY") {
    if (askDepthUsd < CONFIG.MIN_ASK_DEPTH_USD) return { eligible: false, reason: "ASK_DEPTH" };
  } else {
    if (bidDepthUsd < CONFIG.MIN_BID_DEPTH_USD) return { eligible: false, reason: "BID_DEPTH" };
  }

  return { eligible: true, reason: "OK" };
}

// =============================================================================
// RUNNER STATE
// =============================================================================

let runnerInterval = null;
let lastRunTime = null;
let lastRunError = null;
let runCount = 0;

// =============================================================================
// MAIN CYCLE
// =============================================================================

async function runCycle() {
  const runId = `run_${Date.now()}`;
  const startTime = Date.now();
  runCount++;

  console.log(`\n[Cycle ${runCount}] ===== ${runId} =====`);

  const stats = {
    assets: [],
    tokens_checked: 0,
    orders_placed: 0,
    orders_cancelled: 0,
    skipped: [],
    errors: [],
  };

  try {
    const client = await initClient();

    const assets = await getEnabledAssets();
    if (!assets?.length) {
      console.log("[Cycle] No enabled assets");
      lastRunTime = new Date();
      return;
    }

    const allPositions = await getAllPositions();
    const totalPositionUsd = allPositions.reduce(
      (sum, p) => sum + Number(p.shares || 0) * Number(p.avg_cost || 0),
      0
    );

    const nowMs = Date.now();

    for (const { asset } of assets) {
      const A = String(asset).toUpperCase();
      console.log(`\n[${A}] Resolving market...`);

      let market = null;
      try {
        market = await resolveActiveMarket(asset);
      } catch (e) {
        console.error(`[${A}] Discovery ERROR:`, e?.message || e);
        stats.skipped.push({ asset, reason: "discovery_error" });
        continue;
      }

      if (!market) {
        console.log(`[${A}] No market resolved (check TARGET vars or Gamma)`);
        stats.skipped.push({ asset, reason: "no_active_market" });
        continue;
      }

      const slug = market.slug;
      const endMs = market.endDateMs || (Date.now() + 10 * 60 * 1000);
      const secsLeft = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
      const isCloseout = secsLeft <= CONFIG.CLOSEOUT_SECONDS;

      console.log(`  [${A}] Using: ${slug} | secsLeft=${secsLeft} | closeout=${isCloseout}`);
      console.log(`  [${A}] YES=${market.yesTokenId} NO=${market.noTokenId}`);

      stats.assets.push(asset);

      for (const tok of [
        { tokenId: market.yesTokenId, outcome: "YES" },
        { tokenId: market.noTokenId, outcome: "NO" },
      ]) {
        stats.tokens_checked++;

        const book = await fetchOrderBook(tok.tokenId);
        if (!book) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "no_book" });
          continue;
        }
        if (book.stale) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: `stale_book_${book.reason}` });
          continue;
        }

        const state = classifyBook(book);
        const sbps = spreadBpsMid(book.bestBid, book.bestAsk);

        console.log(
          `  [${A} ${tok.outcome}] state=${state} bid=${book.bestBid} ask=${book.bestAsk} spread=${sbps}bps sum=$${book.topSumDepthUsd.toFixed(2)}`
        );

        // Cancel stale orders in DB (best-effort)
        let dbOrders = await getActiveOrdersForToken(asset, slug, tok.tokenId);

        for (const o of dbOrders) {
          const placedAt = o.placed_at ? new Date(o.placed_at).getTime() : 0;
          const age = placedAt ? nowMs - placedAt : 0;
          if (age > CONFIG.STALE_MS && o.order_id) {
            try {
              await cancelOrder(client, o.order_id);
              await updateOrderStatus(o.order_id, "CANCELLED");
              stats.orders_cancelled++;
            } catch {
              // ignore cancel failure
            }
          }
        }

        dbOrders = await getActiveOrdersForToken(asset, slug, tok.tokenId);
        const activeBuys = dbOrders.filter((o) => o.side === "BUY");
        const activeSells = dbOrders.filter((o) => o.side === "SELL");

        // RISK caps
        const pos = await getPosition(asset, slug, tok.tokenId);
        const shares = Number(pos?.shares || 0);
        const avgCost = Number(pos?.avg_cost || 0);
        const positionUsd = shares * avgCost;

        if (positionUsd >= CONFIG.MAX_POSITION_USD_PER_TOKEN) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "position_full" });
          continue;
        }
        if (totalPositionUsd >= CONFIG.MAX_TOTAL_POSITION_USD) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "total_position_full" });
          continue;
        }
        if (isCloseout) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "closeout" });
          continue;
        }

        // =============================================================================
        // SEED MODE: place BOTH sides even if EMPTY
        // =============================================================================
        if (SEED_ENABLED && (state === "EMPTY" || state === "THIN")) {
          const tick = book.tickSize || market.tickSize || 0.01;
          const fair = clamp(SEED_FAIR_PRICE, 0.05, 0.95);

          // Half-spread as price offset
          const half = Math.max(tick, fair * (SEED_HALF_SPREAD_BPS / 10000));

          const bidPx = clamp(roundToTick(fair - half, tick), 0.01, 0.99);
          const askPx = clamp(roundToTick(fair + half, tick), 0.01, 0.99);

          // Size: aim $2 notional, minimum 1 share
          const bidSize = Math.max(CONFIG.MIN_ORDER_SIZE, Math.floor(CONFIG.ORDER_USD_PER_TRADE / bidPx));
          const askSize = Math.max(CONFIG.MIN_ORDER_SIZE, Math.floor(CONFIG.ORDER_USD_PER_TRADE / askPx));

          // Ensure we keep <= MAX_ORDERS_PER_SIDE
          const needBid = activeBuys.length < MAX_ORDERS_PER_SIDE;
          const needAsk = activeSells.length < MAX_ORDERS_PER_SIDE;

          if (!needBid && !needAsk) {
            stats.skipped.push({ asset, outcome: tok.outcome, reason: "seed_max_orders" });
            continue;
          }

          console.log(
            `    [SEED] fair=${fair} tick=${tick} bid=${bidPx}x${bidSize} ask=${askPx}x${askSize} needBid=${needBid} needAsk=${needAsk}`
          );

          if (needBid) {
            const { orderId } = await placeOrder(client, {
              tokenId: tok.tokenId,
              side: "BUY",
              price: bidPx,
              size: bidSize,
              orderType: "GTC",
              tickSize: tick,
              negRisk: false,
            });

            await insertOrder({
              asset,
              slug,
              token_id: tok.tokenId,
              outcome: tok.outcome,
              side: "BUY",
              order_type: "GTC",
              price: bidPx,
              size: bidSize,
              tick_size: String(tick),
              neg_risk: false,
              status: orderId ? "ACTIVE" : "FAILED",
              order_id: orderId,
              client_order_id: `${asset}_${tok.outcome}_SEED_BID_${nowMs}`,
              last_error: orderId ? null : "Seed bid failed",
              window_start_epoch: null,
            });

            if (orderId) stats.orders_placed++;
          }

          if (needAsk) {
            const { orderId } = await placeOrder(client, {
              tokenId: tok.tokenId,
              side: "SELL",
              price: askPx,
              size: askSize,
              orderType: "GTC",
              tickSize: tick,
              negRisk: false,
            });

            await insertOrder({
              asset,
              slug,
              token_id: tok.tokenId,
              outcome: tok.outcome,
              side: "SELL",
              order_type: "GTC",
              price: askPx,
              size: askSize,
              tick_size: String(tick),
              neg_risk: false,
              status: orderId ? "ACTIVE" : "FAILED",
              order_id: orderId,
              client_order_id: `${asset}_${tok.outcome}_SEED_ASK_${nowMs}`,
              last_error: orderId ? null : "Seed ask failed",
              window_start_epoch: null,
            });

            if (orderId) stats.orders_placed++;
          }

          // ensure position row exists (so later logic can update)
          if (!pos) {
            await upsertPosition({
              asset,
              slug,
              token_id: tok.tokenId,
              outcome: tok.outcome,
              shares: 0,
              avg_cost: 0,
              updated_at: new Date().toISOString(),
            });
          }

          continue; // done for this token
        }

        // =============================================================================
        // NON-SEED fallback (your older gating logic, simplified)
        // =============================================================================
        const buyOk = checkEligibilityNonSeed(book, "BUY", "MAKER");
        if (!buyOk.eligible) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: `nonseed_block_${buyOk.reason}` });
          continue;
        }

        // Place a small maker buy (legacy behavior)
        if (activeBuys.length >= CONFIG.MAX_OPEN_ORDERS_PER_TOKEN) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "max_orders" });
          continue;
        }

        const tick = book.tickSize || market.tickSize || 0.01;
        const improve = Math.min(CONFIG.MAKER_TICK_IMPROVE * tick, (book.bestBid * CONFIG.MAKER_MAX_IMPROVE_BPS) / 10000);
        let target = roundToTick(book.bestBid + improve, tick);
        target = clamp(target, 0.01, 0.99);

        const buySize = Math.max(CONFIG.MIN_ORDER_SIZE, Math.floor(CONFIG.ORDER_USD_PER_TRADE / target));

        const { orderId } = await placeOrder(client, {
          tokenId: tok.tokenId,
          side: "BUY",
          price: target,
          size: buySize,
          orderType: "GTC",
          tickSize: tick,
          negRisk: false,
        });

        await insertOrder({
          asset,
          slug,
          token_id: tok.tokenId,
          outcome: tok.outcome,
          side: "BUY",
          order_type: "GTC",
          price: target,
          size: buySize,
          tick_size: String(tick),
          neg_risk: false,
          status: orderId ? "ACTIVE" : "FAILED",
          order_id: orderId,
          client_order_id: `${asset}_${tok.outcome}_BUY_${nowMs}`,
          last_error: orderId ? null : "Failed",
          window_start_epoch: null,
        });

        if (orderId) stats.orders_placed++;
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `\n[Cycle] Done in ${duration}ms: placed=${stats.orders_placed} cancelled=${stats.orders_cancelled} skipped=${stats.skipped.length}`
    );

    await insertRun({
      run_id: runId,
      started_at: new Date(startTime).toISOString(),
      ended_at: new Date().toISOString(),
      summary: stats,
      errors: stats.errors,
    });

    lastRunTime = new Date();
    lastRunError = null;
  } catch (err) {
    console.error("[Cycle] Error:", err);
    lastRunError = err?.message || String(err);
  }
}

// =============================================================================
// RUNNER CONTROL
// =============================================================================

function startRunner() {
  if (!RUNNER_ENABLED) return;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[Runner] FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
    return;
  }

  console.log(`[Runner] Starting (${RUNNER_INTERVAL_MS}ms interval)...`);
  runCycle().catch(() => {});
  runnerInterval = setInterval(() => runCycle().catch(() => {}), RUNNER_INTERVAL_MS);
}

// =============================================================================
// API ENDPOINTS
// =============================================================================

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Missing Authorization" });
  if (authHeader.slice(7) !== WORKER_SECRET) return res.status(403).json({ error: "Invalid token" });
  next();
}

app.get("/version", (req, res) => {
  res.json({
    version: VERSION,
    runnerEnabled: RUNNER_ENABLED,
    runnerIntervalMs: RUNNER_INTERVAL_MS,
    targetModeEnabled: TARGET_MODE_ENABLED,
    seedEnabled: SEED_ENABLED,
    seedFairPrice: SEED_FAIR_PRICE,
    seedHalfSpreadBps: SEED_HALF_SPREAD_BPS,
    maxOrdersPerSide: MAX_ORDERS_PER_SIDE,
    config: CONFIG,
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: !lastRunError,
    version: VERSION,
    clientReady: !!clobClient,
    wallet: walletAddress || bootWalletAddress,
    runnerEnabled: RUNNER_ENABLED,
    runnerActive: !!runnerInterval,
    runCount,
    lastRunTime: lastRunTime?.toISOString() || null,
    lastRunError,
  });
});

app.get("/orders", authMiddleware, async (req, res) => {
  try {
    const client = await initClient();
    const orders = await client.getOpenOrders();
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post("/cancel", authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, error: "Missing orderId" });

    const client = await initClient();
    await cancelOrder(client, orderId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// =============================================================================
// STARTUP
// =============================================================================

app.listen(PORT, () => {
  console.log(`[Worker] Listening on port ${PORT}`);
  startRunner();
});
