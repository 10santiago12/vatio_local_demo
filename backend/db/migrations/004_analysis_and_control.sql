-- 004: baselines, alerts, recommendations, control actions; audit extended in place.

-- Hourly profile per load and day type; band = mean +/- 2 standard deviations (floored at 0).
CREATE TABLE baselines (
  id INTEGER PRIMARY KEY,
  load_id INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  day_type TEXT NOT NULL CHECK (day_type IN ('workday', 'sunday')),
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  mean_w REAL NOT NULL CHECK (mean_w >= 0),
  std_w REAL NOT NULL CHECK (std_w >= 0),
  band_low_w REAL NOT NULL CHECK (band_low_w >= 0),
  band_high_w REAL NOT NULL CHECK (band_high_w >= band_low_w),
  sample_days INTEGER NOT NULL CHECK (sample_days >= 1),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (load_id, day_type, hour, window_end)
);
CREATE INDEX baselines_load ON baselines(load_id, window_end);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  load_id INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('consumption', 'off_hours', 'maintenance', 'inactive_module')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reviewed')),
  detected_at TEXT NOT NULL,
  excess_pct REAL CHECK (excess_pct IS NULL OR excess_pct >= 0),
  excess_cost_per_hour_cop REAL CHECK (excess_cost_per_hour_cop IS NULL OR excess_cost_per_hour_cop >= 0),
  projected_monthly_cost_cop REAL CHECK (projected_monthly_cost_cop IS NULL OR projected_monthly_cost_cop >= 0),
  message TEXT NOT NULL,
  details TEXT,                                -- JSON with the evidence behind the alert
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  CHECK ((status = 'active' AND reviewed_at IS NULL) OR (status = 'reviewed' AND reviewed_at IS NOT NULL))
);
CREATE INDEX alerts_site_status ON alerts(site_id, status, detected_at);
CREATE INDEX alerts_load ON alerts(load_id, detected_at);
-- At most one active alert per load and type (no duplicates while still unreviewed).
CREATE UNIQUE INDEX alerts_one_active ON alerts(load_id, type) WHERE status = 'active';

CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  load_id INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('off_hours_shutdown', 'schedule', 'reduce_standby', 'maintenance_review', 'replacement')),
  title TEXT NOT NULL,
  assumption TEXT NOT NULL,                    -- the assumption behind the savings estimate
  monthly_savings_kwh REAL NOT NULL DEFAULT 0 CHECK (monthly_savings_kwh >= 0),
  monthly_savings_cop REAL NOT NULL DEFAULT 0 CHECK (monthly_savings_cop >= 0),
  score REAL NOT NULL CHECK (score >= 0),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'postponed', 'discarded')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by INTEGER REFERENCES users(id),
  accepted_at TEXT,
  postponed_until TEXT,
  reason TEXT,
  baseline_window_start TEXT,
  baseline_window_end TEXT,
  CHECK (status <> 'accepted' OR accepted_at IS NOT NULL),
  CHECK (status = 'pending' OR decided_at IS NOT NULL)
);
CREATE INDEX recommendations_site_status ON recommendations(site_id, status, score DESC);
CREATE INDEX recommendations_load ON recommendations(load_id);
CREATE UNIQUE INDEX recommendations_one_pending ON recommendations(load_id, type) WHERE status = 'pending';

CREATE TABLE control_actions (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  load_id INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'recommendation', 'closing_mode', 'autonomous')),
  recommendation_id INTEGER REFERENCES recommendations(id) ON DELETE SET NULL,
  batch_id TEXT,                               -- groups the actions of one closing-mode confirmation
  action TEXT NOT NULL CHECK (action IN ('on', 'off')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'discarded')),
  requested_by INTEGER REFERENCES users(id),   -- NULL when requested by the system
  decided_by INTEGER REFERENCES users(id),
  reason TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  executed_at TEXT,
  CHECK (status <> 'executed' OR executed_at IS NOT NULL),
  CHECK (status = 'pending' OR decided_at IS NOT NULL OR origin = 'autonomous')
);
CREATE INDEX control_actions_site_status ON control_actions(site_id, status, requested_at);
CREATE INDEX control_actions_load ON control_actions(load_id, requested_at);
CREATE INDEX control_actions_batch ON control_actions(batch_id) WHERE batch_id IS NOT NULL;

-- Audit extended in place so existing rows (event = action) are preserved.
-- result: outcome of the audited action; simulated_at: simulated clock time of the action.
ALTER TABLE audit ADD COLUMN user_id INTEGER REFERENCES users(id);
ALTER TABLE audit ADD COLUMN role TEXT REFERENCES roles(code);
ALTER TABLE audit ADD COLUMN load_id INTEGER REFERENCES loads(id);
ALTER TABLE audit ADD COLUMN result TEXT CHECK (result IS NULL OR result IN ('executed', 'rejected', 'discarded'));
ALTER TABLE audit ADD COLUMN reason TEXT;
ALTER TABLE audit ADD COLUMN simulated_at TEXT;
CREATE INDEX audit_at ON audit(at);
CREATE INDEX audit_site ON audit(site_id, at);
CREATE INDEX audit_user ON audit(user_id, at);
