const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../backend/db/connection');
const { migrate, MigrationError, DEFAULT_DIR } = require('../backend/db/migrate');

function tempMigrations(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-mig-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

const BASE = {
  '001_one.sql': 'CREATE TABLE one (id INTEGER PRIMARY KEY, label TEXT);',
  '002_two.sql': 'CREATE TABLE two (id INTEGER PRIMARY KEY, one_id INTEGER REFERENCES one(id));'
};

test('applies migrations in order and records version, name and checksum', () => {
  const dir = tempMigrations(BASE);
  try {
    const db = openDatabase(':memory:');
    const result = migrate(db, { dir });
    assert.deepEqual(result.applied, ['001_one', '002_two']);
    assert.equal(result.version, 2);
    const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    assert.equal(rows.length, 2);
    assert.match(rows[0].checksum, /^[0-9a-f]{64}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('is idempotent: a second run applies nothing', () => {
  const dir = tempMigrations(BASE);
  try {
    const db = openDatabase(':memory:');
    migrate(db, { dir });
    const again = migrate(db, { dir });
    assert.deepEqual(again.applied, []);
    assert.equal(again.version, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refuses to run when an applied migration file was modified', () => {
  const dir = tempMigrations(BASE);
  try {
    const db = openDatabase(':memory:');
    migrate(db, { dir });
    fs.writeFileSync(path.join(dir, '001_one.sql'), BASE['001_one.sql'] + '\nCREATE TABLE sneaky (id INTEGER);');
    assert.throws(() => migrate(db, { dir }), (e) => e instanceof MigrationError && /modified/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('checksum ignores line-ending differences (Windows checkouts)', () => {
  const multiline = 'CREATE TABLE two (\n  id INTEGER PRIMARY KEY\n);\n';
  const dir = tempMigrations({ '001_one.sql': multiline });
  try {
    const db = openDatabase(':memory:');
    migrate(db, { dir });
    fs.writeFileSync(path.join(dir, '001_one.sql'), multiline.replace(/\n/g, '\r\n'));
    assert.deepEqual(migrate(db, { dir }).applied, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refuses when an applied migration file is missing or a new one is out of order', () => {
  const dir = tempMigrations(BASE);
  try {
    const db = openDatabase(':memory:');
    migrate(db, { dir });
    fs.writeFileSync(path.join(dir, '000_late.sql'), 'CREATE TABLE late (id INTEGER);');
    assert.throws(() => migrate(db, { dir }), /older than the latest/);
    fs.rmSync(path.join(dir, '000_late.sql'));
    fs.rmSync(path.join(dir, '002_two.sql'));
    assert.throws(() => migrate(db, { dir }), /missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failing migration rolls back completely and is not recorded', () => {
  const dir = tempMigrations({ ...BASE, '003_bad.sql': 'CREATE TABLE three (id INTEGER); INSERT INTO nonexistent VALUES (1);' });
  try {
    const db = openDatabase(':memory:');
    assert.throws(() => migrate(db, { dir }), /003_bad\.sql failed/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'three'").get().n, 0);
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejects duplicate migration versions', () => {
  const dir = tempMigrations({ '001_a.sql': 'SELECT 1;', '001_b.sql': 'SELECT 1;' });
  try {
    assert.throws(() => migrate(openDatabase(':memory:'), { dir }), /Duplicate migration version 1/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migration 001 adopts a database created by the legacy inline schema without data loss', () => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-legacy-'));
  const dir = tempMigrations({ '001_initial_schema.sql': fs.readFileSync(path.join(DEFAULT_DIR, '001_initial_schema.sql'), 'utf8') });
  try {
    const db = openDatabase(path.join(legacy, 'legacy.sqlite'));
    // Exactly what the pre-migration code created at startup.
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE telemetry (id INTEGER PRIMARY KEY, site_id TEXT NOT NULL, gateway_id TEXT NOT NULL, received_at TEXT NOT NULL, reading TEXT NOT NULL);
      CREATE INDEX telemetry_site_time ON telemetry(site_id, received_at);
      CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, site_id TEXT, details TEXT NOT NULL);
      CREATE TABLE control_requests (id INTEGER PRIMARY KEY, site_id TEXT NOT NULL, load_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO users(username, salt, hash, role) VALUES ('admin', 'aa', 'bb', 'Administrador');
      INSERT INTO telemetry(site_id, gateway_id, received_at, reading) VALUES ('la-espiga-chia', 'ESP32-DEMO-01', '2026-01-01T00:00:00Z', '{"power_w":412}');`);
    assert.deepEqual(migrate(db, { dir }).applied, ['001_initial_schema']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.equal(db.prepare('SELECT reading FROM telemetry').get().reading, '{"power_w":412}');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(legacy, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
