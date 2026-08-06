var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// workers/src/db.ts
async function upsertShopAccessToken(env, shop, accessToken) {
  await env.DIDIT_DB.prepare(
    `
      INSERT INTO shops (shop, access_token, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(shop) DO UPDATE SET
        access_token = excluded.access_token,
        updated_at = datetime('now')
    `
  ).bind(shop, accessToken).run();
}
__name(upsertShopAccessToken, "upsertShopAccessToken");
async function getShopAccessToken(env, shop) {
  const row = await env.DIDIT_DB.prepare(`SELECT access_token FROM shops WHERE shop = ?`).bind(shop).first();
  return row?.access_token ?? null;
}
__name(getShopAccessToken, "getShopAccessToken");
async function saveOauthState(env, shop, state, expiresAt) {
  await env.DIDIT_DB.prepare(
    `
      INSERT INTO oauth_states(shop, state, expires_at, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(shop) DO UPDATE SET
        state = excluded.state,
        expires_at = excluded.expires_at,
        created_at = datetime('now')
    `
  ).bind(shop, state, expiresAt).run();
}
__name(saveOauthState, "saveOauthState");
async function consumeOauthState(env, shop) {
  const row = await env.DIDIT_DB.prepare(`SELECT state, expires_at FROM oauth_states WHERE shop = ?`).bind(shop).first();
  await env.DIDIT_DB.prepare(`DELETE FROM oauth_states WHERE shop = ?`).bind(shop).run();
  if (!row) {
    return null;
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    return null;
  }
  return row.state;
}
__name(consumeOauthState, "consumeOauthState");
async function getJobByOrder(env, shop, orderId) {
  const row = await env.DIDIT_DB.prepare(`SELECT * FROM verification_jobs WHERE shop = ? AND order_id = ?`).bind(shop, orderId).first();
  return mapJob(row);
}
__name(getJobByOrder, "getJobByOrder");
async function getJobBySessionId(env, sessionId) {
  const row = await env.DIDIT_DB.prepare(`SELECT * FROM verification_jobs WHERE didit_session_id = ?`).bind(sessionId).first();
  return mapJob(row);
}
__name(getJobBySessionId, "getJobBySessionId");
async function getJobById(env, id) {
  const row = await env.DIDIT_DB.prepare(`SELECT * FROM verification_jobs WHERE id = ?`).bind(id).first();
  return mapJob(row);
}
__name(getJobById, "getJobById");
async function tryInsertProvisioningJob(env, input) {
  const result = await env.DIDIT_DB.prepare(
    `
      INSERT INTO verification_jobs (
        shop, order_id, vendor_data_base, customer_email, customer_id,
        didit_session_id, didit_session_token, didit_verification_url,
        status, followup_count, next_attempt_at, last_email_sent_at,
        locked_until, attempt_count, last_error, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'provisioning', NULL, '', 'provisioning', 0, NULL, NULL, NULL, 0, NULL, datetime('now'), datetime('now'))
      ON CONFLICT(shop, order_id) DO NOTHING
    `
  ).bind(input.shop, input.orderId, input.vendorDataBase, input.customerEmail, input.customerId).run();
  if (Number(result.meta.changes ?? 0) === 0) {
    return null;
  }
  return Number(result.meta.last_row_id);
}
__name(tryInsertProvisioningJob, "tryInsertProvisioningJob");
async function deleteVerificationJob(env, id) {
  await env.DIDIT_DB.prepare(`DELETE FROM verification_jobs WHERE id = ?`).bind(id).run();
}
__name(deleteVerificationJob, "deleteVerificationJob");
async function updateJobWithNewSession(env, input) {
  await env.DIDIT_DB.prepare(
    `
      UPDATE verification_jobs
      SET didit_session_id = ?,
          didit_session_token = ?,
          didit_verification_url = ?,
          vendor_data_base = COALESCE(?, vendor_data_base),
          status = COALESCE(?, status),
          followup_count = ?,
          next_attempt_at = ?,
          last_email_sent_at = datetime('now'),
          locked_until = NULL,
          attempt_count = 0,
          last_error = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `
  ).bind(
    input.diditSessionId,
    input.diditSessionToken,
    input.diditVerificationUrl,
    input.vendorDataBase ?? null,
    input.status ?? null,
    input.followupCount,
    input.nextAttemptAt,
    input.id
  ).run();
}
__name(updateJobWithNewSession, "updateJobWithNewSession");
async function markJobStatus(env, id, status) {
  await env.DIDIT_DB.prepare(
    `
      UPDATE verification_jobs
      SET status = ?, next_attempt_at = NULL, locked_until = NULL, updated_at = datetime('now')
      WHERE id = ?
    `
  ).bind(status, id).run();
}
__name(markJobStatus, "markJobStatus");
async function getDueRetries(env, nowIso) {
  const rows = await env.DIDIT_DB.prepare(
    `
      SELECT * FROM verification_jobs
      WHERE status = 'awaiting_verification'
        AND next_attempt_at IS NOT NULL
        AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
      LIMIT 100
    `
  ).bind(nowIso).all();
  return rows.results.map(mapJob).filter((job) => Boolean(job));
}
__name(getDueRetries, "getDueRetries");
async function lockJob(env, id, nowIso, lockUntilIso) {
  const result = await env.DIDIT_DB.prepare(
    `
      UPDATE verification_jobs
      SET locked_until = ?, updated_at = datetime('now')
      WHERE id = ?
        AND (locked_until IS NULL OR locked_until <= ?)
    `
  ).bind(lockUntilIso, id, nowIso).run();
  return Number(result.meta.changes ?? 0) > 0;
}
__name(lockJob, "lockJob");
async function setJobProcessingError(env, id, message, unlockAtIso) {
  await env.DIDIT_DB.prepare(
    `
      UPDATE verification_jobs
      SET attempt_count = attempt_count + 1,
          last_error = ?,
          locked_until = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `
  ).bind(message, unlockAtIso, id).run();
}
__name(setJobProcessingError, "setJobProcessingError");
async function upsertWebhookEvent(env, eventType, dedupeKey) {
  const result = await env.DIDIT_DB.prepare(
    `
      INSERT INTO webhook_events(event_type, dedupe_key, created_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(dedupe_key) DO NOTHING
    `
  ).bind(eventType, dedupeKey).run();
  return Number(result.meta.changes ?? 0) > 0;
}
__name(upsertWebhookEvent, "upsertWebhookEvent");
async function getOrderTagSnapshot(env, shop, orderId) {
  const row = await env.DIDIT_DB.prepare(`SELECT tags FROM order_tag_snapshots WHERE shop = ? AND order_id = ?`).bind(shop, orderId).first();
  return row?.tags ?? null;
}
__name(getOrderTagSnapshot, "getOrderTagSnapshot");
async function upsertOrderTagSnapshot(env, shop, orderId, tags) {
  await env.DIDIT_DB.prepare(
    `
      INSERT INTO order_tag_snapshots(shop, order_id, tags, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(shop, order_id) DO UPDATE SET
        tags = excluded.tags,
        updated_at = datetime('now')
    `
  ).bind(shop, orderId, tags).run();
}
__name(upsertOrderTagSnapshot, "upsertOrderTagSnapshot");
async function recordOpsAlert(env, input) {
  await env.DIDIT_DB.prepare(
    `
      INSERT INTO ops_alerts(shop, order_id, customer_email, didit_session_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `
  ).bind(input.shop, input.orderId, input.customerEmail, input.diditSessionId, input.reason).run();
}
__name(recordOpsAlert, "recordOpsAlert");
async function listOpsAlerts(env, limit = 100) {
  const rows = await env.DIDIT_DB.prepare(
    `
      SELECT id, shop, order_id, customer_email, didit_session_id, reason, created_at
      FROM ops_alerts
      ORDER BY id DESC
      LIMIT ?
    `
  ).bind(limit).all();
  return rows.results;
}
__name(listOpsAlerts, "listOpsAlerts");
async function hasEmailEvent(env, eventKey) {
  const row = await env.DIDIT_DB.prepare(`SELECT id FROM email_events WHERE event_key = ?`).bind(eventKey).first();
  return Boolean(row?.id);
}
__name(hasEmailEvent, "hasEmailEvent");
async function recordEmailEvent(env, eventKey, recipient, subject) {
  await env.DIDIT_DB.prepare(
    `
      INSERT INTO email_events(event_key, recipient, subject, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(event_key) DO NOTHING
    `
  ).bind(eventKey, recipient, subject).run();
}
__name(recordEmailEvent, "recordEmailEvent");
function mapJob(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    shop: String(row.shop),
    orderId: String(row.order_id),
    vendorDataBase: row.vendor_data_base ? String(row.vendor_data_base) : null,
    customerEmail: String(row.customer_email),
    customerId: row.customer_id ? String(row.customer_id) : null,
    diditSessionId: String(row.didit_session_id),
    diditSessionToken: row.didit_session_token ? String(row.didit_session_token) : null,
    diditVerificationUrl: String(row.didit_verification_url),
    status: row.status,
    followupCount: Number(row.followup_count),
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
    lastEmailSentAt: row.last_email_sent_at ? String(row.last_email_sent_at) : null,
    lockedUntil: row.locked_until ? String(row.locked_until) : null,
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
__name(mapJob, "mapJob");

// workers/src/crypto.ts
var encoder = new TextEncoder();
async function hmacSha256Hex(secret, payload) {
  const signature = await hmacSha256(secret, payload);
  return bytesToHex(signature);
}
__name(hmacSha256Hex, "hmacSha256Hex");
async function hmacSha256Base64(secret, payload) {
  const signature = await hmacSha256(secret, payload);
  return bytesToBase64(signature);
}
__name(hmacSha256Base64, "hmacSha256Base64");
function timingSafeEqual(a, b) {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < aBytes.length; i += 1) {
    mismatch |= aBytes[i] ^ bBytes[i];
  }
  return mismatch === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return bytesToHex(values);
}
__name(randomHex, "randomHex");
async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}
__name(sha256Hex, "sha256Hex");
async function hmacSha256(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const payloadBuffer = new Uint8Array(payload).buffer;
  const signature = await crypto.subtle.sign("HMAC", key, payloadBuffer);
  return new Uint8Array(signature);
}
__name(hmacSha256, "hmacSha256");
function bytesToHex(bytes) {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
}
__name(bytesToHex, "bytesToHex");
function bytesToBase64(bytes) {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}
__name(bytesToBase64, "bytesToBase64");

