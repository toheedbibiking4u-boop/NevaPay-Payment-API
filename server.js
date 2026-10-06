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
app.use("/api/atlos/webhook", express.raw({type:"application/json", limit:"1mb"}));
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
  await pool.query(`
    ALTER TABLE payment_links
    ADD COLUMN IF NOT EXISTS bnb_quote NUMERIC(36,18),
    ADD COLUMN IF NOT EXISTS bnb_quote_rate NUMERIC(36,8),
    ADD COLUMN IF NOT EXISTS bnb_quote_expires_at TIMESTAMPTZ
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

app.get("/api/payment-links", async (req,res)=>{try{const database=await db();const q=await database.query("SELECT id,amount,currency,description,methods,status,provider,provider_reference,created_at,paid_at FROM payment_links ORDER BY created_at DESC LIMIT 100");res.json({ok:true,paymentLinks:q.rows});}catch(e){res.status(500).json({ok:false,error:e.message});}});

app.post("/api/payment-links", async (req, res) => {
  try {
    const amount = cleanAmount(req.body.amount);
    const currency = String(req.body.currency || "PKR").toUpperCase().slice(0, 8);
    const description = String(req.body.description || "").slice(0, 240);
    const methods = Array.isArray(req.body.methods) && req.body.methods.length
      ? req.body.methods.slice(0, 20).map(x => String(x).slice(0, 40))
      : ["bank_transfer", "card", "trust_wallet"];
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
    const r = await database.query("SELECT * FROM payment_links WHERE id=$1 OR LOWER(TRIM(id))=LOWER(TRIM($1))", [req.params.id]);
    if (!r.rowCount) return res.status(404).send("Payment link not found");
    const p = r.rows[0];
    const methods = [...(Array.isArray(p.methods) ? p.methods : []), "trust_wallet"].filter((v,i,a) => a.indexOf(v) === i);
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
<label>Payment method
<select id="method" onchange="showMethod()">
  <option value="bank_transfer">🏦 Bank Transfer</option>
  <option value="card">💳 Card Payment</option>
  <option value="paymegate">💳 Paymegate — Card / Crypto</option>
  <option value="paymegate_crypto">₿ Paymegate — Crypto Only</option>
  <option value="trust_wallet">👛 Trust Wallet / BNB</option>
</select>
</label>

<div id="methodInfo" style="margin-top:18px;padding:14px;border:1px solid #164b4b;border-radius:12px;background:#091719">
  Select a payment method to continue.
</div>

<button onclick="start()">Continue</button>

<p>
  <small>
    Card details are not collected or stored by NexaPay.
    Card payments require a configured payment gateway.
    Trust Wallet payments are verified on BNB Smart Chain before being marked PAID.
  </small>
</p>

<script>
let cryptoQuote = null;

function showMethod(){
  const method = document.getElementById('method').value;
  const box = document.getElementById('methodInfo');

  if(method === 'bank_transfer'){
    box.innerHTML =
      '<b>🏦 Bank Transfer</b><br>' +
      'Bank transfer instructions will be provided for this payment.';
  }

  if(method === 'card'){
    box.innerHTML =
      '<b>💳 Card Payment</b><br>' +
      'You will be redirected to the configured secure card gateway.';
  }

  if(method === 'paymegate'){
    box.innerHTML =
      '<b>💳 Paymegate — Card / Crypto</b><br>' +
      'Secure hosted checkout. Card and supported crypto methods are provided by Paymegate.';
  }

  if(method === 'paymegate_crypto'){
    box.innerHTML =
      '<b>₿ Paymegate — Crypto Only</b><br>' +
      'Secure Paymegate crypto checkout.';
  }

  if(method === 'trust_wallet'){
    box.innerHTML =
      '<b>👛 Trust Wallet / BNB</b><br>' +
      '<button type="button" onclick="getCryptoQuote()">Get BNB Payment Amount</button>';
  }
}

async function getCryptoQuote(){
  const box = document.getElementById('methodInfo');

  box.innerHTML = 'Getting current BNB/USD rate...';

  try {
    const r = await fetch(
      '/api/crypto/quote/${encodeURIComponent(p.id)}'
    );

    const j = await r.json();

    if(!r.ok){
      box.innerHTML =
        '<b>Quote error</b><br>' +
        (j.error || 'Unable to create BNB quote.');
      return;
    }

    cryptoQuote = j;

    const bnb =
      Number(j.bnbAmount).toFixed(8);

    const merchant =
      String(j.merchant || '');

    box.innerHTML =
      '<b>👛 Trust Wallet / BNB</b>' +
      '<p>USD amount: <b>$' +
      Number(j.usdAmount).toFixed(2) +
      '</b></p>' +
      '<p>Required BNB: <b>' +
      bnb +
      ' BNB</b></p>' +
      '<p>Rate: 1 BNB ≈ $' +
      Number(j.bnbUsdRate).toFixed(2) +
      '</p>' +
      '<p>Merchant BSC address:</p>' +
      '<input id="merchantAddress" readonly value="' +
      merchant +
      '">' +
      '<button type="button" onclick="copyMerchant()">Copy Address</button>' +
      '<p><small>Open Trust Wallet → BNB → Send → paste the merchant address → send the exact BNB amount above.</small></p>' +
      '<p>After sending, paste the BSC transaction hash below:</p>' +
      '<input id="txHash" placeholder="0x... transaction hash">' +
      '<button type="button" onclick="verifyCryptoPayment()">Verify Payment</button>' +
      '<div id="verifyResult" style="margin-top:12px"></div>';
  } catch(e) {
    box.innerHTML =
      '<b>Quote error</b><br>' + e.message;
  }
}

async function copyMerchant(){
  const value =
    document.getElementById('merchantAddress').value;

  try {
    await navigator.clipboard.writeText(value);
    alert('Merchant address copied.');
  } catch(e) {
    alert(value);
  }
}

async function verifyCryptoPayment(){
  if(!cryptoQuote){
    alert('Get the BNB payment amount first.');
    return;
  }

  const txHash =
    document.getElementById('txHash').value.trim();

  const result =
    document.getElementById('verifyResult');

  if(!/^0x[a-fA-F0-9]{64}$/.test(txHash)){
    result.innerHTML =
      '<span>Invalid BSC transaction hash.</span>';
    return;
  }

  result.innerHTML = 'Checking BSC transaction...';

  try {
    const r = await fetch('/api/crypto/verify',{
      method:'POST',
      headers:{
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        linkId:${encodeURIComponent(p.id)},
        txHash
      })
    });

    const j = await r.json();

    if(!r.ok){
      result.innerHTML =
        '<b>Payment not verified:</b><br>' +
        (j.error || 'Verification failed.');
      return;
    }

    result.innerHTML =
      '<h3>✅ Payment PAID</h3>' +
      '<p>USD: $' +
      Number(j.usdAmount).toFixed(2) +
      '</p>' +
      '<p>BNB received: ' +
      Number(j.bnbPaid).toFixed(8) +
      '</p>' +
      '<p>Transaction verified on BSC.</p>' +
      '<p>TX: ' + j.txHash + '</p>';

  } catch(e) {
    result.innerHTML =
      '<b>Verification error:</b><br>' +
      e.message;
  }
}

async function start(){
  
  const method =
    document.getElementById('method').value;

  if(method === 'trust_wallet'){
      const merchantId = '${process.env.ATLOS_MERCHANT_ID || ""}';

      if(!merchantId){
        alert('ATLOS Merchant ID is not configured.');
        return;
      }

      if(typeof atlos === 'undefined'){
        alert('ATLOS payment widget is still loading. Please try again.');
        return;
      }

      try {
        atlos.Pay({
          merchantId: merchantId,
          orderId: '${p.id}',
          orderAmount: Number('${p.amount}'),
          orderCurrency: '${p.currency}',
          postbackUrl: 'https://nevapay-payment-api.onrender.com/api/atlos/webhook',
          noBuyCrypto: false,
          language: 'en',
          theme: 'dark'
        });
      } catch(e) {
        alert('ATLOS ERROR: ' + (e && e.message ? e.message : String(e)));
        console.error('ATLOS ERROR', e);
      }

      return;
    }

  const r = await fetch('/api/checkout/start',{
    method:'POST',
    headers:{
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      linkId:${encodeURIComponent(p.id)},
      method
    })
  });

  const j = await r.json();

  if(j.checkoutUrl){
    location.href = j.checkoutUrl;
    return;
  }

  if(j.instructions){
    document.getElementById('methodInfo').innerHTML =
      '<b>Payment instructions</b><br>' +
      j.instructions;
    return;
  }

  alert(
    j.error ||
    'Payment gateway is not configured yet.'
  );
}

showMethod();
</script></div><script async src="https://atlos.io/packages/app/atlos.js"></script>
</body></html>`);
  } catch (e) { res.status(500).send("Server error"); }
});


