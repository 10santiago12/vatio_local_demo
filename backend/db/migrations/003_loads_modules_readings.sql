-- 003: loads, measurement modules, raw readings and hourly aggregates.

CREATE TABLE loads (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  code TEXT NOT NULL,                         -- stable slug such as "freezer" (matches ESP32 load_id)
  name TEXT NOT NULL,
  icon TEXT,
  typical_power_w REAL CHECK (typical_power_w IS NULL OR typical_power_w >= 0),
  criticality TEXT NOT NULL DEFAULT 'essential' CHECK (criticality IN ('critical', 'essential', 'non_essential')),
  control_mode TEXT NOT NULL DEFAULT 'monitor_only' CHECK (control_mode IN ('monitor_only', 'control_enabled')),
  power_state TEXT NOT NULL DEFAULT 'on' CHECK (power_state IN ('on', 'off')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (site_id, code),
  -- A critical load can never be remotely controlled (domain rule).
  CHECK (criticality <> 'critical' OR control_mode = 'monitor_only')
);
CREATE INDEX loads_site ON loads(site_id);

CREATE TABLE modules (
  id TEXT PRIMARY KEY,                         -- e.g. "MX-001"
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  load_id INTEGER REFERENCES loads(id) ON DELETE SET NULL,
  manufacturer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error')),
  last_heartbeat TEXT,
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  registered_by INTEGER REFERENCES users(id)
);
CREATE INDEX modules_site ON modules(site_id);
CREATE UNIQUE INDEX modules_one_per_load ON modules(load_id) WHERE load_id IS NOT NULL;

-- Raw 1-minute readings for recent history. (load_id, ts) is unique so buffered
-- re-sends and data reimports are idempotent.
CREATE TABLE readings (
  id INTEGER PRIMARY KEY,
  load_id INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  module_id TEXT REFERENCES modules(id) ON DELETE SET NULL,
  ts TEXT NOT NULL,
  power_w REAL NOT NULL CHECK (power_w >= 0),
  voltage_v REAL CHECK (voltage_v IS NULL OR voltage_v >= 0),
  current_a REAL CHECK (current_a IS NULL OR current_a >= 0),
  energy_kwh REAL CHECK (energy_kwh IS NULL OR energy_kwh >= 0),
  source TEXT NOT NULL DEFAULT 'simulator' CHECK (source IN ('simulator', 'esp32', 'import')),
  UNIQUE (load_id, ts)
);
CREATE INDEX readings_ts ON readings(ts);

-- Hourly aggregates kept for history older than the raw retention window.
CREATE TABLE readings_hourly (
  load_id INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  hour_start TEXT NOT NULL,                    -- ISO UTC, minutes and seconds zeroed
  avg_power_w REAL NOT NULL CHECK (avg_power_w >= 0),
  max_power_w REAL NOT NULL CHECK (max_power_w >= 0),
  energy_kwh REAL NOT NULL CHECK (energy_kwh >= 0),
  samples INTEGER NOT NULL CHECK (samples > 0),
  PRIMARY KEY (load_id, hour_start)
) WITHOUT ROWID;
