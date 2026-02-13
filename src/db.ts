import path from "node:path";
import { Database, open } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "./config.js";

export type VerificationJobStatus =
  | "awaiting_verification"
  | "verified"
  | "manual_review"
  | "retry_exhausted";

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
  createdAt: string;
  updatedAt: string;
}

let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDb() {
  if (db) {
    return db;
  }

  db = await open({
    filename: path.resolve(process.cwd(), env.SQLITE_PATH),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      shop TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS verification_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop TEXT NOT NULL,
      order_id TEXT NOT NULL,
      vendor_data_base TEXT,
      customer_email TEXT NOT NULL,
      customer_id TEXT,
      didit_session_id TEXT NOT NULL,
      didit_session_token TEXT,
      didit_verification_url TEXT NOT NULL,
      status TEXT NOT NULL,
      followup_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_email_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop, order_id)
    );
  `);

  // Backward-compatible migration for existing local databases.
  try {
    await db.exec(`ALTER TABLE verification_jobs ADD COLUMN vendor_data_base TEXT;`);
  } catch {
    // Column already exists.
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_retry
      ON verification_jobs(status, next_attempt_at);
  `);

  return db;
}

export async function upsertShopAccessToken(shop: string, accessToken: string) {
  const database = await initDb();
  await database.run(
    `
      INSERT INTO shops (shop, access_token, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(shop) DO UPDATE SET
        access_token = excluded.access_token,
        updated_at = CURRENT_TIMESTAMP;
    `,
    [shop, accessToken]
  );
}

export async function getShopAccessToken(shop: string): Promise<string | null> {
  const database = await initDb();
  const row = await database.get<{ access_token: string }>(
    `SELECT access_token FROM shops WHERE shop = ?`,
    [shop]
  );
  return row?.access_token ?? null;
}

export async function getJobByOrder(shop: string, orderId: string): Promise<VerificationJob | null> {
  const database = await initDb();
  const row = await database.get(
    `SELECT * FROM verification_jobs WHERE shop = ? AND order_id = ?`,
    [shop, orderId]
  );
  return mapJob(row);
}

export async function getJobBySessionId(sessionId: string): Promise<VerificationJob | null> {
  const database = await initDb();
  const row = await database.get(`SELECT * FROM verification_jobs WHERE didit_session_id = ?`, [sessionId]);
  return mapJob(row);
}

export async function insertVerificationJob(input: {
  shop: string;
  orderId: string;
  vendorDataBase: string;
  customerEmail: string;
  customerId: string | null;
  diditSessionId: string;
  diditSessionToken: string | null;
  diditVerificationUrl: string;
  nextAttemptAt: string;
}) {
  const database = await initDb();
  const result = await database.run(
    `
      INSERT INTO verification_jobs (
        shop, order_id, vendor_data_base, customer_email, customer_id, didit_session_id, didit_session_token,
        didit_verification_url, status, followup_count, next_attempt_at, last_email_sent_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_verification', 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
    [
      input.shop,
      input.orderId,
      input.vendorDataBase,
      input.customerEmail,
      input.customerId,
      input.diditSessionId,
      input.diditSessionToken,
      input.diditVerificationUrl,
      input.nextAttemptAt
    ]
  );

  return result.lastID as number;
}

export async function updateJobWithNewSession(input: {
  id: number;
  vendorDataBase?: string | null;
  diditSessionId: string;
  diditSessionToken: string | null;
  diditVerificationUrl: string;
  followupCount: number;
  status?: VerificationJobStatus;
  nextAttemptAt: string | null;
}) {
  const database = await initDb();
  await database.run(
    `
      UPDATE verification_jobs
      SET didit_session_id = ?, didit_session_token = ?, didit_verification_url = ?,
          vendor_data_base = COALESCE(?, vendor_data_base),
          status = COALESCE(?, status),
          followup_count = ?, next_attempt_at = ?, last_email_sent_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [
      input.diditSessionId,
      input.diditSessionToken,
      input.diditVerificationUrl,
      input.vendorDataBase ?? null,
      input.status ?? null,
      input.followupCount,
      input.nextAttemptAt,
      input.id
    ]
  );
}

export async function markJobStatus(id: number, status: VerificationJobStatus) {
  const database = await initDb();
  await database.run(
    `
      UPDATE verification_jobs
      SET status = ?, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [status, id]
  );
}

export async function getDueRetries(nowIso: string) {
  const database = await initDb();
  const rows = await database.all(
    `
      SELECT * FROM verification_jobs
      WHERE status = 'awaiting_verification'
        AND next_attempt_at IS NOT NULL
        AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
    `,
    [nowIso]
  );
  return rows.map(mapJob).filter((job): job is VerificationJob => Boolean(job));
}

function mapJob(row: any): VerificationJob | null {
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