// workers/src/didit.ts
var DiditDecisionNotFoundError = class extends Error {
  static {
    __name(this, "DiditDecisionNotFoundError");
  }
  constructor(sessionId) {
    super(`Didit decision not found for session ${sessionId}`);
    this.name = "DiditDecisionNotFoundError";
  }
};
var tokenCache = null;
async function createDiditVerificationSession(env, params) {
  const response = await createSessionRequest(env, {
    vendorData: params.vendorData,
    callback: params.callback,
    features: params.features ?? env.DIDIT_FEATURES
  });
  if (!response.ok) {
    throw new Error(`Didit create session failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
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
__name(createDiditVerificationSession, "createDiditVerificationSession");
async function retrieveDiditDecision(env, sessionId) {
  const response = await retrieveDecisionRequest(env, sessionId);
  if (response.status === 404) {
    throw new DiditDecisionNotFoundError(sessionId);
  }
  if (!response.ok) {
    throw new Error(`Didit retrieve decision failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}
__name(retrieveDiditDecision, "retrieveDiditDecision");
async function inspectDiditSessionStatus(env, sessionId) {
  const response = await retrieveDecisionRequest(env, sessionId);
  if (response.status === 404) {
    return { exists: false, expired: false };
  }
  if (!response.ok) {
    throw new Error(`Didit inspect session failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  const candidates = [
    payload?.status,
    payload?.decision,
    payload?.result?.status,
    payload?.result?.decision,
    payload?.summary?.status,
    payload?.summary?.decision
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  const expired = candidates.some(
    (value) => ["expired", "deleted", "cancelled", "canceled", "timeout", "timed_out"].includes(value)
  );
  return { exists: true, expired };
}
__name(inspectDiditSessionStatus, "inspectDiditSessionStatus");
async function verifyDiditWebhookSignature(env, rawBody, signatureHeader) {
  if (!signatureHeader) {
    return false;
  }
  const digest = await hmacSha256Hex(env.DIDIT_WEBHOOK_SECRET, rawBody);
  const normalized = signatureHeader.replace(/^sha256=/i, "").trim();
  return timingSafeEqual(digest, normalized);
}
__name(verifyDiditWebhookSignature, "verifyDiditWebhookSignature");
async function getDiditAccessToken(env) {
  if (env.DIDIT_API_KEY.trim().length > 0) {
    return env.DIDIT_API_KEY.trim();
  }
  if (tokenCache && tokenCache.expiresAtEpochMs > Date.now() + 3e4) {
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
  const data = await response.json();
  const expiresIn = Number(data.expires_in ?? 300);
  tokenCache = {
    token: data.access_token,
    expiresAtEpochMs: Date.now() + expiresIn * 1e3
  };
  return data.access_token;
}
__name(getDiditAccessToken, "getDiditAccessToken");
async function createSessionRequest(env, params) {
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
__name(createSessionRequest, "createSessionRequest");
async function retrieveDecisionRequest(env, sessionId) {
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
__name(retrieveDecisionRequest, "retrieveDecisionRequest");

// workers/src/fraud.ts
var DEFAULT_VERIFICATION_EXEMPT_GATEWAYS = "interac,e-transfer,etransfer";
var ORDER_CREATION_CUTOFF_ISO = "2026-02-15T00:00:00.000Z";
function isOrderCreatedOnOrAfterCutoff(order) {
  const createdAtMs = Date.parse(order.created_at ?? "");
  const cutoffMs = Date.parse(ORDER_CREATION_CUTOFF_ISO);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(cutoffMs)) {
    return false;
  }
  return createdAtMs >= cutoffMs;
}
__name(isOrderCreatedOnOrAfterCutoff, "isOrderCreatedOnOrAfterCutoff");
function wasTriggerTagAdded(previousTagsCsv, currentTagsCsv, triggerTags) {
  const requiredTags = parseTriggerTags(triggerTags);
  if (requiredTags.length === 0) {
    return false;
  }
  if (previousTagsCsv === null) {
    return false;
  }
  const previous = getNormalizedTagsFromCsv(previousTagsCsv);
  const current = getNormalizedTagsFromCsv(currentTagsCsv ?? "");
  return requiredTags.some((tag) => !previous.includes(tag) && current.includes(tag));
}
__name(wasTriggerTagAdded, "wasTriggerTagAdded");
function shouldSkipFraudVerification(order) {
  const orderTags = getNormalizedOrderTags(order);
  if (orderTags.includes("didit-successfully-verified") || orderTags.includes("verified")) {
    return true;
  }
  if (Boolean(order.cancelled_at) || Boolean(order.closed_at)) {
    return true;
  }
  return false;
}
__name(shouldSkipFraudVerification, "shouldSkipFraudVerification");
function getOrderGateways(order) {
  const names = Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names : [];
  const combined = [...names, order.gateway ?? ""];
  return dedupe(combined.map((value) => String(value ?? "").trim()).filter(Boolean));
}
__name(getOrderGateways, "getOrderGateways");
function isVerificationExemptPayment(gateways, exemptPatternsCsv) {
  const patterns = exemptPatternsCsv.split(",").map((value) => normalizeGateway(value)).filter(Boolean);
  if (patterns.length === 0 || gateways.length === 0) {
    return false;
  }
  return gateways.every((gateway) => {
    const normalized = normalizeGateway(gateway);
    return patterns.some((pattern) => normalized.includes(pattern));
  });
}
__name(isVerificationExemptPayment, "isVerificationExemptPayment");
function normalizeGateway(value) {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}
__name(normalizeGateway, "normalizeGateway");
function dedupe(values) {
  return [...new Set(values)];
}
__name(dedupe, "dedupe");
function getNormalizedOrderTags(order) {
  return getNormalizedTagsFromCsv(order.tags ?? "");
}
__name(getNormalizedOrderTags, "getNormalizedOrderTags");
function getNormalizedTagsFromCsv(tagsCsv) {
  return tagsCsv.split(",").map(normalizeTag).filter(Boolean);
}
__name(getNormalizedTagsFromCsv, "getNormalizedTagsFromCsv");
function normalizeTag(tag) {
  return tag.trim().toLowerCase().replace(/[_\s]+/g, "-");
}
__name(normalizeTag, "normalizeTag");
function parseTriggerTags(triggerTags) {
  return triggerTags.split(",").map(normalizeTag).filter(Boolean);
}
__name(parseTriggerTags, "parseTriggerTags");
function getCustomerEmail(order) {
  return order.email ?? order.customer?.email ?? null;
}
__name(getCustomerEmail, "getCustomerEmail");
function getCustomerName(order) {
  return order.customer?.first_name ?? null;
}
__name(getCustomerName, "getCustomerName");
function getOrderName(order) {
  return order.name ?? `#${order.id}`;
}
__name(getOrderName, "getOrderName");

// workers/src/config.ts
function getRetryDays(env) {
  const parsed = Number(env.RETRY_DAYS || "7");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}
__name(getRetryDays, "getRetryDays");
function getMaxFollowups(env) {
  const parsed = Number(env.MAX_FOLLOWUPS || "2");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}
__name(getMaxFollowups, "getMaxFollowups");
function getVerificationExemptGateways(env) {
  return env.VERIFICATION_EXEMPT_GATEWAYS?.trim() || DEFAULT_VERIFICATION_EXEMPT_GATEWAYS;
}
__name(getVerificationExemptGateways, "getVerificationExemptGateways");

// workers/src/logo.ts
var BLACKOUT_LOGO_DATA_URI = "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAKuCAADASIAAhEBAxEB/8QAHgABAAMBAAIDAQAAAAAAAAAAAAgJCgcFBgECBAP/xABhEAEAAQMCAwMGBg0HCQQHBgcAAQIDBAUGBwgRCRIhEzE4QXa0IlFhdYGzFBgZMjdWV3GVlrLT1BUjNUJzdLEWFzM2UmJygpEkoaLSJUNTkpS1wYOTpKXR8CYoREZjhKP/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AtTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//Z";

// workers/src/email.ts
var LOGO_PLACEHOLDER = "__BLACKOUT_LOGO_SRC__";
var LOGO_CID = "blackout-logo";
var LOGO_BASE64 = BLACKOUT_LOGO_DATA_URI.replace(/^data:image\/png;base64,/, "");
async function sendVerificationEmail(input) {
  const subject = input.attemptNumber === 0 ? `Verification required for your order ${input.orderName}` : `Reminder: verification required for order ${input.orderName}`;
  const text = [
    input.attemptNumber > 0 ? `Reminder ${input.attemptNumber}: please complete verification for order ${input.orderName}.` : "",
    "",
    "Our system flagged your order with a risk of fraud. To proceed, the cardholder for the payment method used on this order must complete verification using the secure link below:",
    "",
    input.verificationUrl,
    "",
    "This step only takes a minute and helps us protect both you and our community from fraudulent transactions. Once the cardholder completes verification, we will proceed with processing your order right away.",
    "",
    "Best regards,",
    "Blackout Audio Team",
    "contact@blackoutaudio.com"
  ].join("\n");
  const html = renderEmailHtml({
    intro: "Our system flagged your order with a risk of fraud. To proceed, the cardholder for the payment method used on this order must complete verification using the secure link below:",
    verificationUrl: input.verificationUrl,
    body: "This step only takes a minute and helps us protect both you and our community from fraudulent transactions. Once the cardholder completes verification, we will proceed with processing your order right away.",
    reminder: input.attemptNumber > 0 ? `Reminder ${input.attemptNumber}: please complete verification for order ${input.orderName}.` : null
  });
  await sendTransactionalEmail({
    env: input.env,
    eventKey: input.eventKey,
    to: input.to,
    subject,
    text,
    html
  });
}
__name(sendVerificationEmail, "sendVerificationEmail");
async function sendSuccessEmail(input) {
  const subject = "Verification complete";
  const text = [
    "Thank you for successfully passing the verification.",
    "",
    "We will now resume processing your order.",
    "",
    "Best regards,",
    "Blackout Audio Team",
    "contact@blackoutaudio.com"
  ].join("\n");
  const html = renderEmailHtml({
    intro: "Thank you for successfully passing the verification.",
    body: "We will now resume processing your order."
  });
  await sendTransactionalEmail({
    env: input.env,
    eventKey: input.eventKey,
    to: input.to,
    subject,
    text,
    html
  });
}
__name(sendSuccessEmail, "sendSuccessEmail");
async function sendOpsManualReviewEmail(input) {
  const subject = `Didit manual review required for ${input.orderName}`;
  const reviewPassword = input.env.DIDIT_REVIEW_PASSWORD?.trim() || "(check current password in secure vault)";
  const reviewUrl = "https://business.didit.me/";
  const reviewLogin = "operations@blackoutaudio.com";
  const text = [
    `Manual review required for order ${input.orderName}.`,
    `Customer email: ${input.customerEmail}`,
    `Didit session id: ${input.diditSessionId}`,
    "",
    "To Review: go to",
    reviewUrl,
    "",
    "log in with",
    `${reviewLogin} and current password. (${reviewPassword} at time of writing)`
  ].join("\n");
  await sendTransactionalEmail({
    env: input.env,
    eventKey: input.eventKey,
    to: input.env.OPS_EMAIL,
    subject,
    text
  });
}
__name(sendOpsManualReviewEmail, "sendOpsManualReviewEmail");
async function sendTransactionalEmail(input) {
  const alreadySent = await hasEmailEvent(input.env, input.eventKey);
  if (alreadySent) {
    return;
  }
  if (input.env.CUSTOMER_EMAIL_PROVIDER === "flow") {
    console.info("Email delegated to Flow (no provider call)", {
      to: input.to,
      subject: input.subject,
      eventKey: input.eventKey
    });
    await recordEmailEvent(input.env, input.eventKey, input.to, input.subject);
    return;
  }
  if (input.env.CUSTOMER_EMAIL_PROVIDER === "gmail") {
    await sendViaGmailApi(input);
  } else {
    await sendViaResend(input);
  }
  await recordEmailEvent(input.env, input.eventKey, input.to, input.subject);
}
__name(sendTransactionalEmail, "sendTransactionalEmail");
async function sendViaResend(input) {
  const apiKey = input.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is missing");
  }
  if (!input.env.MAIL_FROM?.trim()) {
    throw new Error("MAIL_FROM is missing");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: input.env.MAIL_FROM,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html?.replace(LOGO_PLACEHOLDER, BLACKOUT_LOGO_DATA_URI)
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Resend email send failed: ${response.status} ${details}`);
  }
}
__name(sendViaResend, "sendViaResend");
async function sendViaGmailApi(input) {
  const clientId = input.env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = input.env.GMAIL_CLIENT_SECRET?.trim();
  const refreshToken = input.env.GMAIL_REFRESH_TOKEN?.trim();
  const gmailUser = input.env.GMAIL_USER?.trim();
  const fromHeader = input.env.GMAIL_FROM?.trim() || input.env.MAIL_FROM?.trim();
  if (!clientId || !clientSecret || !refreshToken || !gmailUser) {
    throw new Error("GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET/GMAIL_REFRESH_TOKEN/GMAIL_USER are required");
  }
  if (!fromHeader) {
    throw new Error("GMAIL_FROM or MAIL_FROM is required");
  }
  const accessToken = await getGoogleAccessToken(clientId, clientSecret, refreshToken);
  const html = input.html?.replace(LOGO_PLACEHOLDER, `cid:${LOGO_CID}`);
  const rawMime = buildPlainTextMime({
    from: fromHeader,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html,
    inlineImageCid: LOGO_CID,
    inlineImageBase64: LOGO_BASE64
  });
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(gmailUser)}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      raw: toBase64Url(rawMime)
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gmail API send failed: ${response.status} ${details}`);
  }
}
__name(sendViaGmailApi, "sendViaGmailApi");
async function getGoogleAccessToken(clientId, clientSecret, refreshToken) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString()
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Google token refresh failed: ${response.status} ${details}`);
  }
  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error("Google token refresh returned no access_token");
  }
  return payload.access_token;
}
__name(getGoogleAccessToken, "getGoogleAccessToken");
function buildPlainTextMime(input) {
  if (input.html?.trim()) {
    const boundary = `bnd_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const relatedBoundary = `rel_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const hasInlineImage = Boolean(input.inlineImageCid && input.inlineImageBase64);
    if (hasInlineImage) {
      return [
        `From: ${input.from}`,
        `To: ${input.to}`,
        `Subject: ${input.subject}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
        "",
        `--${relatedBoundary}`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        input.text,
        "",
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        input.html,
        "",
        `--${boundary}--`,
        "",
        `--${relatedBoundary}`,
        'Content-Type: image/png; name="blackout-logo.png"',
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${input.inlineImageCid}>`,
        'Content-Disposition: inline; filename="blackout-logo.png"',
        "",
        input.inlineImageBase64,
        "",
        `--${relatedBoundary}--`
      ].join("\r\n");
    }
    return [
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      input.text,
      "",
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      input.html,
      "",
      `--${boundary}--`
    ].join("\r\n");
  }
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    input.text
  ].join("\r\n");
}
__name(buildPlainTextMime, "buildPlainTextMime");
function toBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(toBase64Url, "toBase64Url");
function renderEmailHtml(input) {
  const reminderHtml = input.reminder ? `<p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">${escapeHtml(input.reminder)}</p>` : "";
  const linkHtml = input.verificationUrl ? `<p style="margin:0 0 16px;"><a href="${escapeAttribute(input.verificationUrl)}" style="color:#2563eb;font-size:16px;line-height:1.6;word-break:break-all;">${escapeHtml(input.verificationUrl)}</a></p>` : "";
  return [
    "<!doctype html>",
    '<html><body style="margin:0;padding:0;font-family:Arial,sans-serif;color:#111827;">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0">',
    '<tr><td align="center">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;">',
    '<tr><td align="center" style="padding:14px 0 18px;">',
    `<img src="${LOGO_PLACEHOLDER}" alt="Blackout Audio" style="display:block;width:80%;max-width:416px;height:auto;border-radius:14px;" />`,
    "</td></tr>",
    '<tr><td style="font-size:15px;line-height:1.6;color:#111827;">',
    reminderHtml,
    `<p style="margin:0 0 14px;">${escapeHtml(input.intro)}</p>`,
    linkHtml,
    `<p style="margin:0 0 18px;">${escapeHtml(input.body)}</p>`,
    '<p style="margin:0;">Best regards,<br/>Blackout Audio Team<br/>contact@blackoutaudio.com</p>',
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body></html>"
  ].join("");
}
__name(renderEmailHtml, "renderEmailHtml");
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(escapeHtml, "escapeHtml");
function escapeAttribute(value) {
  return escapeHtml(value);
}
__name(escapeAttribute, "escapeAttribute");

// workers/src/shopify.ts
function validateShopifyShop(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}
__name(validateShopifyShop, "validateShopifyShop");
async function verifyOauthHmac(env, query) {
  const hmac = query.get("hmac");
  if (!hmac) {
    return false;
  }
  const message = [...query.entries()].filter(([key]) => key !== "hmac" && key !== "signature").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&");
  const digest = await hmacSha256Hex(env.SHOPIFY_API_SECRET, new TextEncoder().encode(message));
  return timingSafeEqual(digest, hmac);
}
__name(verifyOauthHmac, "verifyOauthHmac");
async function verifyShopifyWebhook(env, rawBody, hmacHeader) {
  if (!hmacHeader) {
    return false;
  }
  const digest = await hmacSha256Base64(env.SHOPIFY_API_SECRET, rawBody);
  return timingSafeEqual(digest, hmacHeader);
}
__name(verifyShopifyWebhook, "verifyShopifyWebhook");
function buildShopifyInstallUrl(env, shop, state) {
  const redirectUri = `${env.APP_URL}/auth/callback`;
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", env.SHOPIFY_API_KEY);
  url.searchParams.set("scope", env.SHOPIFY_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}
__name(buildShopifyInstallUrl, "buildShopifyInstallUrl");
async function exchangeAccessToken(env, params) {
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
  const data = await response.json();
  if (!data.access_token) {
    throw new Error("Shopify token exchange missing access token");
  }
  return data;
}
__name(exchangeAccessToken, "exchangeAccessToken");
async function registerOrdersUpdatedWebhook(env, shop, accessToken) {
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
__name(registerOrdersUpdatedWebhook, "registerOrdersUpdatedWebhook");
async function addOrderTag(env, shop, accessToken, orderGidOrLegacyId, tag) {
  const id = orderGidOrLegacyId.startsWith("gid://") ? orderGidOrLegacyId : `gid://shopify/Order/${orderGidOrLegacyId}`;
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
__name(addOrderTag, "addOrderTag");
async function removeOrderTag(env, shop, accessToken, orderGidOrLegacyId, tag) {
  const id = orderGidOrLegacyId.startsWith("gid://") ? orderGidOrLegacyId : `gid://shopify/Order/${orderGidOrLegacyId}`;
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
__name(removeOrderTag, "removeOrderTag");
async function setOrderVerificationMetafields(env, input) {
  const id = input.orderGidOrLegacyId.startsWith("gid://") ? input.orderGidOrLegacyId : `gid://shopify/Order/${input.orderGidOrLegacyId}`;
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
__name(setOrderVerificationMetafields, "setOrderVerificationMetafields");
async function getOrderTransactionGateways(env, shop, accessToken, orderLegacyId) {
  const response = await fetch(
    `https://${shop}/admin/api/2025-10/orders/${encodeURIComponent(orderLegacyId)}/transactions.json`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken
      }
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Shopify transactions list failed: ${response.status} ${JSON.stringify(data)}`);
  }
  const gateways = (data.transactions ?? []).filter((tx) => String(tx?.status ?? "").toLowerCase() === "success").map((tx) => String(tx?.gateway ?? "").trim()).filter(Boolean);
  return [...new Set(gateways)];
}
__name(getOrderTransactionGateways, "getOrderTransactionGateways");
async function captureFirstUncapturedPayment(env, shop, accessToken, orderLegacyId) {
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
  const listData = await listResponse.json();
  if (!listResponse.ok) {
    throw new Error(`Shopify transactions list failed: ${listResponse.status} ${JSON.stringify(listData)}`);
  }
  const transactions = listData.transactions ?? [];
  const capturedByParent = /* @__PURE__ */ new Map();
  const voidedParents = /* @__PURE__ */ new Set();
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
    if (!(remaining > 1e-4)) {
      continue;
    }
    const captureAmount = remaining.toFixed(2);
    const capturePayload = {
      transaction: {
        kind: "capture",
        parent_id: authId,
        amount: captureAmount,
        currency: tx?.currency ?? void 0
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
    const captureData = await captureResponse.json();
    if (!captureResponse.ok) {
      throw new Error(`Shopify capture failed: ${captureResponse.status} ${JSON.stringify(captureData)}`);
    }
    return {
      captured: true,
      captureTransactionId: captureData.transaction?.id ? String(captureData.transaction.id) : void 0,
      amount: captureData.transaction?.amount ?? captureAmount
    };
  }
  return { captured: false };
}
__name(captureFirstUncapturedPayment, "captureFirstUncapturedPayment");
async function shopifyGraphql(env, shop, accessToken, body) {
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
  return data;
}
__name(shopifyGraphql, "shopifyGraphql");

// workers/src/workflow.ts
var MANUAL_APPROVAL_TAGS = "didit-verified,didit_verified";
async function handleRiskyOrderEvent(env, shop, order) {
  const orderId = String(order.id);
  const previousTags = await getOrderTagSnapshot(env, shop, orderId);
  const currentTags = order.tags ?? "";
  const existing = await getJobByOrder(env, shop, orderId);
  await upsertOrderTagSnapshot(env, shop, orderId, currentTags);
  const approvalTagAdded = wasTriggerTagAdded(previousTags, currentTags, MANUAL_APPROVAL_TAGS);
  const approvalTagPresentOnAwaiting = existing?.status === "awaiting_shopify_approval" && hasAnyTagFromCsv(currentTags, MANUAL_APPROVAL_TAGS);
  if (approvalTagAdded || approvalTagPresentOnAwaiting) {
    if (!existing) {
      return { skipped: true, reason: "manual_approval_missing_job" };
    }
    if (existing.status === "verified") {
      return { skipped: true, reason: "already_verified" };
    }
    const shopAccessToken2 = await getShopAccessToken(env, shop);
    if (!shopAccessToken2) {
      throw new Error(`No Shopify access token found for shop ${shop}`);
    }
    await finalizeOrderVerified(env, {
      shop,
      accessToken: shopAccessToken2,
      orderId,
      sessionId: existing.diditSessionId,
      verificationUrl: existing.diditVerificationUrl,
      customerEmail: existing.customerEmail,
      eventKey: `success-manual-tag:${shop}:${orderId}`
    });
    await markJobStatus(env, existing.id, "verified");
    return { skipped: false, jobId: existing.id, manualApproval: true };
  }
  if (!wasTriggerTagAdded(previousTags, currentTags, env.FRAUD_TRIGGER_TAG)) {
    return { skipped: true, reason: "trigger_tag_not_added" };
  }
  if (!isOrderCreatedOnOrAfterCutoff(order)) {
    return { skipped: true, reason: "order_before_cutoff" };
  }
  if (shouldSkipFraudVerification(order)) {
    return { skipped: true, reason: "order_not_eligible" };
  }
  const orderName = getOrderName(order);
  const email = getCustomerEmail(order);
  if (!email) {
    return { skipped: true, reason: "missing_customer_email" };
  }
  const vendorDataBase = buildVendorData(orderName, email);
  const shopAccessToken = await getShopAccessToken(env, shop);
  const exemptGateways = getVerificationExemptGateways(env);
  let gateways = getOrderGateways(order);
  if (gateways.length === 0 && shopAccessToken) {
    gateways = await getOrderTransactionGateways(env, shop, shopAccessToken, orderId);
  }
  if (isVerificationExemptPayment(gateways, exemptGateways)) {
    if (shopAccessToken) {
      await removeOrderTag(env, shop, shopAccessToken, orderId, "didit_verification_pending");
      await removeOrderTag(env, shop, shopAccessToken, orderId, "didit_verification_required");
    }
    return { skipped: true, reason: "payment_gateway_exempt", gateways };
  }
  if (existing) {
    if (existing.status === "provisioning") {
      return { skipped: true, reason: "job_provisioning" };
    }
    if (existing.status === "verified") {
      return { skipped: true, reason: "already_verified" };
    }
    const previousSession = await inspectDiditSessionStatus(env, existing.diditSessionId);
    if (previousSession.exists && !previousSession.expired) {
      return { skipped: true, reason: "job_exists" };
    }
    const diditSession2 = await createDiditVerificationSession(env, {
      vendorData: vendorDataBase,
      callback: `${env.APP_URL}/webhooks/didit`
    });
    await updateJobWithNewSession(env, {
      id: existing.id,
      vendorDataBase,
      diditSessionId: diditSession2.sessionId,
      diditSessionToken: diditSession2.sessionToken,
      diditVerificationUrl: diditSession2.verificationUrl,
      status: "awaiting_verification",
      followupCount: 0,
      nextAttemptAt: addDaysIso(/* @__PURE__ */ new Date(), getRetryDays(env))
    });
    if (shopAccessToken) {
      await addOrderTag(env, shop, shopAccessToken, orderId, "didit_verification_pending");
      await setOrderVerificationMetafields(env, {
        shop,
        accessToken: shopAccessToken,
        orderGidOrLegacyId: orderId,
        status: "pending",
        verificationUrl: diditSession2.verificationUrl,
        sessionId: diditSession2.sessionId
      });
    }
    await sendVerificationEmail({
      env,
      eventKey: `verification:${shop}:${orderId}:${diditSession2.sessionId}:0`,
      to: email,
      customerName: getCustomerName(order),
      orderName,
      verificationUrl: diditSession2.verificationUrl,
      attemptNumber: 0
    });
    return { skipped: false, jobId: existing.id, replacedExisting: true };
  }
  const provisionalJobId = await tryInsertProvisioningJob(env, {
    shop,
    orderId,
    vendorDataBase,
    customerEmail: email,
    customerId: order.customer?.id ? String(order.customer.id) : null
  });
  if (!provisionalJobId) {
    return { skipped: true, reason: "job_exists" };
  }
  let diditSession;
  try {
    diditSession = await createDiditVerificationSession(env, {
      vendorData: vendorDataBase,
      callback: `${env.APP_URL}/webhooks/didit`
    });
  } catch (error) {
    await deleteVerificationJob(env, provisionalJobId);
    throw error;
  }
  await updateJobWithNewSession(env, {
    id: provisionalJobId,
    vendorDataBase,
    diditSessionId: diditSession.sessionId,
    diditSessionToken: diditSession.sessionToken,
    diditVerificationUrl: diditSession.verificationUrl,
    status: "awaiting_verification",
    followupCount: 0,
    nextAttemptAt: addDaysIso(/* @__PURE__ */ new Date(), getRetryDays(env))
  });
  if (shopAccessToken) {
    await addOrderTag(env, shop, shopAccessToken, orderId, "didit_verification_required");
    await addOrderTag(env, shop, shopAccessToken, orderId, "didit_verification_pending");
    await setOrderVerificationMetafields(env, {
      shop,
      accessToken: shopAccessToken,
      orderGidOrLegacyId: orderId,
      status: "pending",
      verificationUrl: diditSession.verificationUrl,
      sessionId: diditSession.sessionId
    });
  }
  await sendVerificationEmail({
    env,
    eventKey: `verification:${shop}:${orderId}:${diditSession.sessionId}:0`,
    to: email,
    customerName: getCustomerName(order),
    orderName,
    verificationUrl: diditSession.verificationUrl,
    attemptNumber: 0
  });
  return { skipped: false, jobId: provisionalJobId };
}
__name(handleRiskyOrderEvent, "handleRiskyOrderEvent");
async function processRetryJob(env, jobId) {
  const now = /* @__PURE__ */ new Date();
  const nowIso = now.toISOString();
  const lockUntil = new Date(now.getTime() + 6e4).toISOString();
  const locked = await lockJob(env, jobId, nowIso, lockUntil);
  if (!locked) {
    return { skipped: true, reason: "job_locked" };
  }
  const job = await getJobById(env, jobId);
  if (!job || job.status !== "awaiting_verification") {
    return { skipped: true, reason: "job_not_pending" };
  }
  try {
    const decisionRecheck = await handleDiditDecisionEvent(env, job.diditSessionId);
    if (decisionRecheck.handled) {
      return { skipped: true, reason: "decision_finalized" };
    }
    if (decisionRecheck.reason === "already_verified" || decisionRecheck.reason === "already_manual_review") {
      return { skipped: true, reason: "decision_already_finalized" };
    }
    if (decisionRecheck.reason === "session_deleted") {
      return { skipped: true, reason: "session_deleted" };
    }
    if (decisionRecheck.reason !== "decision_still_pending") {
      return { skipped: true, reason: "decision_recheck_skipped" };
    }
    const maxFollowups = getMaxFollowups(env);
    if (job.followupCount >= maxFollowups) {
      await markJobStatus(env, job.id, "retry_exhausted");
      return { skipped: true, reason: "retries_exhausted" };
    }
    const diditSession = await createDiditVerificationSession(env, {
      vendorData: job.vendorDataBase ?? buildVendorData(job.orderId, job.customerEmail),
      callback: `${env.APP_URL}/webhooks/didit`
    });
    const nextFollowupCount = job.followupCount + 1;
    const shouldScheduleAnother = nextFollowupCount < maxFollowups;
    const nextAttemptAt = shouldScheduleAnother ? addDaysIso(/* @__PURE__ */ new Date(), getRetryDays(env)) : null;
    await updateJobWithNewSession(env, {
      id: job.id,
      diditSessionId: diditSession.sessionId,
      diditSessionToken: diditSession.sessionToken,
      diditVerificationUrl: diditSession.verificationUrl,
      followupCount: nextFollowupCount,
      nextAttemptAt
    });
    const shopAccessToken = await getShopAccessToken(env, job.shop);
    if (shopAccessToken) {
      await addOrderTag(env, job.shop, shopAccessToken, job.orderId, "didit_verification_pending");
      await setOrderVerificationMetafields(env, {
        shop: job.shop,
        accessToken: shopAccessToken,
        orderGidOrLegacyId: job.orderId,
        status: "pending",
        verificationUrl: diditSession.verificationUrl,
        sessionId: diditSession.sessionId
      });
    }
    await sendVerificationEmail({
      env,
      eventKey: `verification:${job.shop}:${job.orderId}:${diditSession.sessionId}:${nextFollowupCount}`,
      to: job.customerEmail,
      orderName: job.orderId,
      verificationUrl: diditSession.verificationUrl,
      attemptNumber: nextFollowupCount
    });
    if (!shouldScheduleAnother) {
      await markJobStatus(env, job.id, "retry_exhausted");
    }
    return { skipped: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown retry error";
    await setJobProcessingError(env, job.id, message, new Date(Date.now() + 5 * 6e4).toISOString());
    throw error;
  }
}
__name(processRetryJob, "processRetryJob");
async function enqueueRetryForDueJobs(env) {
  const dueJobs = await getDueRetries(env, (/* @__PURE__ */ new Date()).toISOString());
  for (const job of dueJobs) {
    await env.DIDIT_JOBS.send({
      type: "process_retry_job",
      jobId: job.id
    });
  }
  return dueJobs.length;
}
__name(enqueueRetryForDueJobs, "enqueueRetryForDueJobs");
async function handleDiditDecisionEvent(env, sessionId) {
  const job = await getJobBySessionId(env, sessionId);
  if (!job) {
    return { handled: false, reason: "job_not_found" };
  }
  if (job.status === "verified") {
    return { handled: false, reason: "already_verified" };
  }
  const accessToken = await getShopAccessToken(env, job.shop);
  if (!accessToken) {
    throw new Error(`No Shopify access token found for shop ${job.shop}`);
  }
  let decision;
  try {
    decision = await retrieveDiditDecision(env, sessionId);
  } catch (error) {
    if (error instanceof DiditDecisionNotFoundError) {
      await markJobStatus(env, job.id, "retry_exhausted");
      await removeOrderTag(env, job.shop, accessToken, job.orderId, "didit_verification_pending");
      return { handled: true, reason: "session_deleted" };
    }
    throw error;
  }
  let normalized = parseDiditDecision(decision);
  if (normalized === "manual_review") {
    await sleep(1e4);
    let decisionAfterDelay;
    try {
      decisionAfterDelay = await retrieveDiditDecision(env, sessionId);
    } catch (error) {
      if (error instanceof DiditDecisionNotFoundError) {
        await markJobStatus(env, job.id, "retry_exhausted");
        await removeOrderTag(env, job.shop, accessToken, job.orderId, "didit_verification_pending");
        return { handled: true, reason: "session_deleted" };
      }
      throw error;
    }
    normalized = parseDiditDecision(decisionAfterDelay);
  }
  if (normalized === "pending") {
    return { handled: false, reason: "decision_still_pending" };
  }
  if (job.status === "awaiting_shopify_approval") {
    return { handled: false, reason: "already_awaiting_shopify_approval" };
  }
  if (normalized === "approved") {
    await markJobStatus(env, job.id, "awaiting_shopify_approval");
    await setOrderVerificationMetafields(env, {
      shop: job.shop,
      accessToken,
      orderGidOrLegacyId: job.orderId,
      status: "awaiting_shopify_approval",
      verificationUrl: job.diditVerificationUrl,
      sessionId
    });
    return { handled: true, outcome: "awaiting_shopify_approval" };
  }
  if (job.status === "manual_review") {
    return { handled: false, reason: "already_manual_review" };
  }
  await markJobStatus(env, job.id, "manual_review");
  await removeOrderTag(env, job.shop, accessToken, job.orderId, "didit_verification_pending");
  await addOrderTag(env, job.shop, accessToken, job.orderId, "didit_manual_review");
  await setOrderVerificationMetafields(env, {
    shop: job.shop,
    accessToken,
    orderGidOrLegacyId: job.orderId,
    status: "manual_review",
    verificationUrl: job.diditVerificationUrl,
    sessionId
  });
  await recordOpsAlert(env, {
    shop: job.shop,
    orderId: job.orderId,
    customerEmail: job.customerEmail,
    diditSessionId: sessionId,
    reason: "manual_review_required"
  });
  await sendOpsManualReviewEmail({
    env,
    eventKey: `manual-review:${job.shop}:${job.orderId}:${sessionId}`,
    orderName: job.orderId,
    customerEmail: job.customerEmail,
    diditSessionId: sessionId
  });
  return { handled: true, outcome: "manual_review" };
}
__name(handleDiditDecisionEvent, "handleDiditDecisionEvent");
function parseDiditDecision(decisionPayload) {
  const candidates = [
    decisionPayload?.decision,
    decisionPayload?.status,
    decisionPayload?.result,
    decisionPayload?.result?.decision,
    decisionPayload?.summary?.decision,
    decisionPayload?.summary?.status
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  if (candidates.some((value) => ["approved", "pass", "passed", "verified", "accept"].includes(value))) {
    return "approved";
  }
  if (candidates.some((value) => ["pending", "in_progress", "processing", "not started"].includes(value))) {
    return "pending";
  }
  if (candidates.some(
    (value) => [
      "manual_review",
      "manual review",
      "declined",
      "rejected",
      "deny",
      "denied",
      "failed",
      "fail",
      "fraud",
      "risk",
      "review_required",
      "review required"
    ].includes(value)
  )) {
    return "manual_review";
  }
  return "pending";
}
__name(parseDiditDecision, "parseDiditDecision");
function addDaysIso(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}
__name(addDaysIso, "addDaysIso");
function buildVendorData(orderNumber, customerEmail) {
  const normalizedOrder = orderNumber.trim();
  const normalizedEmail = customerEmail?.trim() ?? "";
  return normalizedEmail ? `${normalizedOrder} | ${normalizedEmail}` : normalizedOrder;
}
__name(buildVendorData, "buildVendorData");
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep, "sleep");
function hasAnyTagFromCsv(tagsCsv, expectedTagsCsv) {
  const normalizedTags = tagsCsv.split(",").map((tag) => tag.trim().toLowerCase().replace(/[_\s]+/g, "-")).filter(Boolean);
  const expected = expectedTagsCsv.split(",").map((tag) => tag.trim().toLowerCase().replace(/[_\s]+/g, "-")).filter(Boolean);
  return expected.some((tag) => normalizedTags.includes(tag));
}
__name(hasAnyTagFromCsv, "hasAnyTagFromCsv");
async function finalizeOrderVerified(env, input) {
  await removeOrderTag(env, input.shop, input.accessToken, input.orderId, "didit_verification_pending");
  await removeOrderTag(env, input.shop, input.accessToken, input.orderId, "didit_manual_review");
  await removeOrderTag(env, input.shop, input.accessToken, input.orderId, "verified");
  await addOrderTag(env, input.shop, input.accessToken, input.orderId, "didit_successfully_verified");
  await setOrderVerificationMetafields(env, {
    shop: input.shop,
    accessToken: input.accessToken,
    orderGidOrLegacyId: input.orderId,
    status: "verified",
    verificationUrl: input.verificationUrl,
    sessionId: input.sessionId
  });
  await captureFirstUncapturedPayment(env, input.shop, input.accessToken, input.orderId);
  await sendSuccessEmail({
    env,
    eventKey: input.eventKey,
    to: input.customerEmail,
    orderName: input.orderId
  });
}
__name(finalizeOrderVerified, "finalizeOrderVerified");

// workers/src/index.ts
var jsonHeaders = {
  "content-type": "application/json; charset=utf-8"
};
var app = {
  async fetch(request, env) {
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
      const enqueued = await enqueueRetryForDueJobs(env);
      return Response.json({ ok: true, enqueued }, { headers: jsonHeaders });
    }
    if (request.method === "GET" && pathname === "/ops/alerts") {
      return handleOpsAlerts(request, env);
    }
    return new Response("Not Found", { status: 404 });
  },
  async queue(batch, env) {
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
  async scheduled(_event, env) {
    const enqueued = await enqueueRetryForDueJobs(env);
    console.info("Retry scan complete", { enqueued });
  }
};
async function handleAuthInstall(request, env) {
  const url = new URL(request.url);
  const shop = String(url.searchParams.get("shop") ?? "");
  if (!validateShopifyShop(shop)) {
    return new Response("Invalid shop", { status: 400 });
  }
  const state = randomHex(16);
  const expiresAt = new Date(Date.now() + 10 * 6e4).toISOString();
  await saveOauthState(env, shop, state, expiresAt);
  return Response.redirect(buildShopifyInstallUrl(env, shop, state), 302);
}
__name(handleAuthInstall, "handleAuthInstall");
async function handleAuthCallback(request, env) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;
    const shop = params.get("shop") ?? "";
    const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";
    if (!validateShopifyShop(shop)) {
      return new Response("Invalid shop", { status: 400 });
    }
    if (!await verifyOauthHmac(env, params)) {
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
__name(handleAuthCallback, "handleAuthCallback");
async function handleShopifyWebhook(request, env) {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const shop = request.headers.get("x-shopify-shop-domain");
  const webhookId = request.headers.get("x-shopify-webhook-id");
  if (!await verifyShopifyWebhook(env, rawBody, hmacHeader)) {
    return new Response("Invalid webhook signature", { status: 401 });
  }
  if (!shop || !validateShopifyShop(shop)) {
    return new Response("Invalid shop domain", { status: 400 });
  }
  const payloadText = new TextDecoder().decode(rawBody);
  const order = parseJson(payloadText);
  if (!order || order.id === void 0) {
    return new Response("Invalid order payload", { status: 400 });
  }
  const dedupeKey = webhookId ?? await sha256Hex(`shopify:${shop}:${String(order.id)}:${order.tags ?? ""}:${order.updated_at ?? ""}`);
  const inserted = await upsertWebhookEvent(env, "shopify_orders_updated", dedupeKey);
  if (!inserted) {
    return new Response("ok", { status: 200 });
  }
  await env.DIDIT_JOBS.send({
    type: "process_shopify_order",
    shop,
    order
  });
  return new Response("ok", { status: 200 });
}
__name(handleShopifyWebhook, "handleShopifyWebhook");
async function handleDiditWebhook(request, env) {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const signatureHeader = request.headers.get("x-signature");
  if (!await verifyDiditWebhookSignature(env, rawBody, signatureHeader)) {
    return new Response("Invalid Didit signature", { status: 401 });
  }
  const payloadText = new TextDecoder().decode(rawBody);
  const payload = parseJson(payloadText);
  if (!payload) {
    return new Response("Invalid Didit payload", { status: 400 });
  }
  const sessionId = payload?.session_id ?? payload?.sessionId ?? payload?.data?.session_id ?? payload?.data?.sessionId;
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
  });
  return new Response("ok", { status: 200 });
}
__name(handleDiditWebhook, "handleDiditWebhook");
async function handleOpsAlerts(request, env) {
  const token = new URL(request.url).searchParams.get("token");
  if (!env.OPS_ALERT_TOKEN || token !== env.OPS_ALERT_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }
  const alerts = await listOpsAlerts(env, 100);
  return Response.json({ alerts }, { headers: jsonHeaders });
}
__name(handleOpsAlerts, "handleOpsAlerts");
function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
__name(parseJson, "parseJson");
var index_default = app;
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
