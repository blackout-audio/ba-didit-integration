import { WorkerEnv } from "./config";
import { hmacSha256Hex, timingSafeEqual } from "./crypto";

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

export class DiditDecisionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Didit decision not found for session ${sessionId}`);
    this.name = "DiditDecisionNotFoundError";
  }
}

let tokenCache: TokenCache | null = null;

export async function createDiditVerificationSession(
  env: WorkerEnv,
  params: { vendorData: string; callback: string; features?: string }
) {
  const response = await createSessionRequest(env, {
    vendorData: params.vendorData,
    callback: params.callback,
    features: params.features ?? env.DIDIT_FEATURES
  });

  if (!response.ok) {
    throw new Error(`Didit create session failed: ${response.status} ${await response.text()}`);
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

export async function retrieveDiditDecision(env: WorkerEnv, sessionId: string): Promise<any> {
  const response = await retrieveDecisionRequest(env, sessionId);
  if (response.status === 404) {
    throw new DiditDecisionNotFoundError(sessionId);
  }
  if (!response.ok) {
    throw new Error(`Didit retrieve decision failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function inspectDiditSessionStatus(
  env: WorkerEnv,
  sessionId: string
): Promise<{ exists: boolean; expired: boolean }> {
  const response = await retrieveDecisionRequest(env, sessionId);
  if (response.status === 404) {
    return { exists: false, expired: false };
  }
  if (!response.ok) {
    throw new Error(`Didit inspect session failed: ${response.status} ${await response.text()}`);
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

export async function verifyDiditWebhookSignature(
  env: WorkerEnv,
  rawBody: Uint8Array,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader) {
    return false;
  }
  const digest = await hmacSha256Hex(env.DIDIT_WEBHOOK_SECRET, rawBody);
  const normalized = signatureHeader.replace(/^sha256=/i, "").trim();
  return timingSafeEqual(digest, normalized);
}

async function getDiditAccessToken(env: WorkerEnv): Promise<string> {
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
    throw new Error(`Didit auth failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in?: number };
  const expiresIn = Number(data.expires_in ?? 300);
  tokenCache = {
    token: data.access_token,
    expiresAtEpochMs: Date.now() + expiresIn * 1000
  };
  return data.access_token;
}

async function createSessionRequest(
  env: WorkerEnv,
  params: { vendorData: string; callback: string; features: string }
) {
  if (env.DIDIT_API_KEY.trim().length > 0) {
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

  const accessToken = await getDiditAccessToken(env);
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

async function retrieveDecisionRequest(env: WorkerEnv, sessionId: string) {
  if (env.DIDIT_API_KEY.trim().length > 0) {
    return fetch(`${env.DIDIT_VERIFY_BASE_URL}/v1/session/${sessionId}/decision/`, {
      method: "GET",
      headers: { "x-api-key": env.DIDIT_API_KEY.trim() }
    });
  }

  const accessToken = await getDiditAccessToken(env);
  return fetch(`${env.DIDIT_VERIFY_BASE_URL}/v3/session/${sessionId}/decision/`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}
