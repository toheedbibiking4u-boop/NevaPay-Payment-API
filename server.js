require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } })
  : null;

app.use(cors({
  origin: process.env.FRONTEND_URL && process.env.FRONTEND_URL !== "*" ? process.env.FRONTEND_URL : true
}));
app.use(express.json({ limit: "100kb" }));

function id(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function cleanAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1000000000) throw new Error("Invalid amount");
  return Math.round(n * 100) / 100;
}

async function db() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_links (
      id TEXT PRIMARY KEY,
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT NOT NULL,
      description TEXT,
      methods JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'PENDING',
      provider TEXT NOT NULL DEFAULT 'PENDING_GATEWAY',
      provider_reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      link_id TEXT REFERENCES payment_links(id),
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT NOT NULL,
      method TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

app.get("/api/health", async (req, res) => {
  let database = "NOT_CONFIGURED";
  if (pool) {
    try { await pool.query("SELECT 1"); database = "OK"; }
    catch (_) { database = "ERROR"; }
  }
  res.json({ ok: true, service: "NexaPay Payment API", database, time: new Date().toISOString() });
});

app.post("/api/payment-links", async (req, res) => {
  try {
    const amount = cleanAmount(req.body.amount);
    const currency = String(req.body.currency || "PKR").toUpperCase().slice(0, 8);
    const description = String(req.body.description || "").slice(0, 240);
    const methods = Array.isArray(req.body.methods) ? req.body.methods.slice(0, 20).map(x => String(x).slice(0, 40)) : [];
    const linkId = id("PAY");

    const database = await db();
    await database.query(
      `INSERT INTO payment_links (id, amount, currency, description, methods)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [linkId, amount, currency, description, JSON.stringify(methods)]
    );

    const base = (process.env.PAYMENT_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    res.status(201).json({
      ok: true,
      id: linkId,
      status: "PENDING",
      amount,
      currency,
      methods,
      paymentUrl: `${base}/pay/${encodeURIComponent(linkId)}`
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get("/api/payment-links/:id", async (req, res) => {
  try {
    const database = await db();
    const r = await database.query("SELECT * FROM payment_links WHERE id=$1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "Payment link not found" });
    res.json({ ok: true, paymentLink: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/pay/:id", async (req, res) => {
  try {
    const database = await db();
    const r = await database.query("SELECT * FROM payment_links WHERE id=$1", [req.params.id]);
    if (!r.rowCount) return res.status(404).send("Payment link not found");
    const p = r.rows[0];
    const methods = Array.isArray(p.methods) ? p.methods : [];
    const methodHtml = methods.map(m => `<option>${escapeHtml(m)}</option>`).join("");
    res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NexaPay Payment</title>
<style>
body{font-family:system-ui;background:#050607;color:#e8ffff;max-width:560px;margin:40px auto;padding:20px}
.card{border:1px solid #00d9c8;border-radius:16px;padding:24px;background:#071012}
h1{color:#19e6d5}.amount{font-size:32px;margin:20px 0}
label{display:block;margin-top:16px}select,input,button{width:100%;padding:13px;margin-top:7px;border-radius:10px;box-sizing:border-box}
button{background:#19e6d5;border:0;font-weight:800;cursor:pointer}
small{color:#9bb}
</style></head><body><div class="card">
<h1>NexaPay</h1><div>Secure payment request</div>
<div class="amount">${escapeHtml(String(p.amount))} ${escapeHtml(p.currency)}</div>
${p.description ? `<p>${escapeHtml(p.description)}</p>` : ""}
<label>Payment method<select id="method">${methodHtml || "<option>Provider checkout</option>"}</select></label>
<button onclick="start()">Continue to secure checkout</button>
<p><small>This page does not collect or store card numbers or CVV. A real payment is completed through the configured payment provider.</small></p>
<script>
async function start(){
 const method=document.getElementById('method').value;
 const r=await fetch('/api/checkout/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({linkId:${JSON.stringify(p.id)},method})});
 const j=await r.json();
 if(j.checkoutUrl) location.href=j.checkoutUrl;
 else alert(j.error||'Gateway is not configured yet.');
}
</script></div></body></html>`);
  } catch (e) { res.status(500).send("Server error"); }
});

app.post("/api/checkout/start", async (req, res) => {
  // This endpoint intentionally does NOT fake a successful payment.
  // Connect the approved merchant gateway here and return its hosted checkout URL.
  const linkId = String(req.body.linkId || "");
  const method = String(req.body.method || "UNKNOWN");
  if (!linkId) return res.status(400).json({ ok:false, error:"linkId required" });
  res.status(501).json({
    ok:false,
    error:"No live payment gateway is configured. Register the merchant account and add its approved API credentials before accepting real payments.",
    linkId,
    method
  });
});

function verifySignature(rawBody, signature) {
  const secret = process.env.WEBHOOK_SECRET || "";
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); }
  catch (_) { return false; }
}

