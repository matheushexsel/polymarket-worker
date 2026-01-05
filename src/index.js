// v5-maker-2026-01-05-deploy-1 (fixed)
// Polymarket Scalper Worker - Market-Making + Risk System (Runner + Manual Endpoints)

import express from "express";
import cors from "cors";
import { webcrypto } from "node:crypto";

// Ensure crypto.subtle exists on Node 18
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { ethers } from "ethers"; // MUST be ethers v5.8.0 in package.json
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = Number(process.env.PORT || 3000);

const PM_PRIVATE_KEY = process.env.PM_PRIVATE_KEY?.trim();
const PM_CLOB_HOST = process.env.PM_CLOB_HOST?.trim() || "https://clob.polymarket.com";
const PM_GAMMA_HOST = process.env.PM_GAMMA_HOST?.trim() || "https://gamma-api.polymarket.com";
const WORKER_SECRET = process.env.WORKER_SECRET?.trim();

const PM_SIGNATURE_TYPE = Number(process.env.PM_SIGNATURE_TYPE || "2"); // 2 = GNOSIS_SAFE (Polymarket account via browser wallet)
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

// Book staleness (ms)
const BOOK_STALE_MS = Number(process.env.BOOK_STALE_MS || "5000");

// Tiered liquidity gates
const CONFIG = {
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

  ORDER_USD_PER_TRADE: Number(process.env.ORDER_USD_PER_TRADE || "3"),
  MAX_POSITION_USD_PER_TOKEN: Number(process.env.MAX_POSITION_USD_PER_TOKEN || "25"),
  MAX_TOTAL_POSITION_USD: Number(process.env.MAX_TOTAL_POSITION_USD || "100"),
  MAX_OPEN_ORDERS_PER_TOKEN: Number(process.env.MAX_OPEN_ORDERS_PER_TOKEN || "2"),
  MIN_ORDER_SIZE: Number(process.env.MIN_ORDER_SIZE || "3"),

  STALE_MS: Number(process.env.STALE_MS || "45000"),
  REQUOTE_BPS: Number(process.env.REQUOTE_BPS || "30"),

  TAKE_PROFIT_BPS: Number(process.env.TAKE_PROFIT_BPS || "100"),
  TAKE_PROFIT_USD: Number(process.env.TAKE_PROFIT_USD || "0.02"),
  MIN_PROFIT_USD: Number(process.env.MIN_PROFIT_USD || "0.05"),
  STOP_LOSS_ENABLED: process.env.STOP_LOSS_ENABLED === "1",
  STOP_LOSS_USD: Number(process.env.STOP_LOSS_USD || "0.05"),

  CLOSEOUT_SECONDS: Number(process.env.CLOSEOUT_SECONDS || "60"),
};

const VERSION = "scalper-mm-v5-maker";

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
// LOGGING
// =============================================================================

console.log("[Worker] ========================================");
console.log(`[Worker] Version: ${VERSION}`);
console.log(`[Worker] Wallet: ${bootWalletAddress}`);
console.log(`[Worker] Funder: ${PM_FUNDER_ADDRESS}`);
console.log(`[Worker] Signature Type: ${PM_SIGNATURE_TYPE}`);
console.log(`[Worker] CLOB: ${PM_CLOB_HOST}`);
console.log(`[Worker] Gamma: ${PM_GAMMA_HOST}`);
console.log(`[Worker] Runner: ${RUNNER_ENABLED ? `ON (${RUNNER_INTERVAL_MS}ms)` : "OFF"}`);
console.log("[Worker] ========================================");

// =============================================================================
// CLOB CLIENT (ethers v5, createOrDeriveApiKey)
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

    // temp client for derivation
    const tempClient = new ClobClient(PM_CLOB_HOST, CHAIN_ID, wallet);

    const derivedCreds = await tempClient.createOrDeriveApiKey();

    // full client
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
// MARKET DISCOVERY (DYNAMIC)
// =============================================================================

