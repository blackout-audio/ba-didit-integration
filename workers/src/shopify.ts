import { WorkerEnv } from "./config";
import { hmacSha256Base64, hmacSha256Hex, timingSafeEqual } from "./crypto";

export function validateShopifyShop(shop: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

export async function verifyOauthHmac(env: WorkerEnv, query: URLSearchParams): Promise<boolean> {
  const hmac = query.get("hmac");
  if (!hmac) {
    return false;
  }

  const message = [...query.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const digest = await hmacSha256Hex(env.SHOPIFY_API_SECRET, new TextEncoder().encode(message));
  return timingSafeEqual(digest, hmac);
}

export async function verifyShopifyWebhook(
  env: WorkerEnv,
  rawBody: Uint8Array,
  hmacHeader: string | null
): Promise<boolean> {
  if (!hmacHeader) {
    return false;
  }
  const digest = await hmacSha256Base64(env.SHOPIFY_API_SECRET, rawBody);
  return timingSafeEqual(digest, hmacHeader);
}

export function buildShopifyInstallUrl(env: WorkerEnv, shop: string, state: string) {
  const redirectUri = `${env.APP_URL}/auth/callback`;
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", env.SHOPIFY_API_KEY);
  url.searchParams.set("scope", env.SHOPIFY_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeAccessToken(env: WorkerEnv, params: { shop: string; code: string }) {
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
    throw new Error(`Shopify token exchange failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { access_token: string };
  if (!data.access_token) {
    throw new Error("Shopify token exchange missing access token");
  }
  return data;
}

export async function registerOrdersUpdatedWebhook(env: WorkerEnv, shop: string, accessToken: string) {
  const callbackUrl = `${env.APP_URL}${env.SHOPIFY_WEBHOOK_PATH}`;
  const response = await shopifyGraphql(env, shop, accessToken, {
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
  });

  const errors = response?.data?.webhookSubscriptionCreate?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(`Shopify webhook registration failed: ${JSON.stringify(errors)}`);
  }
}

export async function addOrderTag(
  env: WorkerEnv,
  shop: string,
  accessToken: string,
  orderGidOrLegacyId: string,
  tag: string
) {
  const id = orderGidOrLegacyId.startsWith("gid://")
    ? orderGidOrLegacyId
    : `gid://shopify/Order/${orderGidOrLegacyId}`;
  const response = await shopifyGraphql(env, shop, accessToken, {
    query: `
      mutation TagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }
    `,
    variables: { id, tags: [tag] }
  });

  const errors = response?.data?.tagsAdd?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(`Shopify tagsAdd failed: ${JSON.stringify(errors)}`);
  }
}

export async function removeOrderTag(
  env: WorkerEnv,
  shop: string,
  accessToken: string,
  orderGidOrLegacyId: string,
  tag: string
) {
  const id = orderGidOrLegacyId.startsWith("gid://")
    ? orderGidOrLegacyId
    : `gid://shopify/Order/${orderGidOrLegacyId}`;
  const response = await shopifyGraphql(env, shop, accessToken, {
    query: `
      mutation TagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }
    `,
    variables: { id, tags: [tag] }
  });

  const errors = response?.data?.tagsRemove?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(`Shopify tagsRemove failed: ${JSON.stringify(errors)}`);
  }
}

export async function setOrderVerificationMetafields(
  env: WorkerEnv,
  input: {
    shop: string;
    accessToken: string;
    orderGidOrLegacyId: string;
    status: string;
    verificationUrl?: string | null;
    sessionId?: string | null;
  }
) {
  const id = input.orderGidOrLegacyId.startsWith("gid://")
    ? input.orderGidOrLegacyId
    : `gid://shopify/Order/${input.orderGidOrLegacyId}`;

  const metafields = [
    {
      ownerId: id,
      namespace: env.FLOW_METAFIELD_NAMESPACE,
      key: "verification_status",
      type: "single_line_text_field",
      value: input.status
    },
    {
      ownerId: id,
      namespace: env.FLOW_METAFIELD_NAMESPACE,
      key: "verification_url",
      type: "single_line_text_field",
      value: input.verificationUrl ?? ""
    },
    {
      ownerId: id,
      namespace: env.FLOW_METAFIELD_NAMESPACE,
      key: "verification_session_id",
      type: "single_line_text_field",
      value: input.sessionId ?? ""
    }
  ];

  const response = await shopifyGraphql(env, input.shop, input.accessToken, {
    query: `
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key namespace value }
          userErrors { field message code }
        }
      }
    `,
    variables: { metafields }
  });

  const errors = response?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(`Shopify metafieldsSet failed: ${JSON.stringify(errors)}`);
  }
}

export async function captureFirstUncapturedPayment(
  env: WorkerEnv,
  shop: string,
  accessToken: string,
  orderLegacyId: string
): Promise<{ captured: boolean; captureTransactionId?: string; amount?: string }> {
  const listResponse = await fetch(
    `https://${shop}/admin/api/2025-10/orders/${encodeURIComponent(orderLegacyId)}/transactions.json`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken
      }
    }
  );
  const listData = (await listResponse.json()) as { transactions?: any[] };
  if (!listResponse.ok) {
    throw new Error(`Shopify transactions list failed: ${listResponse.status} ${JSON.stringify(listData)}`);
  }

  const transactions = listData.transactions ?? [];
  const capturedByParent = new Map<number, number>();
  const voidedParents = new Set<number>();

  for (const tx of transactions) {
    const parentId = Number(tx?.parent_id);
    if (!Number.isFinite(parentId)) {
      continue;
    }
    const status = String(tx?.status ?? "").toLowerCase();
    const kind = String(tx?.kind ?? "").toLowerCase();
    if (status === "success" && kind === "capture") {
      const amount = Number(tx?.amount ?? 0);
      capturedByParent.set(parentId, (capturedByParent.get(parentId) ?? 0) + (Number.isFinite(amount) ? amount : 0));
    }
    if (status === "success" && kind === "void") {
      voidedParents.add(parentId);
    }
  }

  for (const tx of transactions) {
    const kind = String(tx?.kind ?? "").toLowerCase();
    const status = String(tx?.status ?? "").toLowerCase();
    if (kind !== "authorization" || status !== "success") {
      continue;
    }

    const authId = Number(tx?.id);
    if (!Number.isFinite(authId) || voidedParents.has(authId)) {
      continue;
    }

    const authAmount = Number(tx?.amount ?? 0);
    const capturedAmount = capturedByParent.get(authId) ?? 0;
    const remaining = authAmount - capturedAmount;
    if (!(remaining > 0.0001)) {
      continue;
    }

    const captureAmount = remaining.toFixed(2);
    const capturePayload = {
      transaction: {
        kind: "capture",
        parent_id: authId,
        amount: captureAmount,
        currency: tx?.currency ?? undefined
      }
    };

    const captureResponse = await fetch(
      `https://${shop}/admin/api/2025-10/orders/${encodeURIComponent(orderLegacyId)}/transactions.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken
        },
        body: JSON.stringify(capturePayload)
      }
    );
    const captureData = (await captureResponse.json()) as { transaction?: { id?: number; amount?: string }; errors?: unknown };
    if (!captureResponse.ok) {
      throw new Error(`Shopify capture failed: ${captureResponse.status} ${JSON.stringify(captureData)}`);
    }

    return {
      captured: true,
      captureTransactionId: captureData.transaction?.id ? String(captureData.transaction.id) : undefined,
      amount: captureData.transaction?.amount ?? captureAmount
    };
  }

  return { captured: false };
}

async function shopifyGraphql(env: WorkerEnv, shop: string, accessToken: string, body: Record<string, unknown>) {
  const response = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Shopify GraphQL request failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data as any;
}
