const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../backend/db/connection');
const { migrate, DEFAULT_DIR, MigrationError } = require('../backend/db/migrate');
const { createRepositories } = require('../backend/db/repositories');

function freshDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}
function seeded() {
  const db = freshDb();
  const repos = createRepositories(db);
  repos.sites.create({ id: 'la-espiga-chia', name: 'Panadería La Espiga', city: 'Chía' });
  const user = repos.users.create({ username: 'ana', salt: 's', hash: 'h', role: 'owner' });
  const freezer = repos.loads.create({ siteId: 'la-espiga-chia', code: 'freezer', name: 'Congelador', criticality: 'critical' });
  const oven = repos.loads.create({ siteId: 'la-espiga-chia', code: 'oven', name: 'Horno', criticality: 'non_essential', controlMode: 'control_enabled' });
  return { db, repos, user, freezer, oven };
}
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);

test('full schema applies to an empty database and seeds the nine roles', () => {
  const db = freshDb();
  const expected = ['alerts', 'audit', 'baselines', 'control_actions', 'control_requests', 'error_log', 'events', 'loads', 'modules', 'readings',
    'readings_hourly', 'recommendations', 'roles', 'schema_migrations', 'settings', 'site_schedules', 'sites', 'tariffs', 'telemetry', 'user_sites', 'users'];
  for (const name of expected) assert.ok(tables(db).includes(name), `missing table ${name}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM roles').get().n, 9);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('migrating twice changes nothing', () => {
  const db = freshDb();
  assert.deepEqual(migrate(db).applied, []);
});

test('editing an applied real migration is detected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-real-'));
  try {
    for (const file of fs.readdirSync(DEFAULT_DIR)) fs.copyFileSync(path.join(DEFAULT_DIR, file), path.join(dir, file));
    const db = openDatabase(':memory:');
    migrate(db, { dir });
    fs.appendFileSync(path.join(dir, '003_loads_modules_readings.sql'), '\n-- tampered\n');
    assert.throws(() => migrate(db, { dir }), MigrationError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('upgrade from a database created by migration 001 keeps existing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-v1-'));
  try {
    fs.copyFileSync(path.join(DEFAULT_DIR, '001_initial_schema.sql'), path.join(dir, '001_initial_schema.sql'));
    const db = openDatabase(':memory:');
    assert.equal(migrate(db, { dir }).version, 1);
    db.exec(`INSERT INTO users(username, salt, hash, role) VALUES ('admin', 'aa', 'bb', 'Administrador'), ('legacy', 'cc', 'dd', 'Visor');
      INSERT INTO telemetry(site_id, gateway_id, received_at, reading) VALUES ('la-espiga-chia', 'ESP32-DEMO-01', '2026-01-01T00:00:00Z', '{"power_w":412}');
      INSERT INTO audit(at, actor, event, site_id, details) VALUES ('2026-01-01T00:00:00Z', 'admin', 'login', NULL, '{}');
      INSERT INTO control_requests(site_id, load_id, action, status, requested_by, created_at) VALUES ('la-espiga-chia', 'oven', 'off', 'pending', 'admin', '2026-01-01T00:00:00Z');`);
    const result = migrate(db);
    assert.deepEqual(result.applied.map((n) => n.slice(0, 3)), ['002', '003', '004', '005', '006', '007', '008', '009']);
    const users = db.prepare('SELECT username, role, active FROM users ORDER BY id').all();
    assert.equal(users[0].role, 'owner');
    assert.equal(users[1].role, 'non_technical_employee');
    assert.equal(users[0].active, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telemetry').get().n, 1);
    const audit = db.prepare('SELECT event, result, load_id FROM audit').get();
    assert.equal(audit.event, 'login');
    assert.equal(audit.result, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM control_requests').get().n, 1);
    // Self-reference of users.created_by must follow the rename.
    assert.equal(db.prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('users') WHERE \"from\" = 'created_by'").get().t, 'users');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('constraints reject invalid enumerations and states', () => {
  const { db, user, freezer, oven } = seeded();
  const bad = (sql, ...params) => assert.throws(() => db.prepare(sql).run(...params), /constraint/i, sql);
  bad("INSERT INTO sites(id, name) VALUES('Bad Slug', 'x')");
  bad("INSERT INTO users(username, salt, hash, role) VALUES('x', 's', 'h', 'superuser')");
  bad("INSERT INTO loads(site_id, code, name, criticality) VALUES('la-espiga-chia', 'a', 'A', 'vital')");
  bad("INSERT INTO loads(site_id, code, name, control_mode) VALUES('la-espiga-chia', 'b', 'B', 'auto')");
  bad("INSERT INTO loads(site_id, code, name, criticality, control_mode) VALUES('la-espiga-chia', 'c', 'C', 'critical', 'control_enabled')");
  bad("UPDATE loads SET control_mode = 'control_enabled' WHERE id = ?", freezer.id);
  bad("INSERT INTO modules(id, site_id, manufacturer, status) VALUES('MX-9', 'la-espiga-chia', 'X', 'broken')");
  bad("INSERT INTO readings(load_id, ts, power_w) VALUES(?, '2026-01-01T00:00:00Z', -1)", oven.id);
  bad("INSERT INTO readings(load_id, ts, power_w, source) VALUES(?, '2026-01-01T00:00:00Z', 1, 'telepathy')", oven.id);
  bad("INSERT INTO alerts(site_id, load_id, type, detected_at, message) VALUES('la-espiga-chia', ?, 'gossip', 't', 'm')", oven.id);
  bad("INSERT INTO alerts(site_id, load_id, type, status, detected_at, message) VALUES('la-espiga-chia', ?, 'consumption', 'reviewed', 't', 'm')", oven.id);
  bad("INSERT INTO recommendations(site_id, load_id, type, title, assumption, score, confidence, created_at) VALUES('la-espiga-chia', ?, 'off_hours_shutdown', 't', 'a', 1, 1.5, 't')", oven.id);
  bad("INSERT INTO recommendations(site_id, load_id, type, title, assumption, score, confidence, status, created_at) VALUES('la-espiga-chia', ?, 'schedule', 't', 'a', 1, 0.5, 'accepted', 't')", oven.id);
  bad("INSERT INTO control_actions(site_id, load_id, origin, action, requested_at) VALUES('la-espiga-chia', ?, 'telepathy', 'off', 't')", oven.id);
  bad("INSERT INTO control_actions(site_id, load_id, origin, action, status, requested_at) VALUES('la-espiga-chia', ?, 'manual', 'off', 'teleported', 't')", oven.id);
  bad("INSERT INTO control_actions(site_id, load_id, origin, action, status, requested_at, decided_at) VALUES('la-espiga-chia', ?, 'manual', 'off', 'executed', 't', 't')", oven.id);
  bad("INSERT INTO audit(at, actor, event, details, result) VALUES('t', 'a', 'e', '{}', 'maybe')");
  bad("INSERT INTO error_log(at, level, source, message) VALUES('t', 'panic', 's', 'm')");
  bad("INSERT INTO baselines(load_id, day_type, hour, mean_w, std_w, band_low_w, band_high_w, sample_days, window_start, window_end) VALUES(?, 'holiday', 1, 1, 1, 0, 3, 7, 'a', 'b')", oven.id);
  bad("INSERT INTO tariffs(site_id, cop_per_kwh, effective_from) VALUES('la-espiga-chia', 0, '2026-01-01')");
  bad("INSERT INTO user_sites(user_id, site_id) VALUES(?, 'missing-site')", user.id);
});

test('new loads default to monitor_only and essential', () => {
  const { repos } = seeded();
  const load = repos.loads.create({ siteId: 'la-espiga-chia', code: 'tv', name: 'Televisor' });
  assert.equal(load.criticality, 'essential');
  assert.equal(load.control_mode, 'monitor_only');
  assert.equal(load.power_state, 'on');
});

test('reference repositories: users, sites, schedule, tariffs, settings', () => {
  const { repos, user } = seeded();
  assert.equal(repos.users.getByUsername('ana').id, user.id);
  assert.equal(repos.users.setRole(user.id, 'finance'), true);
  assert.equal(repos.users.getById(user.id).role, 'finance');
  assert.equal(repos.users.setActive(user.id, false), true);
  repos.users.grantSite(user.id, 'la-espiga-chia');
  repos.users.grantSite(user.id, 'la-espiga-chia');
  assert.equal(repos.users.sitesFor(user.id).length, 1);
  assert.equal(repos.roles.list().length, 9);
  assert.equal(repos.roles.get('nope'), null);

  repos.sites.setSchedule('la-espiga-chia', 1, { opensAt: '06:00', closesAt: '20:00' });
  repos.sites.setSchedule('la-espiga-chia', 0, { opensAt: '07:00', closesAt: '13:00' });
  repos.sites.setSchedule('la-espiga-chia', 0, { opensAt: '07:00', closesAt: '14:00' });
  assert.equal(repos.sites.getSchedule('la-espiga-chia').length, 2);
  assert.equal(repos.sites.getSchedule('la-espiga-chia')[0].closes_at, '14:00');
  assert.throws(() => repos.sites.setSchedule('la-espiga-chia', 2, { opensAt: '20:00', closesAt: '06:00' }), /constraint/i);

  repos.tariffs.create({ siteId: 'la-espiga-chia', copPerKwh: 950, effectiveFrom: '2026-01-01T00:00:00Z' });
  repos.tariffs.create({ siteId: 'la-espiga-chia', copPerKwh: 1000, effectiveFrom: '2026-03-01T00:00:00Z' });
  assert.equal(repos.tariffs.effectiveAt('la-espiga-chia', '2026-02-15T00:00:00Z').cop_per_kwh, 950);
  assert.equal(repos.tariffs.effectiveAt('la-espiga-chia', '2026-03-01T00:00:00Z').cop_per_kwh, 1000);
  assert.equal(repos.tariffs.effectiveAt('la-espiga-chia', '2025-12-31T00:00:00Z'), null);

  const defaults = repos.settings.get('la-espiga-chia');
  assert.equal(defaults.alert_threshold_pct, 30);
  assert.equal(defaults.alert_window_minutes, 15);
  const updated = repos.settings.update('la-espiga-chia', { investment_cop: 1800000, alert_threshold_pct: 25, ignored: 1 }, { updatedBy: user.id });
  assert.equal(updated.investment_cop, 1800000);
  assert.equal(updated.alert_threshold_pct, 25);
});

test('measurement repositories: loads, modules, readings, aggregates, baselines', () => {
  const { repos, oven, freezer, user } = seeded();
  assert.equal(repos.loads.getByCode('la-espiga-chia', 'oven').id, oven.id);
  assert.equal(repos.loads.updateConfig(oven.id, { criticality: 'essential' }).criticality, 'essential');
  assert.equal(repos.loads.setPowerState(oven.id, 'off'), true);
  assert.equal(repos.loads.get(oven.id).power_state, 'off');
  assert.throws(() => repos.loads.updateConfig(freezer.id, { controlMode: 'control_enabled' }), /constraint/i);

  repos.modules.register({ id: 'MX-001', siteId: 'la-espiga-chia', loadId: freezer.id, manufacturer: 'EnerSense', registeredBy: user.id });
  assert.throws(() => repos.modules.register({ id: 'MX-002', siteId: 'la-espiga-chia', loadId: freezer.id, manufacturer: 'VoltioLab' }), /constraint/i);
  repos.modules.setStatus('MX-001', 'inactive');
  repos.modules.heartbeat('MX-001', '2026-01-01T00:05:00Z');
  const module = repos.modules.get('MX-001');
  assert.equal(module.status, 'active');
  assert.equal(module.last_heartbeat, '2026-01-01T00:05:00Z');
  assert.equal(repos.modules.listBySite('la-espiga-chia').length, 1);

  const rows = [];
  for (let m = 0; m < 120; m++) {
    const ts = new Date(Date.UTC(2026, 0, 1, 10, m)).toISOString();
    rows.push({ loadId: oven.id, moduleId: null, ts, powerW: m < 60 ? 1000 : 2000 });
  }
  assert.equal(repos.readings.insertMany(rows), 120);
  assert.equal(repos.readings.insertMany(rows), 0, 'reinserting the same timestamps is ignored');
  assert.equal(repos.readings.range(oven.id, '2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z').length, 60);
  assert.equal(repos.readings.latest(oven.id).power_w, 2000);
  assert.throws(() => repos.readings.insertMany([{ loadId: oven.id, ts: '2027-01-01T00:00:00Z', powerW: 5 }, { loadId: oven.id, ts: '2027-01-01T00:01:00Z', powerW: -5 }]), /constraint/i);
  assert.equal(repos.readings.range(oven.id, '2027-01-01', '2028-01-01').length, 0, 'a failed batch is rolled back');

  assert.equal(repos.readings.aggregateHourly(oven.id, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'), 2);
  const hourly = repos.readings.hourlyRange(oven.id, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  assert.equal(hourly[0].hour_start, '2026-01-01T10:00:00.000Z');
  assert.equal(hourly[0].avg_power_w, 1000);
  assert.equal(hourly[1].energy_kwh, 2);
  assert.equal(repos.readings.pruneRawBefore('2026-01-01T11:00:00.000Z'), 60);

  const base = { loadId: oven.id, dayType: 'workday', hour: 6, meanW: 1000, stdW: 100, bandLowW: 800, bandHighW: 1200, sampleDays: 7, windowStart: '2026-01-01', windowEnd: '2026-01-08' };
  repos.baselines.upsertMany([base, { ...base, hour: 7 }]);
  repos.baselines.upsertMany([{ ...base, meanW: 1100 }]);
  assert.equal(repos.baselines.latestForLoad(oven.id).length, 2);
  assert.equal(repos.baselines.at(oven.id, 'workday', 6).mean_w, 1100);
  assert.equal(repos.baselines.at(oven.id, 'sunday', 6), null);
});

test('operations repositories: alerts, recommendations, control actions', () => {
  const { repos, oven, user } = seeded();
  const alert = repos.alerts.create({ siteId: 'la-espiga-chia', loadId: oven.id, type: 'consumption', detectedAt: '2026-01-01T10:00:00Z', excessPct: 42, message: 'Exceso', details: { window: 15 } });
  assert.equal(alert.status, 'active');
  assert.equal(JSON.parse(alert.details).window, 15);
  assert.equal(repos.alerts.findActive(oven.id, 'consumption').id, alert.id);
  assert.throws(() => repos.alerts.create({ siteId: 'la-espiga-chia', loadId: oven.id, type: 'consumption', detectedAt: 't', message: 'dup' }), /constraint/i);
  assert.equal(repos.alerts.countActive('la-espiga-chia'), 1);
  assert.equal(repos.alerts.review(alert.id, user.id, '2026-01-01T10:30:00Z'), true);
  assert.equal(repos.alerts.review(alert.id, user.id, '2026-01-01T10:31:00Z'), false);
  assert.equal(repos.alerts.get(alert.id).status, 'reviewed');
  assert.equal(repos.alerts.list({ status: 'active' }).length, 0);
  repos.alerts.create({ siteId: 'la-espiga-chia', loadId: oven.id, type: 'consumption', detectedAt: '2026-01-02T00:00:00Z', message: 'again' });
  assert.equal(repos.alerts.list({ siteId: 'la-espiga-chia' }).length, 2);

  const low = repos.recommendations.create({ siteId: 'la-espiga-chia', loadId: oven.id, type: 'schedule', title: 'Programar', assumption: 'a', score: 10, confidence: 0.5, createdAt: '2026-01-01T00:00:00Z' });
  const high = repos.recommendations.create({ siteId: 'la-espiga-chia', loadId: oven.id, type: 'off_hours_shutdown', title: 'Apagar', assumption: 'a', monthlySavingsKwh: 100, monthlySavingsCop: 95000, score: 90, confidence: 0.9, createdAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual(repos.recommendations.list({ status: 'pending' }).map((r) => r.id), [high.id, low.id]);
  assert.equal(repos.recommendations.decide(low.id, { status: 'postponed', userId: user.id, at: '2026-01-02T00:00:00Z', postponedUntil: '2026-01-09T00:00:00Z' }), true);
  assert.equal(repos.recommendations.decide(low.id, { status: 'accepted', userId: user.id, at: '2026-01-03T00:00:00Z' }), true);
  assert.equal(repos.recommendations.get(low.id).accepted_at, '2026-01-03T00:00:00Z');
  assert.equal(repos.recommendations.decide(low.id, { status: 'discarded', userId: user.id, at: '2026-01-04T00:00:00Z' }), false, 'accepted is final');
  assert.equal(repos.recommendations.decide(high.id, { status: 'discarded', userId: user.id, at: '2026-01-04T00:00:00Z', reason: 'No aplica' }), true);
  assert.equal(repos.recommendations.get(high.id).reason, 'No aplica');

  const action = repos.controlActions.create({ siteId: 'la-espiga-chia', loadId: oven.id, origin: 'recommendation', recommendationId: low.id, action: 'off', requestedBy: user.id, requestedAt: '2026-01-03T00:00:00Z' });
  assert.equal(action.status, 'pending');
  assert.equal(repos.controlActions.transition(action.id, { status: 'approved', decidedBy: user.id, at: '2026-01-03T00:01:00Z' }), true);
  assert.equal(repos.controlActions.transition(action.id, { status: 'executed', decidedBy: user.id, at: '2026-01-03T00:02:00Z' }), true);
  assert.equal(repos.controlActions.get(action.id).executed_at, '2026-01-03T00:02:00Z');
  assert.equal(repos.controlActions.transition(action.id, { status: 'discarded', at: '2026-01-03T00:03:00Z' }), false, 'executed is final');
  assert.equal(repos.controlActions.list({ status: 'executed' }).length, 1);
});

test('audit, events and error log repositories', () => {
  const { repos, oven, user } = seeded();
  repos.audit.append({ actor: 'ana', userId: user.id, role: 'owner', event: 'control_requested', siteId: 'la-espiga-chia', loadId: oven.id, result: 'rejected', reason: 'Carga crítica', simulatedAt: '2026-01-01T03:00:00Z' });
  repos.audit.append({ actor: 'anonymous', event: 'login_failed' });
  assert.equal(repos.audit.list().length, 2);
  const rejected = repos.audit.list({ result: 'rejected' });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'Carga crítica');
  assert.equal(JSON.parse(rejected[0].details).constructor, Object);

  repos.events.track({ name: 'alert_reviewed', userId: user.id, properties: { alert: 1 } });
  assert.equal(repos.events.list({ name: 'alert_reviewed' }).length, 1);
  repos.errors.log({ level: 'error', source: 'http', message: 'boom', context: { path: '/api/x' }, requestId: 'r1' });
  assert.equal(repos.errors.list({ level: 'error' })[0].message, 'boom');
  assert.equal(repos.errors.list({ level: 'fatal' }).length, 0);
});
