CREATE TABLE IF NOT EXISTS order_tag_snapshots (
  shop TEXT NOT NULL,
  order_id TEXT NOT NULL,
  tags TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (shop, order_id)
);

CREATE INDEX IF NOT EXISTS idx_order_tag_snapshots_updated
  ON order_tag_snapshots(updated_at);
