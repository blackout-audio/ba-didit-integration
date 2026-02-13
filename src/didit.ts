import crypto from "node:crypto";
import { env } from "./config.js";

interface TokenCache {
  token: string;
  expiresAtEpochMs: number;
}

interface DiditCreateSessionResponse {
  session_id: string;
  session_token?: string;
  url: string;
  status?: string;
}

let tokenCache: TokenCache | null = null;

export async function createDiditVerificationSession(params: {
  vendorData: string;
  callback: string;
  features?: string;
}) {
  const response = await createSessionRequest({
    vendorData: params.vendorData,
    callback: params.callback,
    features: params.features ?? env.DIDIT_FEATURES
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Didit create session failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as DiditCreateSessionResponse;
  if (!data.session_id || !data.url) {
    throw new Error("Didit create session response missing required fields");
  }

  return {
    sessionId: data.session_id,
    sessionToken: data.session_token ?? null,
    verificationUrl: data.url,
    status: data.status ?? "unknown"
  };
}

export async function retrieveDiditDecision(sessionId: string) {
  const response = await retrieveDecisionRequest(sessionId);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Didit retrieve decision failed: ${response.status} ${body}`);
  }

  return await response.json();
}

export async function inspectDiditSessionStatus(sessionId: string): Promise<{
  exists: boolean;
  expired: boolean;
}> {
  const response = await retrieveDecisionRequest(sessionId);

  if (response.status === 404) {
    return { exists: false, expired: false };
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Didit inspect session failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as any;
  const candidates = [
    payload?.status,
    payload?.decision,
    payload?.result?.status,
    payload?.result?.decision,
    payload?.summary?.status,
    payload?.summary?.decision
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  const expired = candidates.some((value) =>
    ["expired", "deleted", "cancelled", "canceled", "timeout", "timed_out"].includes(value)
  );

  return { exists: true, expired };
}

export function verifyDiditWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) {
    return false;
  }

  const digest = crypto.createHmac("sha256", env.DIDIT_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const normalized = signatureHeader.replace(/^sha256=/i, "").trim();

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(normalized));
  } catch {
    return false;
  }
}

async function getDiditAccessToken() {
  if (env.DIDIT_API_KEY.trim().length > 0) {
    return env.DIDIT_API_KEY.trim();
  }

  if (tokenCache && tokenCache.expiresAtEpochMs > Date.now() + 30_000) {
    return tokenCache.token;
  }

  const response = await fetch(`${env.DIDIT_AUTH_BASE_URL}/auth/v2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.DIDIT_CLIENT_ID,
      client_secret: env.DIDIT_CLIENT_SECRET
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Didit auth failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Didit auth response missing access_token");
  }

  const expiresIn = Number(data.expires_in ?? 300);
  tokenCache = {
    token: data.access_token,
    expiresAtEpochMs: Date.now() + expiresIn * 1000
  };

  return data.access_token;
}

async function createSessionRequest(params: {
  vendorData: string;
  callback: string;
  features: string;
}) {
  if (env.DIDIT_API_KEY.trim().length > 0) {
    console.info("Didit create session mode", { mode: "api_key", endpoint: "/v1/session/" });
    return fetch(`${env.DIDIT_VERIFY_BASE_URL}/v1/session/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.DIDIT_API_KEY.trim()
      },
      body: JSON.stringify({
        vendor_data: params.vendorData,
        callback: params.callback,
        features: params.features
      })
    });
  }

  const accessToken = await getDiditAccessToken();
  console.info("Didit create session mode", { mode: "oauth_token", endpoint: "/v3/session/" });
  return fetch(`${env.DIDIT_VERIFY_BASE_URL}/v3/session/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      vendor_data: params.vendorData,
      callback: params.callback,
      features: params.features
    })
  });
}

async function retrieveDecisionRequest(sessionId: string) {
  if (env.DIDIT_API_KEY.trim().length > 0) {
    return fetch(`${env.DIDIT_VERIFY_BASE_URL}/v1/session/${sessionId}/decision/`, {
      method: "GET",
      headers: {
        "x-api-key": env.DIDIT_API_KEY.trim()
      }
    });
  }

  const accessToken = await getDiditAccessToken();
  return fetch(`${env.DIDIT_VERIFY_BASE_URL}/v3/session/${sessionId}/decision/`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}
