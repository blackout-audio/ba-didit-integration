# Shopify + Didit Fraud Verification App

This app integrates Shopify orders with Didit identity verification:

- Detects risky orders from `orders/updated` webhooks.
- Creates a Didit verification session and writes order tags/metafields for Shopify Flow to email customers.
- Retries every 7 days if not completed, with up to 2 follow-up links.
- Marks successful checks by tagging the order with `verified` and `didit_verified`.
- Sends manual-review alerts to `operations@blackoutaudio.com` when verification does not pass.

## Stack

- Node.js + TypeScript + Express
- SQLite (local persistence for shop tokens and verification jobs)
- Didit API v3 session endpoints
- Shopify OAuth + Admin GraphQL API

## 1) Configure Shopify App (Dev Dashboard 2026 flow)

1. Create a **public/custom app** in Shopify Dev Dashboard (`dev.shopify.com/dashboard`).
2. Set:
   - **App URL**: `https://your-app-domain.com`
   - **Allowed redirection URL(s)**: `https://your-app-domain.com/auth/callback`
3. Request scopes:
   - `read_orders`
   - `write_orders`
   - `read_customers`
   - `write_customers`
4. Add webhook subscriptions (or let this app auto-create on install):
   - Topic: `orders/updated`
   - URL: `https://your-app-domain.com/webhooks/shopify/orders-updated`

## 2) Configure Didit

From Didit Business Console:

- Copy `CLIENT_ID`, `CLIENT_SECRET`, and `WEBHOOK_SECRET_KEY`.
- Set Didit webhook URL to:
  - `https://your-app-domain.com/webhooks/didit`

## 3) Local setup

```bash
npm install
cp .env.example .env
```

Update `.env` with your values.

## 4) Run

```bash
npm run dev
```

Health check:

```bash
GET /health
```

## 5) Install app on store

Open:

```text
https://your-app-domain.com/auth?shop=your-store.myshopify.com
```

On callback, the app:

- Exchanges OAuth code for offline token
- Saves token in SQLite (`data.sqlite`)
- Registers `ORDERS_UPDATED` webhook via Admin GraphQL

## 6) Email behavior (Flow-first)

- App writes verification state to order tags + metafields:
  - Tags: `didit_verification_required`, `didit_verification_pending`, `didit_verified`, `didit_manual_review`
  - Metafields (namespace `didit` by default):
    - `verification_status`
    - `verification_url`
    - `verification_session_id`
- Shopify Flow should send customer emails from your templates when those tags/metafields change.
- On pass:
  - order gets `verified` + `didit_verified` tags
  - customer receives verification-complete email
- On not pass:
  - order gets `didit_manual_review`
  - ops receives alert email at `OPS_EMAIL` (default `operations@blackoutaudio.com`)

## 7) Retry worker

Retries run hourly via cron and only process jobs due at or before current time.

You can manually trigger:

```bash
POST /jobs/retry/run
```

## 8) Run without daily changes (recommended)

Do not rely on local tunnels for production. Tunnel URLs rotate and stop after sleep/restart.

Use one-time deployment to an always-on host with a stable URL:

- This repo includes `render.yaml` for Render deployment.
- Set a persistent SQLite path (`SQLITE_PATH=/var/data/data.sqlite`) using the mounted disk.
- Configure Shopify App URL + redirect and Didit webhook endpoint once with the stable production URL.

After that, no daily URL updates are needed.

## Notes

- Didit webhook payloads can vary. This app extracts session id from `session_id`, `sessionId`, or nested `data`.
- `orderInvoiceSend` is not reliable for paid orders with no outstanding balance. Flow-first delivery avoids this limitation.
