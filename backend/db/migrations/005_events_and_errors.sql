-- 005: product analytics events and the application error log.

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  properties TEXT                              -- JSON, never contains secrets
);
CREATE INDEX events_name_at ON events(name, at);
CREATE INDEX events_user ON events(user_id, at);

CREATE TABLE error_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('warn', 'error', 'fatal')),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  context TEXT,                                -- JSON
  request_id TEXT
);
CREATE INDEX error_log_at ON error_log(at);
CREATE INDEX error_log_level ON error_log(level, at);