async function discoverActiveMarkets(asset) {
  try {
    const url = `${PM_GAMMA_HOST}/markets?closed=false&active=true&_limit=50`;
    const resp = await fetch(url);
    if (!resp.ok) return [];

    const all = await resp.json();
    if (!Array.isArray(all)) return [];

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

    out.sort((a, b) => a.endDateMs - b.endDateMs);
    return out;
  } catch {
    return [];
  }
}

// =============================================================================
// ORDERBOOK (FRESH FETCH + STALENESS GUARD)
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
// ORDER HELPERS (CORRECT SDK CALLS)
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
// ELIGIBILITY + PROFIT CHECKS
// =============================================================================

function checkEligibility(book, side, mode = "MAKER") {
  const { bestBid, bestAsk, bidDepthUsd, askDepthUsd, topSumDepthUsd } = book;
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadBps = mid > 0 ? Math.round((spread / mid) * 10000) : 99999;

  const base = {
    bid: bestBid,
    ask: bestAsk,
    spreadBps,
    bidDepthUsd: Math.round(bidDepthUsd * 100) / 100,
    askDepthUsd: Math.round(askDepthUsd * 100) / 100,
    topSumDepthUsd: Math.round(topSumDepthUsd * 100) / 100,
    side,
    mode,
  };

  if (bestBid <= 0.01 && bestAsk >= 0.99) return { eligible: false, reason: "DEAD_BOOK", gate: "0.01/0.99", ...base };
  if (!bestAsk || bestAsk >= 1.0) return { eligible: false, reason: "NO_ASK", gate: `ask=${bestAsk}`, ...base };
  if (!bestBid || bestBid <= 0.0) return { eligible: false, reason: "NO_BID", gate: `bid=${bestBid}`, ...base };
  if (bestBid < CONFIG.MIN_BID) return { eligible: false, reason: "MIN_BID", gate: `bid=${bestBid} < ${CONFIG.MIN_BID}`, ...base };
  if (bestAsk > CONFIG.MAX_ASK) return { eligible: false, reason: "MAX_ASK", gate: `ask=${bestAsk} > ${CONFIG.MAX_ASK}`, ...base };
  if (spreadBps > CONFIG.MAX_SPREAD_BPS) return { eligible: false, reason: "SPREAD", gate: `spreadBps=${spreadBps}`, ...base };
  if (topSumDepthUsd < CONFIG.MIN_TOP_SUM_DEPTH_USD)
    return { eligible: false, reason: "SUM_DEPTH", gate: `sum=$${topSumDepthUsd.toFixed(2)} < $${CONFIG.MIN_TOP_SUM_DEPTH_USD}`, ...base };

  if (mode === "FOK") {
    if (bidDepthUsd < CONFIG.FOK_MIN_DEPTH_USD)
      return { eligible: false, reason: "FOK_BID_DEPTH", gate: `bidDepth=$${bidDepthUsd.toFixed(2)} < $${CONFIG.FOK_MIN_DEPTH_USD}`, ...base };
    if (askDepthUsd < CONFIG.FOK_MIN_DEPTH_USD)
      return { eligible: false, reason: "FOK_ASK_DEPTH", gate: `askDepth=$${askDepthUsd.toFixed(2)} < $${CONFIG.FOK_MIN_DEPTH_USD}`, ...base };
  }

  if (String(side).toUpperCase() === "BUY") {
    if (askDepthUsd < CONFIG.MIN_ASK_DEPTH_USD)
      return { eligible: false, reason: "ASK_DEPTH", gate: `askDepth=$${askDepthUsd.toFixed(2)} < $${CONFIG.MIN_ASK_DEPTH_USD}`, ...base };
  } else {
    if (bidDepthUsd < CONFIG.MIN_BID_DEPTH_USD)
      return { eligible: false, reason: "BID_DEPTH", gate: `bidDepth=$${bidDepthUsd.toFixed(2)} < $${CONFIG.MIN_BID_DEPTH_USD}`, ...base };
  }

  return { eligible: true, reason: "ELIGIBLE", ...base };
}

