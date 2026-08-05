import { WorkerEnv } from "./config";

export type VerificationJobStatus =
  | "provisioning"
  | "awaiting_verification"
  | "verified"
  | "manual_review"
  | "retry_exhausted"
  | "order_cancelled";

export interface VerificationJob {
  id: number;
  shop: string;
  orderId: string;
  vendorDataBase: string | null;
  customerEmail: string;
  customerId: string | null;
  diditSessionId: string;
  diditSessionToken: string | null;
  diditVerificationUrl: string;
  status: VerificationJobStatus;
  followupCount: number;
  nextAttemptAt: string | null;
  lastEmailSentAt: string | null;
  lockedUntil: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function upsertShopAccessToken(env: WorkerEnv, shop: string, accessToken: string) {
  await env.DIDIT_DB.prepare(
    `
      INSERT INTO shops (shop, access_token, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(shop) DO UPDATE SET
        access_token = excluded.access_token,
        updated_at = datetime('now')
    `
  )
    .bind(shop, accessToken)
    .run();
}

export async function getShopAccessToken(env: WorkerEnv, shop: string): Promise<string | null> {
  const row = await env.DIDIT_DB.prepare(`SELECT access_token FROM shops WHERE shop = ?`)
    .bind(shop)
    .first<{ access_token: string }>();
  return row?.access_token ?? null;
}

export async function saveOauthState(env: WorkerEnv, shop: string, state: string, expiresAt: string) {
  await env.DIDIT_DB.prepare(
    `
      INSERT INTO oauth_states(shop, state, expires_at, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(shop) DO UPDATE SET
        state = excluded.state,
        expires_at = excluded.expires_at,
        created_at = datetime('now')
    `
  )
    .bind(shop, state, expiresAt)
    .run();
}

export async function consumeOauthState(env: WorkerEnv, shop: string): Promise<string | null> {
  const row = await env.DIDIT_DB.prepare(`SELECT state, expires_at FROM oauth_states WHERE shop = ?`)
    .bind(shop)
    .first<{ state: string; expires_at: string }>();

  await env.DIDIT_DB.prepare(`DELETE FROM oauth_states WHERE shop = ?`).bind(shop).run();
  if (!row) {
    return null;
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    return null;
  }
  return row.state;
}

export async function getJobByOrder(env: WorkerEnv, shop: string, orderId: string): Promise<VerificationJob | null> {
  const row = await env.DIDIT_DB.prepare(`SELECT * FROM verification_jobs WHERE shop = ? AND order_id = ?`)
    .bind(shop, orderId)
    .first<Record<string, unknown>>();
  return mapJob(row);
}

export async function getJobBySessionId(env: WorkerEnv, sessionId: string): Promise<VerificationJob | null> {
  const row = await env.DIDIT_DB.prepare(`SELECT * FROM verification_jobs WHERE didit_session_id = ?`)
    .bind(sessionId)
    .first<Record<string, unknown>>();
  return mapJob(row);
}

export async function getJobById(env: WorkerEnv, id: number): Promise<VerificationJob | null> {
  const row = await env.DIDIT_DB.prepare(`SELECT * FROM verification_jobs WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  return mapJob(row);
}

export async function insertVerificationJob(
  env: WorkerEnv,
  input: {
    shop: string;
    orderId: string;
    vendorDataBase: string;
    customerEmail: string;
    customerId: string | null;
    diditSessionId: string;
    diditSessionToken: string | null;
    diditVerificationUrl: string;
    nextAttemptAt: string;
  }
): Promise<number> {
  const result = await env.DIDIT_DB.prepare(
    `
      INSERT INTO verification_jobs (
        shop, order_id, vendor_data_base, customer_email, customer_id,
        didit_session_id, didit_session_token, didit_verification_url,
        status, followup_count, next_attempt_at, last_email_sent_at,
        locked_until, attempt_count, last_error, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_verification', 0, ?, datetime('now'), NULL, 0, NULL, datetime('now'), datetime('now'))
    `
  )
    .bind(
      input.shop,
      input.orderId,
      input.vendorDataBase,
      input.customerEmail,
      input.customerId,
      input.diditSessionId,
      input.diditSessionToken,
      input.diditVerificationUrl,
      input.nextAttemptAt
    )
    .run();
  return Number(result.meta.last_row_id);
}

export async function tryInsertProvisioningJob(
  env: WorkerEnv,
  input: {
    shop: string;
    orderId: string;
    vendorDataBase: string;
    customerEmail: string;
    customerId: string | null;
  }
): Promise<number | null> {
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
  )
    .bind(input.shop, input.orderId, input.vendorDataBase, input.customerEmail, input.customerId)
    .run();

  if (Number(result.meta.changes ?? 0) === 0) {
    return null;
  }
  return Number(result.meta.last_row_id);
}

export async function deleteVerificationJob(env: WorkerEnv, id: number) {
  await env.DIDIT_DB.prepare(`DELETE FROM verification_jobs WHERE id = ?`).bind(id).run();
}

export async function updateJobWithNewSession(
  env: WorkerEnv,
  input: {
    id: number;
    vendorDataBase?: string | null;
    diditSessionId: string;
    diditSessionToken: string | null;
    diditVerificationUrl: string;
    followupCount: number;
    status?: VerificationJobStatus;
    nextAttemptAt: string | null;
  }
) {
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
  )
    .bind(
      input.diditSessionId,
      input.diditSessionToken,
      input.diditVerificationUrl,
      input.vendorDataBase ?? null,
      input.status ?? null,
      input.followupCount,
      input.nextAttemptAt,
      input.id
    )
    .run();
}

export async function markJobStatus(env: WorkerEnv, id: number, status: VerificationJobStatus) {
  await env.DIDIT_DB.prepare(
    `
      UPDATE verification_jobs
      SET status = ?, next_attempt_at = NULL, locked_until = NULL, updated_at = datetime('now')
      WHERE id = ?
    `
  )
    .bind(status, id)
    .run();
}

export async function getDueRetries(env: WorkerEnv, nowIso: string): Promise<VerificationJob[]> {
  const rows = await env.DIDIT_DB.prepare(
    `
      SELECT * FROM verification_jobs
      WHERE status = 'awaiting_verification'
        AND next_attempt_at IS NOT NULL
        AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
      LIMIT 100
    `
  )
    .bind(nowIso)
    .all<Record<string, unknown>>();
  return rows.results.map(mapJob).filter((job): job is VerificationJob => Boolean(job));
}

export async function getJobsAwaitingVerification(env: WorkerEnv, limit = 200): Promise<VerificationJob[]> {
  const rows = await env.DIDIT_DB.prepare(
    `
      SELECT * FROM verification_jobs
      WHERE status = 'awaiting_verification'
      ORDER BY id ASC
      LIMIT ?
    `
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  return rows.results.map(mapJob).filter((job): job is VerificationJob => Boolean(job));
}

export async function lockJob(env: WorkerEnv, id: number, nowIso: string, lockUntilIso: string): Promise<boolean> {
  const result = await env.DIDIT_DB.prepare(
    `
      UPDATE verification_jobs
      SET locked_until = ?, updated_at = datetime('now')
      WHERE id = ?
        AND (locked_until IS NULL OR locked_until <= ?)
    `
  )
    .bind(lockUntilIso, id, nowIso)
    .run();

  return Number(result.meta.changes ?? 0) > 0;
}

export async function setJobProcessingError(env: WorkerEnv, id: number, message: string, unlockAtIso: string) {
  await env.DIDIT_DB.prepare(
    `
      UPDATE verification_jobs
      SET attempt_count = attempt_count + 1,
          last_error = ?,
          locked_until = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `
  )
    .bind(message, unlockAtIso, id)
    .run();
}

export async function upsertWebhookEvent(env: WorkerEnv, eventType: string, dedupeKey: string): Promise<boolean> {
  const result = await env.DIDIT_DB.prepare(
    `
      INSERT INTO webhook_events(event_type, dedupe_key, created_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(dedupe_key) DO NOTHING
    `
  )
    .bind(eventType, dedupeKey)
    .run();

  return Number(result.meta.changes ?? 0) > 0;
}

export async function getOrderTagSnapshot(env: WorkerEnv, shop: string, orderId: string): Promise<string | null> {
  const row = await env.DIDIT_DB.prepare(`SELECT tags FROM order_tag_snapshots WHERE shop = ? AND order_id = ?`)
    .bind(shop, orderId)
    .first<{ tags: string }>();
  return row?.tags ?? null;
}

export async function upsertOrderTagSnapshot(env: WorkerEnv, shop: string, orderId: string, tags: string) {
  await env.DIDIT_DB.prepare(
    `
      INSERT INTO order_tag_snapshots(shop, order_id, tags, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(shop, order_id) DO UPDATE SET
        tags = excluded.tags,
        updated_at = datetime('now')
    `
  )
    .bind(shop, orderId, tags)
    .run();
}

export async function recordOpsAlert(
  env: WorkerEnv,
  input: { shop: string; orderId: string; customerEmail: string; diditSessionId: string; reason: string }
) {
  await env.DIDIT_DB.prepare(
    `
      INSERT INTO ops_alerts(shop, order_id, customer_email, didit_session_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `
  )
    .bind(input.shop, input.orderId, input.customerEmail, input.diditSessionId, input.reason)
    .run();
}

export async function listOpsAlerts(env: WorkerEnv, limit = 100) {
  const rows = await env.DIDIT_DB.prepare(
    `
      SELECT id, shop, order_id, customer_email, didit_session_id, reason, created_at
      FROM ops_alerts
      ORDER BY id DESC
      LIMIT ?
    `
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  return rows.results;
}

export async function hasEmailEvent(env: WorkerEnv, eventKey: string): Promise<boolean> {
  const row = await env.DIDIT_DB.prepare(`SELECT id FROM email_events WHERE event_key = ?`)
    .bind(eventKey)
    .first<{ id: number }>();
  return Boolean(row?.id);
}

export async function recordEmailEvent(env: WorkerEnv, eventKey: string, recipient: string, subject: string) {
  await env.DIDIT_DB.prepare(
    `
      INSERT INTO email_events(event_key, recipient, subject, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(event_key) DO NOTHING
    `
  )
    .bind(eventKey, recipient, subject)
    .run();
}

function mapJob(row: Record<string, unknown> | null): VerificationJob | null {
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
    status: row.status as VerificationJobStatus,
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