app.get("/api/crypto/quote/:id", async (req, res) => {
  try {
    const database = await db();

    const result = await database.query(
      "SELECT * FROM payment_links WHERE id=$1",
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Payment link not found"
      });
    }

    const link = result.rows[0];
    const usd = Number(link.amount);

    if (String(link.currency).toUpperCase() !== "USD") {
      return res.status(400).json({
        error: "This crypto checkout requires a USD payment link"
      });
    }

    const rateUrls = [
      "https://data-api.binance.vision/api/v3/ticker/price?symbol=BNBUSDT",
      "https://api1.binance.com/api/v3/ticker/price?symbol=BNBUSDT",
      "https://api2.binance.com/api/v3/ticker/price?symbol=BNBUSDT",
      "https://api3.binance.com/api/v3/ticker/price?symbol=BNBUSDT",
      "https://api4.binance.com/api/v3/ticker/price?symbol=BNBUSDT",
      "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT"
    ];

    let rate = NaN;

    for (const url of rateUrls) {
      try {
        const response = await fetch(url, {
          headers: { "accept": "application/json" }
        });

        if (!response.ok) continue;

        const market = await response.json();
        const candidate = Number(market?.price);

        if (Number.isFinite(candidate) && candidate > 0) {
          rate = candidate;
          break;
        }
      } catch (_) {}
    }

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("Unable to obtain current BNB/USD rate");
    }

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("Invalid BNB/USD rate");
    }

    const requiredBnb = usd / rate;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await database.query(
      `UPDATE payment_links
       SET bnb_quote=$1,
           bnb_quote_rate=$2,
           bnb_quote_expires_at=$3
       WHERE id=$4`,
      [
        requiredBnb,
        rate,
        expiresAt,
        req.params.id
      ]
    );

    return res.json({
      ok: true,
      linkId: link.id,
      usdAmount: usd,
      bnbAmount: requiredBnb,
      bnbUsdRate: rate,
      expiresAt,
      merchant: process.env.MERCHANT_BSC_ADDRESS,
      chainId: Number(process.env.BSC_CHAIN_ID || 56)
    });

  } catch (e) {
    console.error("Crypto quote error:", e);
    return res.status(500).json({
      error: e.message
    });
  }
});


