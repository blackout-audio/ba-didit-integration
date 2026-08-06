# STOP - do not deploy this repo

**This repo does not contain the code that is running in production.**

Deploying from here is blocked on purpose. `wrangler.toml` has been renamed to
`DO-NOT-DEPLOY.wrangler.toml` so that `wrangler deploy` cannot find a config and
fails, and the npm deploy script exits with an error.

## What happened

On 2026-08-05 this repo was deployed over the live Worker. The repo was stale, so
that deploy silently changed production behavior for about 24 hours:

- `FRAUD_TRIGGER_TAG` was reset from `nofraud-review,nofraud-fail` to
  `nofraud-review` only, so orders tagged `nofraud_fail` stopped getting a Didit
  session. Order #1713 was missed because of this.
- The repo captured payment automatically on a Didit pass. The live code never
  did that; it parks the job at `awaiting_shopify_approval` for a human.

Production was rolled back to version `22e82e4e-9304-43f1-ab82-c20a5aaa6b6b`
(uploaded 2026-08-01), which is the last known-good version.

## Proof the repo is not the live code

The live D1 database contains 14+ verification jobs with status
`awaiting_shopify_approval`. That status does not exist anywhere in this
repo's source. There is production behavior here that was never committed.

## Before this repo can be deployed again

1. Recover the real source of version `22e82e4e-9304-43f1-ab82-c20a5aaa6b6b`.
   `wrangler init --from-dash` only returns a scaffold, and an OAuth login cannot
   read script content over the API (error 10405). So either download the code
   from the Cloudflare dashboard, or create an API token with **Workers Scripts:
   Read** and fetch:

   ```bash
   curl -H "Authorization: Bearer <API_TOKEN>" \
     "https://api.cloudflare.com/client/v4/accounts/1cfc83c6c20d80d39534a231188e08d9/workers/scripts/ba-didit-integration/content"
   ```

2. Commit that source, then reconcile it with the fixes already in this repo
   (see git log): cancelled/voided order guard, ops token on `/jobs/*`, and the
   removal of automatic payment capture.

3. Only then rename `DO-NOT-DEPLOY.wrangler.toml` back to `wrangler.toml` and
   restore the deploy scripts in `package.json`.

## Checking production safely

Read-only commands still work by pointing at the renamed config:

```bash
npx wrangler --config DO-NOT-DEPLOY.wrangler.toml deployments status
npx wrangler --config DO-NOT-DEPLOY.wrangler.toml versions view <version-id>
```
