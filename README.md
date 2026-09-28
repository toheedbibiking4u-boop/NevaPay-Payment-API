# NexaPay Payment API

Backend for NexaPay payment links, payment status, balance and verified webhook ledger.

## What is included

- `GET /api/health`
- `POST /api/payment-links`
- `GET /api/payment-links/:id`
- Public customer page: `/pay/:id`
- `GET /api/balance?currency=PKR`
- `GET /api/payments`
- Signed webhook endpoint: `POST /api/webhooks/payment`
- PostgreSQL schema auto-created at startup
- Render deployment file

## Important

This package does not pretend that a payment happened. A payment is credited only after a configured payment provider sends a valid signed success webhook.

It also does not collect or store raw card numbers/CVV. Use the provider's hosted/tokenized checkout.

## Deploy on Render

1. Put this folder in a GitHub repository.
2. In Render: New -> Web Service -> connect the repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables:
   - `DATABASE_URL`
   - `PAYMENT_BASE_URL` (your Render URL)
   - `WEBHOOK_SECRET`
6. Create/use a PostgreSQL database and put its connection string in `DATABASE_URL`.
7. Deploy.
8. Test:
   `https://YOUR-SERVICE.onrender.com/api/health`

Render gives a web service an `onrender.com` URL after deployment.

## Create a payment link

POST `/api/payment-links`

Example JSON:
{
  "amount": 1000,
  "currency": "PKR",
  "description": "Invoice #1001",
  "methods": ["Debit Card","Credit Card","Bank Transfer","Easypaisa","JazzCash / Raast"]
}

The API returns a `paymentUrl`.

## Gateway integration

The `/api/checkout/start` endpoint is intentionally a safe integration point. Replace its provider-specific section with the official merchant API/SDK for the gateway you are approved to use.

For Pakistan, Easypaisa's merchant portal currently advertises Payment Link and online payments. Its FAQ lists Easypaisa Mobile Account and OTC as online-payment modes. JazzCash/Raast integration requires its own merchant setup and credentials.

Never put gateway secrets, card data, CVV, or wallet private keys in the Android app.
