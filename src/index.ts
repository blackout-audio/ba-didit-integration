import crypto from "node:crypto";
import cron from "node-cron";
import express from "express";
import { env } from "./config.js";
import { initDb, upsertShopAccessToken } from "./db.js";
import { verifyDiditWebhookSignature } from "./didit.js";
import { registerOrdersUpdatedWebhook, buildShopifyInstallUrl, exchangeAccessToken, validateShopifyShop, verifyOauthHmac, verifyShopifyWebhook } from "./shopify.js";
import { handleDiditDecisionUpdate, handleRiskyOrder, processRetryQueue } from "./workflow.js";

const app = express();
const oauthStateByShop = new Map<string, string>();

app.use("/webhooks", express.raw({ type: "*/*" }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).send("Shopify + Didit integration app is running");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/auth", (req, res) => {
  const shop = String(req.query.shop ?? "");
  if (!validateShopifyShop(shop)) {
    return res.status(400).send("Invalid shop");
  }

  const state = crypto.randomBytes(16).toString("hex");
  oauthStateByShop.set(shop, state);
  return res.redirect(buildShopifyInstallUrl(shop, state));
});

app.get("/auth/callback", async (req, res) => {
  try {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const shop = params.get("shop") ?? "";
    const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";
    const expectedState = oauthStateByShop.get(shop);

    if (!validateShopifyShop(shop)) {
      return res.status(400).send("Invalid shop");
    }
    if (!verifyOauthHmac(params)) {
      return res.status(401).send("Invalid HMAC");
    }
    if (!code || !state || !expectedState || state !== expectedState) {
      return res.status(401).send("Invalid OAuth state");
    }

    const tokenData = await exchangeAccessToken({ shop, code });
    await upsertShopAccessToken(shop, tokenData.access_token);
    await registerOrdersUpdatedWebhook(shop, tokenData.access_token);
    oauthStateByShop.delete(shop);

    return res.status(200).send(`App installed for ${shop}. Orders webhook configured.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected auth callback error";
    return res.status(500).send(message);
  }
});

app.post(env.SHOPIFY_WEBHOOK_PATH, async (req, res) => {
  const rawBody = req.body as Buffer;
  const hmacHeader = req.header("x-shopify-hmac-sha256");
  const shop = req.header("x-shopify-shop-domain");

  if (!verifyShopifyWebhook(rawBody, hmacHeader ?? undefined)) {
    return res.status(401).send("Invalid webhook signature");
  }
  if (!shop || !validateShopifyShop(shop)) {
    return res.status(400).send("Invalid shop domain");
  }

  try {
    const order = JSON.parse(rawBody.toString("utf8"));
    const result = await handleRiskyOrder(shop, order);
    console.info("orders/updated webhook processed", {
      shop,
      orderId: order?.id ?? null,
      tags: order?.tags ?? "",
      triggerTag: env.FRAUD_TRIGGER_TAG,
      result
    });
    return res.status(200).send("ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected webhook error";
    return res.status(500).send(message);
  }
});

app.post("/webhooks/didit", async (req, res) => {
  const rawBody = req.body as Buffer;
  const signatureHeader = req.header("x-signature") ?? undefined;

  if (!verifyDiditWebhookSignature(rawBody, signatureHeader)) {
    return res.status(401).send("Invalid Didit signature");
  }

  try {
    const payload = JSON.parse(rawBody.toString("utf8")) as any;
    const sessionId =
      payload?.session_id ??
      payload?.sessionId ??
      payload?.data?.session_id ??
      payload?.data?.sessionId;

    if (!sessionId) {
      return res.status(400).send("Missing session_id");
    }

    await handleDiditDecisionUpdate(String(sessionId));
    return res.status(200).send("ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected Didit webhook error";
    return res.status(500).send(message);
  }
});

app.post("/jobs/retry/run", async (_req, res) => {
  try {
    await processRetryQueue();
    return res.status(200).json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retry runner failed";
    return res.status(500).json({ ok: false, error: message });
  }
});

async function bootstrap() {
  await initDb();

  cron.schedule("0 * * * *", async () => {
    try {
      await processRetryQueue();
    } catch (error) {
      console.error("Retry processing failed", error);
    }
  });

  app.listen(env.PORT, () => {
    console.log(`Shopify + Didit app listening on port ${env.PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
