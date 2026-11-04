-- 001: baseline schema as shipped by the first MVP (users, telemetry, audit, control_requests).
-- Idempotent on purpose: databases created by the old inline schema already contain these tables
-- and must be adopted without data loss.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  gateway_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  reading TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_site_time ON telemetry(site_id, received_at);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  site_id TEXT,
  details TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_requests (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  load_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
