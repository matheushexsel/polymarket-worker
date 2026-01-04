import express from "express";
import { ethers } from "ethers";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

const app = express();
app.use(express.json());

/* =======================
   ENV
======================= */
const {
  WORKER_SECRET,
  PM_PRIVATE_KEY,
  PM_CLOB_HOST,
  PM_GAMMA_HOST,
  PM_SIGNATURE_TYPE,
  PORT = 3000
} = process.env;

if (!WORKER_SECRET || !PM_PRIVATE_KEY || !PM_CLOB_HOST) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const CHAIN_ID = 137; // Polygon mainnet

/* =======================
   GLOBALS
======================= */
let wallet;
let walletAddress;
let clobClient;
let clientInitPromise = null;

/* =======================
   INIT CLOB CLIENT
======================= */
async function initClient() {
  if (clobClient) return clobClient;
  if (clientInitPromise) return clientInitPromise;

  clientInitPromise = (async () => {
    try {
      console.log("[Worker] Initializing CLOB client");

      wallet = new ethers.Wallet(PM_PRIVATE_KEY);
      walletAddress = await wallet.getAddress();

      const tempClient = new ClobClient(PM_CLOB_HOST, CHAIN_ID, wallet);
      const creds = await tempClient.createOrDeriveApiKey();

      clobClient = new ClobClient(
        PM_CLOB_HOST,
        CHAIN_ID,
        wallet,
        creds,
        Number(PM_SIGNATURE_TYPE || 0)
      );

      console.log("[Worker] CLOB ready for wallet", walletAddress);
      return clobClient;
    } catch (err) {
      clientInitPromise = null;
      console.error("[Worker] CLOB init failed:", err.message);
      throw err;
    }
  })();

  return clientInitPromise;
}

/* =======================
   AUTH
======================= */
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  if (h !== `Bearer ${WORKER_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function isDryRun(req) {
  return req.headers["x-dry-run"] === "1" || req.headers["x-dry-run"] === "true";
}

/* =======================
   ROUTES
======================= */

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    walletAddress: walletAddress || null,
    clientStatus: clobClient
      ? "ready"
      : clientInitPromise
      ? "initializing"
      : "not_initialized",
    clobHost: PM_CLOB_HOST,
    gammaHost: PM_GAMMA_HOST,
    timestamp: new Date().toISOString()
  });
});

app.get("/orders", auth, async (req, res) => {
  try {
    const client = await initClient();
    const orders = await client.getOpenOrders();
    res.json({ success: true, count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/place", auth, async (req, res) => {
  const dryRun = isDryRun(req);

  try {
    const { tokenId, price, size, side, tickSize = "0.01", negRisk = false } = req.body;

    if (!tokenId || !price || !size || !side) {
      return res.status(400).json({ error: "invalid_body" });
    }

    const client = await initClient();

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        message: "validated only"
      });
    }

    const sideEnum = side.toUpperCase() === "BUY" ? Side.BUY : Side.SELL;

    const resp = await client.createAndPostOrder(
      { tokenID: tokenId, price, size, side: sideEnum },
      { tickSize, negRisk },
      OrderType.GTC
    );

    const orderId = resp?.orderID || resp?.id || resp?.order_id;

    res.json({ success: true, dryRun: false, orderId, response: resp });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/cancel", auth, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: "missing_orderId" });

    const client = await initClient();
    const result = await client.cancelOrder(orderId);
    res.json({ success: true, cancelled: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/positions", auth, async (req, res) => {
  try {
    const { tokenId } = req.query;
    if (!tokenId) return res.status(400).json({ error: "missing_tokenId" });

    const client = await initClient();
    const bal = await client.getBalanceAllowance(tokenId);
    res.json({
      success: true,
      tokenId,
      shares: Number(bal?.balance || 0),
      raw: bal
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* =======================
   START
======================= */
app.listen(PORT, () => {
  console.log(`[Worker] Running on port ${PORT}`);
  initClient().catch(() => {});
});
