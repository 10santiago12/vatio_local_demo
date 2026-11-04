-- 002: roles, sites, schedules, tariffs, settings; users rebuilt with role FK and profile columns.
-- Timestamps are ISO-8601 UTC text. Enumerations are enforced with CHECK or FK to a lookup table.

CREATE TABLE roles (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL
);
INSERT INTO roles(code, name, description) VALUES
  ('owner', 'Administrador', 'Dueño o administrador: configura cargas, tarifa e inversión, aprueba acciones y ve todo.'),
  ('operations_manager', 'Gerente de operaciones', 'Revisa alertas, gestiona recomendaciones y aprueba acciones de control.'),
  ('closing_employee', 'Empleado de cierre', 'Ejecuta el modo cierre y consulta el estado de las cargas.'),
  ('finance', 'Responsable financiero', 'Consulta costos, ahorro, retorno y reportes financieros.'),
  ('sustainability', 'Responsable de sostenibilidad', 'Consulta consumo y emisiones evitadas.'),
  ('chain_owner', 'Dueño de cadena', 'Compara y supervisa varias sedes.'),
  ('installer_technician', 'Técnico instalador', 'Registra y diagnostica módulos de medición.'),
  ('data_analyst', 'Analista de datos', 'Exporta y reimporta datos crudos.'),
  ('non_technical_employee', 'Empleado no técnico', 'Vista simple del consumo y las alertas, sin datos técnicos ni control.');

CREATE TABLE sites (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND id NOT GLOB '*[^a-z0-9-]*'),
  name TEXT NOT NULL,
  city TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Bogota',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Operating hours per weekday (0 = Sunday ... 6 = Saturday), local time HH:MM.
CREATE TABLE site_schedules (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  opens_at TEXT CHECK (opens_at IS NULL OR opens_at GLOB '[0-2][0-9]:[0-5][0-9]'),
  closes_at TEXT CHECK (closes_at IS NULL OR closes_at GLOB '[0-2][0-9]:[0-5][0-9]'),
  PRIMARY KEY (site_id, weekday),
  CHECK (closed = 1 OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at < closes_at))
) WITHOUT ROWID;

-- Users: rebuilt to enforce role FK. The legacy single role "Administrador" maps to owner;
-- any other legacy value falls back to the least-privileged role.
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  role TEXT NOT NULL REFERENCES roles(code),
  display_name TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by INTEGER REFERENCES users_new(id),
  last_login_at TEXT
);
INSERT INTO users_new(id, username, salt, hash, role)
  SELECT id, username, salt, hash,
         CASE role WHEN 'Administrador' THEN 'owner' ELSE 'non_technical_employee' END
  FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX users_role ON users(role);

-- Sites a user may see (a chain owner has several rows; the owner of a single site has one).
CREATE TABLE user_sites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
) WITHOUT ROWID;

-- Tariff history: a change applies from effective_from onwards, never backwards.
CREATE TABLE tariffs (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  cop_per_kwh REAL NOT NULL CHECK (cop_per_kwh > 0),
  effective_from TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (site_id, effective_from)
);

-- One settings row per site.
CREATE TABLE settings (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  investment_cop REAL NOT NULL DEFAULT 0 CHECK (investment_cop >= 0),
  emission_factor_kg_per_kwh REAL NOT NULL DEFAULT 0.126 CHECK (emission_factor_kg_per_kwh >= 0),
  emission_factor_source TEXT NOT NULL DEFAULT 'Valor ilustrativo configurable',
  alert_threshold_pct REAL NOT NULL DEFAULT 30 CHECK (alert_threshold_pct > 0),
  alert_window_minutes INTEGER NOT NULL DEFAULT 15 CHECK (alert_window_minutes > 0),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