app.post("/api/crypto/verify", async (req, res) => {
  try {
    const { linkId, txHash } = req.body || {};

    if (!linkId || !txHash) {
      return res.status(400).json({
        error: "linkId and txHash are required"
      });
    }

    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return res.status(400).json({
        error: "Invalid BSC transaction hash"
      });
    }

    const merchant = String(
      process.env.MERCHANT_BSC_ADDRESS || ""
    ).toLowerCase();

    if (!/^0x[a-fA-F0-9]{40}$/.test(merchant)) {
      return res.status(500).json({
        error: "MERCHANT_BSC_ADDRESS is not configured"
      });
    }

    const database = await db();

    const linkResult = await database.query(
      "SELECT * FROM payment_links WHERE id=$1",
      [linkId]
    );

    if (!linkResult.rows.length) {
      return res.status(404).json({
        error: "Payment link not found"
      });
    }

    const link = linkResult.rows[0];

    if (String(link.currency).toUpperCase() !== "USD") {
      return res.status(400).json({
        error: "This Trust Wallet flow requires a USD payment link"
      });
    }

    if (!link.bnb_quote || !link.bnb_quote_expires_at) {
      return res.status(400).json({
        error: "Create a fresh BNB payment quote first"
      });
    }

    if (new Date(link.bnb_quote_expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        error: "BNB payment quote expired. Create a new quote."
      });
    }

    const duplicate = await database.query(
      "SELECT id FROM payments WHERE provider_reference=$1 LIMIT 1",
      [txHash]
    );

    if (duplicate.rows.length) {
      return res.status(409).json({
        error: "This transaction has already been used"
      });
    }

    const rpc =
      process.env.BSC_RPC_URL ||
      "https://bsc-dataseed.binance.org/";

    async function rpcCall(method, params) {
      const response = await fetch(rpc, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params
        })
      });

      const json = await response.json();

      if (json.error) {
        throw new Error(
          json.error.message || "BSC RPC error"
        );
      }

      return json.result;
    }

    const tx = await rpcCall(
      "eth_getTransactionByHash",
      [txHash]
    );

    if (!tx) {
      return res.status(400).json({
        error: "Transaction not found on BSC"
      });
    }

    const receipt = await rpcCall(
      "eth_getTransactionReceipt",
      [txHash]
    );

    if (!receipt || !receipt.blockNumber) {
      return res.status(400).json({
        error: "Transaction is not confirmed yet"
      });
    }

    if (receipt.status !== "0x1") {
      return res.status(400).json({
        error: "Transaction failed on BSC"
      });
    }

    if (String(tx.to || "").toLowerCase() !== merchant) {
      return res.status(400).json({
        error: "Transaction was not sent to the merchant wallet"
      });
    }

    const paidWei = BigInt(tx.value || "0x0");
    const requiredBnb = Number(link.bnb_quote);

    const requiredWei =
      BigInt(Math.ceil(requiredBnb * 1e18));

    if (paidWei < requiredWei) {
      return res.status(400).json({
        error: "Payment amount is less than required BNB amount"
      });
    }

    const paymentId = id("PAY");

    await database.query(
      `INSERT INTO payments
       (id,link_id,amount,currency,method,status,provider,provider_reference,created_at,updated_at)
       VALUES($1,$2,$3,'USD','trust_wallet','PAID','bsc',$4,NOW(),NOW())`,
      [
        paymentId,
        linkId,
        Number(link.amount),
        txHash
      ]
    );

    await database.query(
      `UPDATE payment_links
       SET status='PAID',
           provider='bsc',
           provider_reference=$1,
           paid_at=NOW()
       WHERE id=$2`,
      [txHash, linkId]
    );

    return res.json({
      ok: true,
      status: "PAID",
      txHash,
      usdAmount: Number(link.amount),
      bnbPaid: Number(paidWei) / 1e18,
      merchant: process.env.MERCHANT_BSC_ADDRESS,
      chainId: Number(process.env.BSC_CHAIN_ID || 56),
      blockNumber: receipt.blockNumber
    });

  } catch (e) {
    console.error("Trust Wallet verification error:", e);

    return res.status(500).json({
      error: e.message
    });
  }
});

