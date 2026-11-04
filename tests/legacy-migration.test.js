const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../backend/db/connection');
const { migrate, DEFAULT_DIR } = require('../backend/db/migrate');

/** A database that stopped at migration 005 (the state of the first MVP after T1) with legacy telemetry. */
function legacyDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-legacy-'));
  for (const file of fs.readdirSync(DEFAULT_DIR)) if (/^00[1-5]_/.test(file)) fs.copyFileSync(path.join(DEFAULT_DIR, file), path.join(dir, file));
  const db = openDatabase(':memory:');
  migrate(db, { dir });
  fs.rmSync(dir, { recursive: true, force: true });
  const insert = db.prepare('INSERT INTO telemetry(site_id, gateway_id, received_at, reading) VALUES(?,?,?,?)');
  const row = (site, reading, at = '2026-01-01T00:00:00.000Z') => insert.run(site, 'ESP32-DEMO-01', at, typeof reading === 'string' ? reading : JSON.stringify(reading));
  const freezer = { module_id: 'MX-001', load_id: 'freezer', load_name: 'Congelador vertical', manufacturer: 'EnerSense', voltage_v: 120.1, current_a: 3.43, energy_kwh: 0.5 };
  row('la-espiga-chia', { ...freezer, power_w: 412, timestamp: '2026-01-01T00:00:00.000Z' });
  row('la-espiga-chia', { ...freezer, power_w: 18, timestamp: '2026-01-01T00:00:05.000Z' }, '2026-01-01T00:00:05.000Z');
  row('la-espiga-chia', { ...freezer, power_w: 18, timestamp: '2026-01-01T00:00:05.000Z' }, '2026-01-01T00:00:05.000Z'); // duplicate
  row('la-espiga-chia', { module_id: 'MX-004', load_id: 'oven', manufacturer: 'VoltioLab', power_w: 5900, timestamp: '' }, '2026-01-01T00:00:07.000Z');
  row('la-espiga-chia', { module_id: 'MX-099', load_id: 'freezer', power_w: 7 }, '2026-01-01T00:00:09.000Z'); // second module on the same load
  // Rows that must be skipped, never guessed.
  row('la-espiga-chia', { power_w: 412 });
  row('la-espiga-chia', 'not json');
  row('la-espiga-chia', { module_id: 'MX-002', load_id: 'fridge', power_w: -5 });
  row('la-espiga-chia', { module_id: 'MX-002', load_id: 'fridge', power_w: 'high' });
  row('Bad Site', { module_id: 'MX-003', load_id: 'pos', power_w: 5 });
  return db;
}

test('legacy telemetry is migrated into sites, loads, modules and readings', () => {
  const db = legacyDatabase();
  const telemetryBefore = db.prepare('SELECT COUNT(*) AS n FROM telemetry').get().n;
  assert.deepEqual(migrate(db).applied.map((n) => n.slice(0, 3)), ['006', '007', '008', '009']);

  assert.equal(db.prepare("SELECT name FROM sites WHERE id = 'la-espiga-chia'").get().name, 'Panadería La Espiga – Chía');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sites WHERE id <> 'la-espiga-chia'").get().n, 0, 'invalid site slug is skipped');

  const loads = db.prepare('SELECT code, name, criticality, control_mode FROM loads ORDER BY code').all();
  assert.deepEqual(loads.map((l) => l.code), ['freezer', 'oven']);
  assert.deepEqual({ ...loads.find((l) => l.code === 'freezer') }, { code: 'freezer', name: 'Congelador vertical', criticality: 'critical', control_mode: 'monitor_only' });
  assert.equal(loads.find((l) => l.code === 'oven').criticality, 'essential');

  const modules = db.prepare('SELECT id, manufacturer, load_id, status, last_heartbeat, registered_at FROM modules ORDER BY id').all();
  assert.deepEqual(modules.map((m) => m.id), ['MX-001', 'MX-004', 'MX-099']);
  const mx1 = modules[0];
  assert.equal(mx1.manufacturer, 'EnerSense');
  assert.ok(mx1.load_id !== null);
  assert.equal(mx1.last_heartbeat, '2026-01-01T00:00:05.000Z');
  assert.equal(mx1.registered_at, '2026-01-01T00:00:00.000Z');
  // MX-099 reports the same load but a load has one module: it is registered without a load.
  assert.equal(modules[2].load_id, null);
  assert.equal(modules[2].manufacturer, 'ESP32 virtual');

  const readings = db.prepare('SELECT r.ts, r.power_w, r.voltage_v, r.current_a, r.energy_kwh, r.source, r.module_id, l.code FROM readings r JOIN loads l ON l.id = r.load_id ORDER BY r.ts, r.module_id').all();
  assert.equal(readings.length, 4, 'duplicate (load, ts) collapsed; invalid rows skipped');
  assert.deepEqual({ ...readings[0] }, { ts: '2026-01-01T00:00:00.000Z', power_w: 412, voltage_v: 120.1, current_a: 3.43, energy_kwh: 0.5, source: 'esp32', module_id: 'MX-001', code: 'freezer' });
  const oven = readings.find((r) => r.code === 'oven');
  assert.equal(oven.ts, '2026-01-01T00:00:07.000Z', 'empty device timestamp falls back to the reception time');
  assert.equal(oven.voltage_v, null);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telemetry').get().n, telemetryBefore, 'the legacy table is kept as an archive');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('the legacy migration statements are idempotent and an empty legacy table is harmless', () => {
  const db = legacyDatabase();
  migrate(db);
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const before = ['sites', 'loads', 'modules', 'readings'].map(count);
  db.exec(fs.readFileSync(path.join(DEFAULT_DIR, '007_legacy_telemetry_to_readings.sql'), 'utf8'));
  assert.deepEqual(['sites', 'loads', 'modules', 'readings'].map(count), before);

  const empty = openDatabase(':memory:');
  assert.equal(migrate(empty).version, 9);
  assert.equal(empty.prepare('SELECT COUNT(*) AS n FROM readings').get().n, 0);
  assert.equal(empty.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 0);
});
