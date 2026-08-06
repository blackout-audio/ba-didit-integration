import { WorkerEnv } from "./config";
import { consumeOauthState, listOpsAlerts, saveOauthState, upsertShopAccessToken, upsertWebhookEvent } from "./db";
import { verifyDiditWebhookSignature } from "./didit";
import { randomHex, sha256Hex } from "./crypto";
import {
  QueueJob,
  enqueueRetryForDueJobs,
  handleDiditDecisionEvent,
  handleRiskyOrderEvent,
  processRetryJob,
  reconcilePendingJobsWithShopify
} from "./workflow";
import {
  buildShopifyInstallUrl,
  exchangeAccessToken,
  registerOrdersUpdatedWebhook,
  validateShopifyShop,
  verifyOauthHmac,
  verifyShopifyWebhook
} from "./shopify";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8"
};

const app: ExportedHandler<WorkerEnv, QueueJob> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ ok: true, runtime: "cloudflare-worker" }, { headers: jsonHeaders });
    }

    if (request.method === "GET" && pathname === "/auth") {
      return handleAuthInstall(request, env);
    }

    if (request.method === "GET" && pathname === "/auth/callback") {
      return handleAuthCallback(request, env);
    }

    if (request.method === "POST" && pathname === env.SHOPIFY_WEBHOOK_PATH) {
      return handleShopifyWebhook(request, env);
    }

    if (request.method === "POST" && (pathname === "/webhooks/didit" || pathname === "/didit/callback")) {
      return handleDiditWebhook(request, env);
    }

    if (request.method === "POST" && pathname === "/jobs/retry/run") {
      if (!isAuthorizedOpsRequest(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const enqueued = await enqueueRetryForDueJobs(env);
      return Response.json({ ok: true, enqueued }, { headers: jsonHeaders });
    }

    if (request.method === "POST" && pathname === "/jobs/reconcile") {
      if (!isAuthorizedOpsRequest(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const summary = await reconcilePendingJobsWithShopify(env);
      return Response.json({ ok: true, ...summary }, { headers: jsonHeaders });
    }

    if (request.method === "GET" && pathname === "/ops/alerts") {
      return handleOpsAlerts(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      const payload = message.body;
      try {
        if (payload.type === "process_shopify_order") {
          await handleRiskyOrderEvent(env, payload.shop, payload.order);
        } else if (payload.type === "process_didit_decision") {
          await handleDiditDecisionEvent(env, payload.sessionId);
        } else if (payload.type === "process_retry_job") {
          await processRetryJob(env, payload.jobId);
        }
      } catch (error) {
        console.error("Queue message failed", { payload, error });
        message.retry();
      }
    }
  },

  async scheduled(_event, env): Promise<void> {
    const enqueued = await enqueueRetryForDueJobs(env);
    console.info("Retry scan complete", { enqueued });
  }
};

async function handleAuthInstall(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const shop = String(url.searchParams.get("shop") ?? "");
  if (!validateShopifyShop(shop)) {
    return new Response("Invalid shop", { status: 400 });
  }

  const state = randomHex(16);
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await saveOauthState(env, shop, state, expiresAt);

  return Response.redirect(buildShopifyInstallUrl(env, shop, state), 302);
}

async function handleAuthCallback(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;
    const shop = params.get("shop") ?? "";
    const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";
    if (!validateShopifyShop(shop)) {
      return new Response("Invalid shop", { status: 400 });
    }
    if (!(await verifyOauthHmac(env, params))) {
      return new Response("Invalid HMAC", { status: 401 });
    }

    const expectedState = await consumeOauthState(env, shop);
    if (!code || !state || !expectedState || state !== expectedState) {
      return new Response("Invalid OAuth state", { status: 401 });
    }

    const tokenData = await exchangeAccessToken(env, { shop, code });
    await upsertShopAccessToken(env, shop, tokenData.access_token);
    await registerOrdersUpdatedWebhook(env, shop, tokenData.access_token);
    return new Response(`App installed for ${shop}. Orders webhook configured.`, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected auth callback error";
    return new Response(message, { status: 500 });
  }
}

async function handleShopifyWebhook(request: Request, env: WorkerEnv): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const shop = request.headers.get("x-shopify-shop-domain");
  const webhookId = request.headers.get("x-shopify-webhook-id");

  if (!(await verifyShopifyWebhook(env, rawBody, hmacHeader))) {
    return new Response("Invalid webhook signature", { status: 401 });
  }
  if (!shop || !validateShopifyShop(shop)) {
    return new Response("Invalid shop domain", { status: 400 });
  }

  const payloadText = new TextDecoder().decode(rawBody);
  const order = parseJson<{
    id?: string | number;
    tags?: string;
    updated_at?: string;
  }>(payloadText);
  if (!order || order.id === undefined) {
    return new Response("Invalid order payload", { status: 400 });
  }

  const dedupeKey =
    webhookId ??
    (await sha256Hex(`shopify:${shop}:${String(order.id)}:${order.tags ?? ""}:${order.updated_at ?? ""}`));

  const inserted = await upsertWebhookEvent(env, "shopify_orders_updated", dedupeKey);
  if (!inserted) {
    return new Response("ok", { status: 200 });
  }

  await env.DIDIT_JOBS.send({
    type: "process_shopify_order",
    shop,
    order
  } as QueueJob);

  return new Response("ok", { status: 200 });
}

async function handleDiditWebhook(request: Request, env: WorkerEnv): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const signatureHeader = request.headers.get("x-signature");
  if (!(await verifyDiditWebhookSignature(env, rawBody, signatureHeader))) {
    return new Response("Invalid Didit signature", { status: 401 });
  }

  const payloadText = new TextDecoder().decode(rawBody);
  const payload = parseJson<any>(payloadText);
  if (!payload) {
    return new Response("Invalid Didit payload", { status: 400 });
  }

  const sessionId =
    payload?.session_id ?? payload?.sessionId ?? payload?.data?.session_id ?? payload?.data?.sessionId;
  if (!sessionId) {
    return new Response("Missing session_id", { status: 400 });
  }

  const dedupeKey = await sha256Hex(`didit:${payloadText}`);
  const inserted = await upsertWebhookEvent(env, "didit_decision_update", dedupeKey);
  if (!inserted) {
    return new Response("ok", { status: 200 });
  }

  await env.DIDIT_JOBS.send({
    type: "process_didit_decision",
    sessionId: String(sessionId)
  } as QueueJob);

  return new Response("ok", { status: 200 });
}

async function handleOpsAlerts(request: Request, env: WorkerEnv): Promise<Response> {
  if (!isAuthorizedOpsRequest(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const alerts = await listOpsAlerts(env, 100);
  return Response.json({ alerts }, { headers: jsonHeaders });
}

function isAuthorizedOpsRequest(request: Request, env: WorkerEnv): boolean {
  const token = new URL(request.url).searchParams.get("token");
  return Boolean(env.OPS_ALERT_TOKEN) && token === env.OPS_ALERT_TOKEN;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export default app;
