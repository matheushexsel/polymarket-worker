import express from "express";

const app = express();
app.use(express.json());

const WORKER_SECRET = process.env.WORKER_SECRET;
if (!WORKER_SECRET) {
  console.error("Missing WORKER_SECRET");
  process.exit(1);
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${WORKER_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => res.json({ ok: true }));

// TODO: Replace these stubs with real Polymarket CLOB SDK calls
app.post("/place", requireAuth, async (req, res) => {
  const { tokenId, side, price, size } = req.body || {};
  if (!tokenId || !side || typeof price !== "number" || typeof size !== "number") {
    return res.status(400).json({ error: "invalid_body" });
  }
  // placeholder until you integrate clob-client
  return res.json({ orderId: `stub_${Date.now()}`, status: "PLACED" });
});

app.post("/cancel", requireAuth, async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: "invalid_body" });
  return res.json({ status: "CANCELLED" });
});

app.get("/positions", requireAuth, async (req, res) => {
  const tokenId = req.query.tokenId;
  if (!tokenId) return res.status(400).json({ error: "missing_tokenId" });
  return res.json({ tokenId, shares: 0 });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`worker listening on ${port}`));
