# Shopify + Didit Fraud Verification App

This repo now contains two runtimes:

- `src/` - original Node + Express implementation.
- `workers/` - Cloudflare Worker implementation (recommended for free-tier reliability).

The Worker runtime keeps the same business behavior:

- Trigger on `orders/updated` when order has `nofraud-review` tag.
- Create Didit verification session.
- Send transactional customer emails directly via Resend API (no marketing opt-in dependency).
- Retry verification link generation every 7 days, up to 2 followups.
- Mark `verified` / `didit_verified` on pass.
- Mark `didit_manual_review` on non-pass and persist ops alert records.

Verification stops as soon as the order can no longer be verified. An order that is
cancelled, closed, voided, fully refunded or has an expired authorization is moved to
job status `order_cancelled`, which clears its retry schedule. This is enforced in two
places: immediately when the `orders/updated` webhook reports the change, and again as
an authoritative Shopify lookup right before any follow-up email is sent.

## Cloudflare architecture (single provider, free target)

- HTTP Webhooks + OAuth: Cloudflare Worker (`workers/src/index.ts`)
- Durable state: Cloudflare D1 (`shops`, `verification_jobs`, `webhook_events`, `ops_alerts`)
- Async processing: Cloudflare Queue (`ba-didit-jobs`)
- Scheduling: Cloudflare Cron Trigger (`*/15 * * * *`)

## Files added for Worker runtime

- `wrangler.toml`
- `workers/src/index.ts`
- `workers/src/workflow.ts`
- `workers/src/db.ts`
- `workers/src/shopify.ts`
- `workers/src/didit.ts`
- `workers/src/fraud.ts`
- `workers/migrations/0001_init.sql`
- `workers/migrations/0002_email_events.sql`
- `workers/.dev.vars.example`

## 1) Configure Shopify and Didit URLs

Set these endpoints to your deployed Worker domain:

- Shopify App URL: `https://<your-worker-domain>`
- Shopify Redirect URL: `https://<your-worker-domain>/auth/callback`
- Shopify webhook callback: `https://<your-worker-domain>/webhooks/shopify/orders-updated`
- Didit webhook callback: `https://<your-worker-domain>/webhooks/didit`

## 2) Cloudflare one-time setup

From repo root:

```bash
npm run worker:install
```

Create D1 database and queue:

```bash
npx wrangler d1 create ba-didit-integration-db
npx wrangler queues create ba-didit-jobs
```

Copy the generated D1 `database_id` into `wrangler.toml`.

Apply D1 migration:

```bash
npx wrangler d1 migrations apply ba-didit-integration-db
```

Set secrets:

```bash
npx wrangler secret put SHOPIFY_API_KEY
npx wrangler secret put SHOPIFY_API_SECRET
npx wrangler secret put DIDIT_APP_ID
npx wrangler secret put DIDIT_API_KEY
npx wrangler secret put DIDIT_WEBHOOK_SECRET
npx wrangler secret put OPS_ALERT_TOKEN
npx wrangler secret put RESEND_API_KEY
```

## 3) Deploy Worker

```bash
npm run worker:deploy
```

## 4) Install Shopify app once

Open:

```text
https://<your-worker-domain>/auth?shop=<your-store>.myshopify.com
```

The callback stores the offline token in D1 and registers the `ORDERS_UPDATED` webhook.

## 5) Verify end-to-end behavior

- Add `nofraud-review` tag to a paid test order.
- Confirm Didit session is created.
- Confirm order gets:
  - `didit_verification_required`
  - `didit_verification_pending`
  - metafields in namespace `didit`.
- Simulate Didit pass/fail webhook and confirm tag/metafield outcomes.
- Check retry path by calling:

```bash
curl -X POST https://<your-worker-domain>/jobs/retry/run
```

## 6) Ops endpoints

Manual-review alerts are written to D1 and exposed via:

```text
GET /ops/alerts?token=<OPS_ALERT_TOKEN>
```

Cancellations are recorded here too, with reason `verification_cancelled:<abort reason>`.

To immediately re-check every pending job against live Shopify state and cancel any
whose order is no longer verifiable (sends no email):

```bash
curl -X POST "https://<your-worker-domain>/jobs/reconcile?token=<OPS_ALERT_TOKEN>"
```

## Notes

- This is the highest practical reliability at zero cost, not a formal 100% SLA.
- Webhooks are acked quickly and processed via queue to reduce timeout risk.
- Idempotency keys prevent duplicate processing for repeated webhooks.
