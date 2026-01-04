import express from "express";
import { Wallet } from "@ethersproject/wallet";
import { Buffer } from "buffer";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

globalThis.Buffer = Buffer;

const app = express();
app.use(express.json());

/* =======================
   VERSION (DEPLOY TRUTH)
======================= */
const VERSION = "credstrim-v1";

/* =======================
   ENV (TRIMMED)
======================= */
const WORKER_SECRET = (process.env.WORKER_SECRET || "").trim();

const PM_PRIVATE_KEY = (process.env.PM_PRIVATE_KEY || "").trim();
const PM_API_KEY = (process.env.PM_API_KEY || "").trim();
const PM_API_SECRET = (process.env.PM_API_SECRET || "").trim();
const PM_API_PASSPHRASE = (process.env.PM_API_PASSPHRASE || "").trim();

const PM_CLOB_HOST = process.env.PM_CLOB_HOST || "https://clob.polymarket.com";
const PM_GAMMA_HOST = process.env.PM_GAMMA_HOST || "https://gamma-api.polymarket.com";
const PM_SIGNATURE_TYPE = Number(process.env.PM_SIGNATURE_TYPE || 0);

const PORT = Number(process.env.PORT || 3000);
const CHAIN_ID = 137;

if (
  !WORKER_SECRET ||
  !PM_PRIVATE_KEY ||
  !PM_API_KEY ||
  !PM_API_SECRET ||
  !PM_API_PASSPHRASE
) {
  console.error("[BOOT] Missing required env vars");
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

/* =======================
   CLOB CLIENT
======================= */
let wallet = null;
let walletAddress = null;
let clobClient = null;
let initPromise = null;

async function initClient() {
  if (clobClient) return clobClient;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    console.log("[BOOT] version=", VERSION);

    wallet = new Wallet(PM_PRIVATE_KEY);
    walletAddress = await wallet.getAddress();

    const creds = {
      apiKey: PM_API_KEY,
      secret: PM_API_SECRET,
      passphrase: PM_API_PASSPHRASE
    };

    clobClient = new ClobClient(
      PM_CLOB_HOST,
      CHAIN_ID,
      wallet,
      creds,
      PM_SIGNATURE_TYPE
    );

    console.log("[BOOT] CLOB client initialized");
    return clobClient;
  })();

  return initPromise;
}

/* =======================
   ROUTES
======================= */

/** DEPLOYMENT TRUTH */
app.get("/version", (req, res) => {
  res.json({
    version: VERSION,
    node: process.version,
    wallet: walletAddress || null,
    timestamp: new Date().toISOString()
  });
});

/** HEALTH */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    walletAddress: walletAddress || null,
    clientStatus: clobClient ? "ready" : "not_initialized"
  });
});

/** LIST OPEN ORDERS */
app.get("/orders", requireAuth, async (req, res) => {
  try {
    const client = await initClient();
    const orders = await client.getOpenOrders();
    res.json({ success: true, count: orders.length, orders });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

/** PLACE ORDER */
app.post("/place", requireAuth, async (req, res) => {
  try {
    const { tokenId, side, price, size } = req.body || {};

    if (!tokenId || !side || typeof price !== "number" || typeof size !== "number") {
      return res.status(400).json({ error: "invalid_body" });
    }

    const client = await initClient();
    const sideEnum = side.toUpperCase() === "BUY" ? Side.BUY : Side.SELL;

    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price, size, side: sideEnum },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTC
    );

    res.json({
      success: true,
      orderId: resp.orderID || resp.id || null,
      response: resp
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

/* =======================
   START
======================= */
app.listen(PORT, () => {
  console.log(`[BOOT] Worker listening on ${PORT}`);
  initClient().catch(err =>
    console.error("[BOOT] init failed:", err.message)
  );
});
