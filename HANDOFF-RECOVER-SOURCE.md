# Handoff: recover the live Worker source into this repo

## The one job

Get the source code of Cloudflare Worker version `22e82e4e-9304-43f1-ab82-c20a5aaa6b6b`
out of the Cloudflare dashboard and into this git repo. It must be done through a
browser. Everything else has been tried and ruled out (see "Dead ends").

Save it to repo root as `PRODUCTION-SNAPSHOT.js`, verify it (see "Verification"),
then commit and push. Do not deploy anything.

## Hard rules

1. **Never click Deploy / Save and Deploy** in the Cloudflare code editor. The
   editor may contain a stray pasted file from an earlier manual attempt. If asked
   about unsaved changes, discard them.
2. **Never run `wrangler deploy`** or `npm run worker:deploy`. Deploying from this
   repo is what caused the incident. It is deliberately blocked.
3. **Do not rename `DO-NOT-DEPLOY.wrangler.toml` back to `wrangler.toml`.** That
   rename is the safety block.
4. Production is currently correct. Do not "fix" it. Read-only inspection is fine.

## Facts

| Item | Value |
|---|---|
| Cloudflare account ID | `1cfc83c6c20d80d39534a231188e08d9` |
| Worker name | `ba-didit-integration` |
| Worker URL | https://ba-didit-integration.operations-1cf.workers.dev |
| GOOD version (want this) | `22e82e4e-9304-43f1-ab82-c20a5aaa6b6b`, uploaded 2026-08-01, active since 2026-08-06T17:30Z |
| BAD version 1 | `d506d014-bb2f-4a57-990a-351fdb752463`, 2026-08-05T23:51Z |
| BAD version 2 | `967bbea3-16e4-4e34-83b3-1d33e98ebf13`, 2026-08-06T00:14Z (this is the newest *upload*) |
| Dashboard | https://dash.cloudflare.com/1cfc83c6c20d80d39534a231188e08d9/workers/services/view/ba-didit-integration/production |
| D1 database | `ba-didit-integration-db` / `bdf4a8b0-054e-4a63-9321-5dfa128c97ea` |
| Shopify shop | `3gg0z3-ba.myshopify.com` |
| Git remote | https://github.com/blackout-audio/ba-didit-integration (branch `main`) |

## Why this is needed

This repo has never matched production. On 2026-08-05 the repo was deployed over
the live Worker, which for ~24h (a) reset `FRAUD_TRIGGER_TAG` from
`nofraud-review,nofraud-fail` to review-only, so `nofraud_fail` orders silently got
no identity check, and (b) introduced automatic payment capture on a Didit pass,
which the business forbids. Production was rolled back to `22e82e4e`.

Proof the repo is not the live code: the live D1 database holds 14+
`verification_jobs` rows with status `awaiting_shopify_approval`. That string
appears nowhere in this repo. The live code parks a passed verification for human
approval instead of capturing money.

## Browser steps

1. Open the dashboard URL above.
2. Confirm on the **Deployments** tab that the active version is `22e82e4e`.
3. Open the Worker's code view (**Edit code**, sometimes labelled *Quick edit*).
4. Select all the code and copy it.
5. Write it to `PRODUCTION-SNAPSHOT.js` in the repo root.

Expect roughly 130 KB of bundled, machine-generated JavaScript. That is normal.
It is a build artifact, not the original tidy TypeScript.

If the dashboard code view shows the newest *upload* rather than the active
version, the verification below will catch it. In that case, try opening the
`22e82e4e` entry from the Deployments tab and look for a per-version code view.

## Verification

The saved file is CORRECT only if all of these hold:

- contains `awaiting_shopify_approval`
- does **not** contain `order_cancelled`
- does **not** contain `jobs/reconcile`
- does **not** contain `captureFirstUncapturedPayment`

The last three are markers of the bad 2026-08-06 upload. If any appear, the wrong
version was copied. Stop and report rather than committing it.

```powershell
$t = [System.IO.File]::ReadAllText("PRODUCTION-SNAPSHOT.js")
foreach ($n in @("awaiting_shopify_approval","order_cancelled","jobs/reconcile","captureFirstUncapturedPayment")) {
  "{0,-32} {1}" -f $n, ([regex]::Matches($t,[regex]::Escape($n))).Count
}
```

## After it is saved and verified

```bash
git add PRODUCTION-SNAPSHOT.js
git commit -m "chore: add snapshot of live Worker version 22e82e4e"
git push origin main
```

Then the real follow-up work, which is a separate task: read the snapshot to
recover the `awaiting_shopify_approval` flow, port it back into `workers/src/`,
reconcile it with the fixes already committed here (cancelled/voided order guard,
ops token on `/jobs/*`, removal of automatic capture), and only then lift the
deploy block described in `DEPLOYING.md`.

## Dead ends - do not retry these

- `GET /workers/scripts/{name}/content/v2` - returns newest upload, not the active version
- same with `?version_id=22e82e4e...` - the parameter is ignored
- `GET /workers/services/{name}/environments/production/content/v2` - same, ignored
- `GET /workers/scripts/{name}/versions/{v}/content` - returns metadata JSON, no code
- `GET /workers/scripts/{name}/versions/{v}?include_modules=true` - metadata only
- `GET /workers/scripts/{name}/content` (v1) - rejects the wrangler OAuth login, error 10405
- `wrangler init --from-dash ba-didit-integration` - produces an empty scaffold
- Searching the workstation - the only copy of this project on disk is this stale
  repo. The Aug 1 deploy came from another machine or CI.

A Cloudflare API token would not help. The limitation is the API itself: it has no
route that returns an older version's code.

## Useful read-only commands

The wrangler config was renamed, so pass it explicitly:

```bash
npx wrangler --config DO-NOT-DEPLOY.wrangler.toml deployments status
npx wrangler --config DO-NOT-DEPLOY.wrangler.toml versions view 22e82e4e-9304-43f1-ab82-c20a5aaa6b6b
npx wrangler d1 execute ba-didit-integration-db --remote --command "SELECT id, order_id, status FROM verification_jobs ORDER BY id DESC LIMIT 10;"
```