app.post("/api/checkout/start", async (req, res) => {
  try {
    const linkId = String(req.body.linkId || "").trim();
    const method = String(req.body.method || "UNKNOWN").trim();

    if (!linkId) {
      return res.status(400).json({
        ok: false,
        error: "linkId required"
      });
    }

    if (method === "paymegate" || method === "paymegate_crypto") {
      const apiKey = String(process.env.PAYMEGATE_API_KEY || "").trim();

      if (!apiKey) {
        return res.status(503).json({
          ok: false,
          error: "Paymegate is not configured on the server."
        });
      }

      const database = await db();

      const result = await database.query(
        "SELECT * FROM payment_links WHERE id=$1 LIMIT 1",
        [linkId]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          ok: false,
          error: "Unknown payment link"
        });
      }

      const link = result.rows[0];

      if (String(link.status || "").toUpperCase() === "PAID") {
        return res.status(409).json({
          ok: false,
          error: "Payment link is already paid"
        });
      }

      const amount = Number(link.amount);

      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Invalid payment amount"
        });
      }

      const currency = String(link.currency || "USD")
        .trim()
        .toUpperCase();

      const paymentMethodsKeys =
        method === "paymegate_crypto"
          ? ["crypto"]
          : ["*"];

      const baseUrl = String(
        process.env.PUBLIC_BASE_URL ||
        "https://nevapay-payment-api.onrender.com"
      ).replace(/\/$/, "");

      const payload = {
        externalId: linkId,
        amount: amount.toFixed(2),
        currency,
        paymentMethodsKeys,
        backUrl: `${baseUrl}/pay/${encodeURIComponent(linkId)}`,
        metadata: {
          nexapayLinkId: linkId
        }
      };

      const gatewayResponse = await fetch(
        "https://api.paymegate.com/v1/orders",
        {
          method: "POST",
          headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        }
      );

      const gatewayText = await gatewayResponse.text();

      let gatewayData = {};
      try {
        gatewayData = JSON.parse(gatewayText);
      } catch (_) {}

      if (!gatewayResponse.ok || !gatewayData?.data?.checkoutUrl) {
        console.error("Paymegate order creation failed:", {
          status: gatewayResponse.status,
          body: gatewayText.slice(0, 1000)
        });

        return res.status(502).json({
          ok: false,
          error: "Paymegate checkout could not be created."
        });
      }

      const order = gatewayData.data;

      await database.query(
        "UPDATE payment_links SET provider=$2, provider_reference=$3 WHERE id=$1",
        [
          linkId,
          "PAYMEGATE",
          String(order.orderUUID || "")
        ]
      );

      return res.json({
        ok: true,
        provider: "PAYMEGATE",
        status: order.status || "UNPAID",
        orderUUID: order.orderUUID,
        checkoutUrl: order.checkoutUrl
      });
    }

    return res.status(501).json({
      ok: false,
      error: "No live payment gateway is configured for this method.",
      linkId,
      method
    });

  } catch (error) {
    console.error("Checkout start error:", error);

    return res.status(500).json({
      ok: false,
      error: "Unable to start checkout."
    });
  }
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
  
