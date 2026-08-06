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

   **The API cannot do this.** All of the following were tested and every one
   returns the *most recently uploaded* script, ignoring the version asked for:

   - `/workers/scripts/{name}/content/v2`
   - `/workers/scripts/{name}/content/v2?version_id={version}`
   - `/workers/services/{name}/environments/production/content/v2`
   - `/workers/scripts/{name}/versions/{version}/content` (returns metadata only)

   `wrangler init --from-dash` returns a blank scaffold, not the real code. An
   API token would not help, because the limitation is the API, not permissions.

   That leaves two options:

   - **Cloudflare dashboard.** Because `22e82e4e` is the currently active
     deployment, the Worker's code view shows it. Copy it out by hand. You get
     the bundled single-file build, not the original tidy TypeScript.
   - **The machine that deployed it.** The Aug 1 upload was made with wrangler by
     `operations@blackoutaudio.com`, and the source is *not* on the workstation
     that holds this repo. If that machine or CI job still has its working copy,
     that is the real source and is far better than the bundle.

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