function checkProfitExit(book, avgCost, shares) {
  const { bestBid, bestAsk, bidDepthUsd } = book;
  const mid = (bestBid + bestAsk) / 2;

  const profitPerShare = mid - avgCost;
  const profitBps = avgCost > 0 ? Math.round((profitPerShare / avgCost) * 10000) : 0;
  const totalProfitUsd = profitPerShare * shares;

  const meetsBps = profitBps >= CONFIG.TAKE_PROFIT_BPS;
  const meetsPerShare = profitPerShare >= CONFIG.TAKE_PROFIT_USD;
  const meetsTotal = totalProfitUsd >= CONFIG.MIN_PROFIT_USD;

  const canFokExit = bidDepthUsd >= CONFIG.FOK_MIN_DEPTH_USD && bestBid >= avgCost + CONFIG.TAKE_PROFIT_USD;

  return {
    profitPerShare,
    profitBps,
    totalProfitUsd,
    canFokExit,
    shouldExit: (meetsBps || meetsPerShare) && meetsTotal && canFokExit,
  };
}

// =============================================================================
// RUNNER STATE
// =============================================================================

let runnerInterval = null;
let lastRunTime = null;
let lastRunError = null;
let runCount = 0;

// =============================================================================
// RUNNER: MAIN CYCLE
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
    gtc_buys: 0,
    gtc_sells: 0,
    fok_exits: 0,
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
    const totalPositionUsd = allPositions.reduce((sum, p) => sum + (Number(p.shares || 0) * Number(p.avg_cost || 0)), 0);

    const nowMs = Date.now();

    for (const { asset } of assets) {
      console.log(`\n[${String(asset).toUpperCase()}] Discovering active markets...`);

      const activeMarkets = await discoverActiveMarkets(asset);
      if (!activeMarkets.length) {
        stats.skipped.push({ asset, reason: "no_active_market" });
        continue;
      }

      const market = activeMarkets[0];
      const slug = market.slug;
      const windowEndEpoch = Math.floor(market.endDateMs / 1000);
      const windowStartEpoch = windowEndEpoch - 900;
      const secsLeft = market.secsToEnd;
      const isCloseout = secsLeft <= CONFIG.CLOSEOUT_SECONDS;

      console.log(`  [${asset}] Using: ${slug} | ${secsLeft}s left | closeout=${isCloseout}`);

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

        const { bestBid, bestAsk, bidDepthUsd, askDepthUsd, topSumDepthUsd, tickSize } = book;
        const mid = (bestBid + bestAsk) / 2;
        const spreadBps = mid > 0 ? Math.round(((bestAsk - bestBid) / mid) * 10000) : 99999;

        console.log(`  [${tok.outcome}] bid=${bestBid}($${bidDepthUsd.toFixed(0)}) ask=${bestAsk}($${askDepthUsd.toFixed(0)}) spread=${spreadBps}bps sum=$${topSumDepthUsd.toFixed(0)}`);

        const pos = await getPosition(asset, slug, tok.tokenId);
        const shares = Number(pos?.shares || 0);
        const avgCost = Number(pos?.avg_cost || 0);
        const positionUsd = shares * avgCost;

        let dbOrders = await getActiveOrdersForToken(asset, slug, tok.tokenId);

        // cancel stale
        for (const o of dbOrders) {
          const age = nowMs - new Date(o.placed_at).getTime();
          if (age > CONFIG.STALE_MS && o.order_id) {
            try {
              await cancelOrder(client, o.order_id);
              await updateOrderStatus(o.order_id, "CANCELLED");
              stats.orders_cancelled++;
            } catch (e) {
              // ignore cancel failure
            }
          }
        }

        dbOrders = await getActiveOrdersForToken(asset, slug, tok.tokenId);
        const activeBuys = dbOrders.filter((o) => o.side === "BUY");
        const activeSells = dbOrders.filter((o) => o.side === "SELL");

        // ===== SELL PATH if inventory =====
        if (shares > 0 && avgCost > 0) {
          const profit = checkProfitExit(book, avgCost, shares);
          console.log(`    POS: ${shares}@${avgCost.toFixed(4)} mid=${mid.toFixed(4)} pnl=${profit.profitBps}bps $${profit.totalProfitUsd.toFixed(4)}`);

          // closeout: FOK exit
          if (isCloseout) {
            const fokOk = checkEligibility(book, "SELL", "FOK");
            if (fokOk.eligible) {
              const px = clamp(roundToTick(bestBid, tickSize), 0.01, 0.99);
              const { orderId } = await placeOrder(client, {
                tokenId: tok.tokenId,
                side: "SELL",
                price: px,
                size: shares,
                orderType: "FOK",
                tickSize,
                negRisk: false,
              });

              await insertOrder({
                asset,
                slug,
                token_id: tok.tokenId,
                outcome: tok.outcome,
                side: "SELL",
                order_type: "FOK",
                price: px,
                size: shares,
                tick_size: String(tickSize),
                neg_risk: false,
                status: orderId ? "FILLED" : "FAILED",
                order_id: orderId,
                client_order_id: `${asset}_${tok.outcome}_CLOSE_${nowMs}`,
                last_error: orderId ? null : "FOK rejected",
                window_start_epoch: windowStartEpoch,
              });

              if (orderId) {
                stats.orders_placed++;
                stats.fok_exits++;
                await upsertPosition({
                  asset,
                  slug,
                  token_id: tok.tokenId,
                  outcome: tok.outcome,
                  shares: 0,
                  avg_cost: 0,
                  last_action_at: new Date().toISOString(),
                  last_sell_price: px,
                  updated_at: new Date().toISOString(),
                });
                continue;
              }
            }
          }

          // profit: FOK exit
          if (profit.shouldExit) {
            const fokOk = checkEligibility(book, "SELL", "FOK");
            if (fokOk.eligible) {
              const px = clamp(roundToTick(bestBid, tickSize), 0.01, 0.99);
              const { orderId } = await placeOrder(client, {
                tokenId: tok.tokenId,
                side: "SELL",
                price: px,
                size: shares,
                orderType: "FOK",
                tickSize,
                negRisk: false,
              });

              await insertOrder({
                asset,
                slug,
                token_id: tok.tokenId,
                outcome: tok.outcome,
                side: "SELL",
                order_type: "FOK",
                price: px,
                size: shares,
                tick_size: String(tickSize),
                neg_risk: false,
                status: orderId ? "FILLED" : "FAILED",
                order_id: orderId,
                client_order_id: `${asset}_${tok.outcome}_PROFIT_${nowMs}`,
                last_error: orderId ? null : "FOK rejected",
                window_start_epoch: windowStartEpoch,
              });

              if (orderId) {
                stats.orders_placed++;
                stats.fok_exits++;
                continue;
              }
            }
          }

          // maker sell
          const sellOk = checkEligibility(book, "SELL", "MAKER");
          if (!sellOk.eligible) {
            stats.skipped.push({ asset, outcome: tok.outcome, side: "SELL", ...sellOk });
            continue;
          }

          if (activeSells.length >= CONFIG.MAX_OPEN_ORDERS_PER_TOKEN) continue;

          const minSell = avgCost + CONFIG.TAKE_PROFIT_USD;
          const improve = Math.min(CONFIG.MAKER_TICK_IMPROVE * tickSize, (bestAsk * CONFIG.MAKER_MAX_IMPROVE_BPS) / 10000);
          let target = roundToTick(bestAsk - improve, tickSize);
          target = Math.max(target, minSell);
          target = clamp(target, 0.01, 0.99);

          const sellSize = Math.min(shares, Math.max(CONFIG.MIN_ORDER_SIZE, Math.floor(CONFIG.ORDER_USD_PER_TRADE / target)));

          const { orderId } = await placeOrder(client, {
            tokenId: tok.tokenId,
            side: "SELL",
            price: target,
            size: sellSize,
            orderType: "GTC",
            tickSize,
            negRisk: false,
          });

          await insertOrder({
            asset,
            slug,
            token_id: tok.tokenId,
            outcome: tok.outcome,
            side: "SELL",
            order_type: "GTC",
            price: target,
            size: sellSize,
            tick_size: String(tickSize),
            neg_risk: false,
            status: orderId ? "ACTIVE" : "FAILED",
            order_id: orderId,
            client_order_id: `${asset}_${tok.outcome}_SELL_${nowMs}`,
            last_error: orderId ? null : "Failed",
            window_start_epoch: windowStartEpoch,
          });

          if (orderId) {
            stats.orders_placed++;
            stats.gtc_sells++;
          }

          continue;
        }

        // ===== BUY PATH if no inventory =====
        const buyOk = checkEligibility(book, "BUY", "MAKER");
        if (!buyOk.eligible) {
          stats.skipped.push({ asset, outcome: tok.outcome, side: "BUY", ...buyOk });
          continue;
        }

        if (positionUsd >= CONFIG.MAX_POSITION_USD_PER_TOKEN) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "position_full" });
          continue;
        }
        if (totalPositionUsd >= CONFIG.MAX_TOTAL_POSITION_USD) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "total_position_full" });
          continue;
        }
        if (activeBuys.length >= CONFIG.MAX_OPEN_ORDERS_PER_TOKEN) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "max_orders" });
          continue;
        }
        if (isCloseout) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "closeout" });
          continue;
        }

        if (spreadBps < CONFIG.MIN_EDGE_BPS) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "no_edge", spreadBps });
          continue;
        }

        const improve = Math.min(CONFIG.MAKER_TICK_IMPROVE * tickSize, (bestBid * CONFIG.MAKER_MAX_IMPROVE_BPS) / 10000);
        let target = roundToTick(bestBid + improve, tickSize);
        target = clamp(target, 0.01, 0.99);

        const potentialSell = bestAsk - (CONFIG.MAKER_TICK_IMPROVE * tickSize);
        const potentialProfit = potentialSell - target;
        if (potentialProfit < CONFIG.TAKE_PROFIT_USD) {
          stats.skipped.push({ asset, outcome: tok.outcome, reason: "no_profit_edge" });
          continue;
        }

        const remainingCapacity = Math.min(
          CONFIG.MAX_POSITION_USD_PER_TOKEN - positionUsd,
          CONFIG.MAX_TOTAL_POSITION_USD - totalPositionUsd
        );
        const orderUsd = Math.min(CONFIG.ORDER_USD_PER_TRADE, remainingCapacity);
        const buySize = Math.max(CONFIG.MIN_ORDER_SIZE, Math.floor(orderUsd / target));

        const { orderId } = await placeOrder(client, {
          tokenId: tok.tokenId,
          side: "BUY",
          price: target,
          size: buySize,
          orderType: "GTC",
          tickSize,
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
          tick_size: String(tickSize),
          neg_risk: false,
          status: orderId ? "ACTIVE" : "FAILED",
          order_id: orderId,
          client_order_id: `${asset}_${tok.outcome}_BUY_${nowMs}`,
          last_error: orderId ? null : "Failed",
          window_start_epoch: windowStartEpoch,
        });

        if (orderId) {
          stats.orders_placed++;
          stats.gtc_buys++;
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
        }
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `\n[Cycle] Done in ${duration}ms: placed=${stats.orders_placed} (buys=${stats.gtc_buys} sells=${stats.gtc_sells} exits=${stats.fok_exits}) cancelled=${stats.orders_cancelled} skipped=${stats.skipped.length}`
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
    wallet: bootWalletAddress,
    funder: PM_FUNDER_ADDRESS,
    signatureType: PM_SIGNATURE_TYPE,
    clobHost: PM_CLOB_HOST,
    runnerEnabled: RUNNER_ENABLED,
    runnerIntervalMs: RUNNER_INTERVAL_MS,
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
    marketDiscovery: "DYNAMIC",
    bookStalenessMs: BOOK_STALE_MS,
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

app.get("/positions", authMiddleware, async (req, res) => {
  try {
    const positions = await getAllPositions();
    res.json({ success: true, positions });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post("/place", authMiddleware, async (req, res) => {
  try {
    const { tokenId, price, size, side, orderType, tickSize, negRisk } = req.body || {};
    if (!tokenId || typeof price !== "number" || typeof size !== "number" || !side) {
      return res.status(400).json({ success: false, error: "Missing/invalid fields" });
    }

    const client = await initClient();
    const { orderId, resp } = await placeOrder(client, { tokenId, price, size, side, orderType, tickSize, negRisk });
    res.json({ success: true, orderId, response: resp });
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