app.get('/', (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NexaPay</title>
<style>
body{margin:0;background:#000;color:#eee;font-family:monospace;padding:18px}
.h{color:#12d8d0;font-size:30px;font-weight:bold}
.b{color:#16e0a0;font-size:18px;margin:18px 0}
.n{border:1px solid #16d8d0;padding:18px;text-align:center;color:#12d8d0}
.m{color:#16d89b;font-size:22px;margin:22px 0 10px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
.x{background:#061416;border:1px solid #0b2427;padding:14px;color:#eee;text-decoration:none}
.x b{color:#12d8d0}
.p{border:1px solid #16d8d0;margin-top:22px;padding:16px}
.g{color:#16e0a0}
</style>
</head>
<body>

<div class="h">NexaPay</div>
<div class="b">◆ BNB BINANCE COIN &nbsp; • USDT TETHER USD</div>

<div class="n">
<b>BSC MAINNET TOKEN SYSTEM</b><br><br>
ACTIVE ENVIRONMENT : [ BSC-MAINNET ]
</div>

<div class="m">SYSTEM CONTROL CENTER</div>

<div class="grid">
<a class="x" href="#create"><b>[01]</b> CREATE TOKEN<br>Deploy & configure BEP-20</a>
<a class="x" href="#info"><b>[02]</b> TOKEN INFORMATION<br>Name • Symbol • Supply</a>
<a class="x" href="#transfer"><b>[03]</b> TRANSFER TOKEN<br>BEP-20 transfer</a>
<a class="x" href="#wallet"><b>[04]</b> WALLET → WALLET<br>BSC address transfer</a>
<a class="x" href="#exchange"><b>[05]</b> EXCHANGE TRANSFER<br>Exchange deposit transfer</a>
<a class="x" href="#holders"><b>[06]</b> HOLDER ALLOCATION<br>Multiple holders</a>
<a class="x" href="#liquidity"><b>[07]</b> ADD LIQUIDITY<br>BNB + Token</a>
<a class="x" href="#management"><b>[08]</b> TOKEN MANAGEMENT<br>Transfer • Approve • Control</a>
<a class="x" href="#status"><b>[09]</b> WALLET & BNB STATUS<br>Wallet and native BNB</a>
<a class="x" href="#withdraw"><b>[10]</b> WITHDRAW TOKEN<br>Send token</a>
<a class="x" href="#bnb"><b>[11]</b> WITHDRAW BNB<br>Send BNB</a>
<a class="x" href="#history"><b>[12]</b> TRANSACTION HISTORY<br>Review records</a>
<a class="x" href="#payment"><b>[13]</b> PAYMENT CENTER<br>Receive • Send • Requests</a>
<a class="x" href="/store#investment"><b>[14]</b> INVESTMENT CENTER<br>PKR • USDT Plans</a>
<a class="x" href="/store#store"><b>[15]</b> ONLINE STORE<br>Mobile • Accessories • Services</a>
<a class="x" href="/store#samsung-shop"><b>[16]</b> SAMSUNG STORE<br>Galaxy • Phones • Accessories</a>
<a class="x" href="/store#checkout"><b>[17]</b> CHECKOUT<br>Payment Methods • Cart</a><a class="x" href="https://wa.me/15022873249" target="_blank" rel="noopener"><b>[18] 💬 WHATSAPP SUPPORT</b><br>Chat with NexaPay Support</a><a class="x" href="/website-info"><b>[19] ℹ️ WEBSITE INFORMATION</b><br>Services • Security • Terms • Contact</a>

</div>

<div class="p">
<h2>LIQUIDITY PREVIEW (BSC MAINNET)</h2>
<p class="g">● USDT &nbsp; LP VALUE : LIVE / PREVIEW</p>
<p class="g">◆ BNB &nbsp; REQUIRED BNB LIQUIDITY : CALCULATED</p>
</div>

<div class="p">
<h2>TRANSACTION STATUS</h2>
Deployment transaction : NOT SENT<br>
Approval transaction : NOT SENT<br>
Liquidity transaction : NOT SENT
</div>

<div class="p" id="payment">
<h2>PAYMENT CENTER</h2>
<p class="g">Receive • Send • Payment Requests</p>
<a class="x" href="/api/payment-links">VIEW PAYMENT LINKS</a>
</div>

</body>
</html>`);
});

app.get("/payment-center",(req,res)=>res.sendFile(require("path").join(__dirname,"payment-center.html")));


// XGate webhook receiver

app.post("/api/atlos/webhook", async (req, res) => {
  try {
    const crypto = require("crypto");

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}));

    const receivedSignature = String(req.get("Signature") || "");
    const secret = String(process.env.ATLOS_API_SECRET || "");

    if (!secret) {
      console.error("[ATLOS] ATLOS_API_SECRET is not configured");
      return res.status(500).json({ ok:false, error:"ATLOS webhook secret not configured" });
    }

    if (!receivedSignature) {
      return res.status(401).json({ ok:false, error:"Missing Signature header" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const a = Buffer.from(receivedSignature);
    const b = Buffer.from(expectedSignature);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.warn("[ATLOS] Invalid webhook signature");
      return res.status(401).json({ ok:false, error:"Invalid signature" });
    }

    const event = JSON.parse(rawBody.toString("utf8"));

    console.log("[ATLOS WEBHOOK]", JSON.stringify({
      transactionId: event.TransactionId,
      orderId: event.OrderId,
      status: event.Status,
      amount: event.Amount,
      orderAmount: event.OrderAmount,
      currency: event.OrderCurrency,
      asset: event.Asset,
      blockchain: event.Blockchain,
      blockchainHash: event.BlockchainHash
    }));

    if (Number(event.Status) !== 100) {
      return res.status(200).json({ ok:true, received:true, paid:false });
    }

    const linkId = String(event.OrderId || "").trim();

    if (!linkId) {
      return res.status(400).json({ ok:false, error:"OrderId missing" });
    }

    const database = await db();

    const q = await database.query(
      "SELECT * FROM payment_links WHERE id=$1 FOR UPDATE",
      [linkId]
    );

    if (!q.rows.length) {
      return res.status(404).json({ ok:false, error:"Payment link not found" });
    }

    const link = q.rows[0];

    const expectedAmount = Number(link.amount);
    const paidAmount = Number(event.OrderAmount);

    if (!Number.isFinite(paidAmount) ||
        Math.abs(expectedAmount - paidAmount) > 0.01) {
      console.warn("[ATLOS] Amount mismatch", {
        linkId,
        expectedAmount,
        paidAmount
      });

      return res.status(400).json({
        ok:false,
        error:"Payment amount mismatch"
      });
    }

    const expectedCurrency = String(link.currency || "").toUpperCase();
    const paidCurrency = String(event.OrderCurrency || "").toUpperCase();

    if (expectedCurrency && paidCurrency && expectedCurrency !== paidCurrency) {
      console.warn("[ATLOS] Currency mismatch", {
        linkId,
        expectedCurrency,
        paidCurrency
      });

      return res.status(400).json({
        ok:false,
        error:"Payment currency mismatch"
      });
    }

    if (String(link.status).toUpperCase() === "PAID") {
      return res.status(200).json({
        ok:true,
        received:true,
        alreadyPaid:true
      });
    }

    await database.query(
      `UPDATE payment_links
       SET status='PAID',
           provider='ATLOS',
           provider_reference=$2,
           paid_at=NOW()
       WHERE id=$1`,
      [
        linkId,
        String(event.TransactionId || event.BlockchainHash || "")
      ]
    );

    console.log("[ATLOS] Payment marked PAID:", linkId);

    return res.status(200).json({
      ok:true,
      received:true,
      paid:true,
      linkId
    });

  } catch (e) {
    console.error("[ATLOS WEBHOOK ERROR]", e.message);
    return res.status(500).json({
      ok:false,
      error:"Webhook processing failed"
    });
  }
});

app.post("/api/xgate/webhook", express.json({type:"application/json"}), async (req, res) => {
  try {
    const event = req.body || {};

    console.log("[XGATE WEBHOOK]", JSON.stringify({
      id: event.id,
      status: event.status,
      name: event.name,
      amount: event.amount,
      operation: event.operation,
      externalId: event.externalId
    }));

    // Acknowledge webhook immediately.
    // Payment is NOT marked PAID here until the XGate transaction
    // can be matched and verified.
    return res.status(200).json({
      ok: true,
      received: true
    });
  } catch (e) {
    console.error("[XGATE WEBHOOK ERROR]", e.message);
    return res.status(200).json({
      ok: false,
      received: true
    });
  }
});

app.get("/store", (req,res) => {
  res.sendFile(require("path").join(__dirname,"store.html"));
});
app.get("/website-info", (req,res)=>res.sendFile(require("path").join(__dirname,"website-info.html")));

app.listen(PORT, "0.0.0.0", () => console.log(`NexaPay API listening on ${PORT}`));
}).catch(err => {
  console.error(err);
  process.exit(1);
});