// Provider-neutral verified webhook.
// Configure your payment provider to send a signed webhook here.
app.post("/api/webhooks/payment", express.raw({type:"application/json"}), async (req, res) => {
  try {
    const signature = req.get("x-nexapay-signature") || "";
    const raw = req.body.toString("utf8");
    if (!verifySignature(raw, signature)) return res.status(401).json({ok:false,error:"Invalid signature"});

    const event = JSON.parse(raw);
    if (event.type !== "payment.succeeded") return res.json({ok:true,ignored:true});

    const database = await db();
    const linkId = String(event.linkId || "");
    const amount = cleanAmount(event.amount);
    const currency = String(event.currency || "").toUpperCase();
    const method = String(event.method || "UNKNOWN");
    const provider = String(event.provider || "UNKNOWN");
    const providerReference = String(event.providerReference || "");

    const link = await database.query("SELECT * FROM payment_links WHERE id=$1 FOR UPDATE", [linkId]);
    if (!link.rowCount) return res.status(404).json({ok:false,error:"Unknown payment link"});
    const p = link.rows[0];

    if (Number(p.amount) !== amount || p.currency !== currency)
      return res.status(400).json({ok:false,error:"Amount/currency mismatch"});

    await database.query(
      `INSERT INTO payments (id,link_id,amount,currency,method,status,provider,provider_reference)
       VALUES ($1,$2,$3,$4,$5,'PAID',$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [id("TXN"), linkId, amount, currency, method, provider, providerReference]
    );
    await database.query(
      `UPDATE payment_links SET status='PAID', provider=$2, provider_reference=$3, paid_at=NOW()
       WHERE id=$1 AND status <> 'PAID'`,
      [linkId, provider, providerReference]
    );
    res.json({ok:true,status:"PAID"});
  } catch (e) {
    res.status(400).json({ok:false,error:e.message});
  }
});

app.get("/api/balance", async (req, res) => {
  try {
    const currency = String(req.query.currency || "PKR").toUpperCase();
    const database = await db();
    const r = await database.query(
      `SELECT COALESCE(SUM(amount),0) AS received
       FROM payments WHERE status='PAID' AND currency=$1`, [currency]);
    res.json({ok:true,currency,received:Number(r.rows[0].received || 0),pending:0});
  } catch (e) { res.status(500).json({ok:false,error:e.message}); }
});

app.get("/api/payments", async (req, res) => {
  try {
    const database = await db();
    const r = await database.query(
      `SELECT id,link_id,amount,currency,method,status,provider,provider_reference,created_at,updated_at
       FROM payments ORDER BY created_at DESC LIMIT 100`);
    res.json({ok:true, payments:r.rows});
  } catch (e) { res.status(500).json({ok:false,error:e.message}); }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

initDb().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`NexaPay API listening on ${PORT}`));
}).catch(err => {
  console.error(err);
  process.exit(1);
});
