CREATE TABLE IF NOT EXISTS shops (
  shop TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_states (
  shop TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  locked_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(shop, order_id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ops_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  didit_session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_retry ON verification_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON verification_jobs(didit_session_id);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON webhook_events(event_type, created_at);
