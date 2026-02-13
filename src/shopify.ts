import crypto from "node:crypto";
import { env } from "./config.js";

export function validateShopifyShop(shop: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

export function verifyOauthHmac(query: URLSearchParams): boolean {
  const hmac = query.get("hmac");
  if (!hmac) {
    return false;
  }

  const message = [...query.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const digest = crypto.createHmac("sha256", env.SHOPIFY_API_SECRET).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

export function verifyShopifyWebhook(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  if (!hmacHeader) {
    return false;
  }
  const digest = crypto.createHmac("sha256", env.SHOPIFY_API_SECRET).update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

export function buildShopifyInstallUrl(shop: string, state: string) {
  const redirectUri = `${env.APP_URL}/auth/callback`;
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", env.SHOPIFY_API_KEY);
  url.searchParams.set("scope", env.SHOPIFY_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeAccessToken(params: { shop: string; code: string }) {
  const response = await fetch(`https://${params.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code: params.code
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify token exchange failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { access_token: string; scope?: string };
  if (!data.access_token) {
    throw new Error("Shopify token exchange missing access token");
  }
  return data;
}

export async function registerOrdersUpdatedWebhook(shop: string, accessToken: string) {
  const callbackUrl = `${env.APP_URL}${env.SHOPIFY_WEBHOOK_PATH}`;
  const response = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({
      query: `
        mutation CreateOrdersUpdatedWebhook($callbackUrl: URL!) {
          webhookSubscriptionCreate(
            topic: ORDERS_UPDATED
            webhookSubscription: {callbackUrl: $callbackUrl, format: JSON}
          ) {
            userErrors { field message }
            webhookSubscription { id }
          }
        }
      `,
      variables: { callbackUrl }
    })
  });

  const json = (await response.json()) as any;
  const errors = json?.data?.webhookSubscriptionCreate?.userErrors ?? [];
  if (!response.ok || errors.length > 0) {
    throw new Error(`Shopify webhook registration failed: ${JSON.stringify(errors || json)}`);
  }
}

export async function addOrderTag(shop: string, accessToken: string, orderGidOrLegacyId: string, tag: string) {
  const id = orderGidOrLegacyId.startsWith("gid://")
    ? orderGidOrLegacyId
    : `gid://shopify/Order/${orderGidOrLegacyId}`;

  const response = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({
      query: `
        mutation TagsAdd($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }
      `,
      variables: {
        id,
        tags: [tag]
      }
    })
  });

  const json = (await response.json()) as any;
  const errors = json?.data?.tagsAdd?.userErrors ?? [];
  if (!response.ok || errors.length > 0) {
    throw new Error(`Shopify tagsAdd failed: ${JSON.stringify(errors || json)}`);
  }
}

export async function sendOrderInvoiceEmail(input: {
  shop: string;
  accessToken: string;
  orderGidOrLegacyId: string;
  to: string;
  subject: string;
  customMessage: string;
}) {
  const id = input.orderGidOrLegacyId.startsWith("gid://")
    ? input.orderGidOrLegacyId
    : `gid://shopify/Order/${input.orderGidOrLegacyId}`;

  const response = await fetch(`https://${input.shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": input.accessToken
    },
    body: JSON.stringify({
      query: `
        mutation OrderInvoiceSend($id: ID!, $email: EmailInput) {
          orderInvoiceSend(id: $id, email: $email) {
            order { id }
            userErrors { field message }
          }
        }
      `,
      variables: {
        id,
        email: {
          to: input.to,
          subject: input.subject,
          customMessage: input.customMessage
        }
      }
    })
  });

  const json = (await response.json()) as any;
  const errors = json?.data?.orderInvoiceSend?.userErrors ?? [];
  if (!response.ok || errors.length > 0) {
    throw new Error(`Shopify orderInvoiceSend failed: ${JSON.stringify(errors || json)}`);
  }
}

export async function setOrderVerificationMetafields(input: {
  shop: string;
  accessToken: string;
  orderGidOrLegacyId: string;
  status: string;
  verificationUrl?: string | null;
  sessionId?: string | null;
}) {
  const id = input.orderGidOrLegacyId.startsWith("gid://")
    ? input.orderGidOrLegacyId
    : `gid://shopify/Order/${input.orderGidOrLegacyId}`;

  const namespace = env.FLOW_METAFIELD_NAMESPACE;
  const metafields = [
    {
      ownerId: id,
      namespace,
      key: "verification_status",
      type: "single_line_text_field",
      value: input.status
    },
    {
      ownerId: id,
      namespace,
      key: "verification_url",
      type: "single_line_text_field",
      value: input.verificationUrl ?? ""
    },
    {
      ownerId: id,
      namespace,
      key: "verification_session_id",
      type: "single_line_text_field",
      value: input.sessionId ?? ""
    }
  ];

  const response = await fetch(`https://${input.shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": input.accessToken
    },
    body: JSON.stringify({
      query: `
        mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { key namespace value }
            userErrors { field message code }
          }
        }
      `,
      variables: { metafields }
    })
  });

  const json = (await response.json()) as any;
  const errors = json?.data?.metafieldsSet?.userErrors ?? [];
  if (!response.ok || errors.length > 0) {
    throw new Error(`Shopify metafieldsSet failed: ${JSON.stringify(errors || json)}`);
  }
}
