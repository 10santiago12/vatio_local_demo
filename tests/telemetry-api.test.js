const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../backend/db/connection');
const { createRepositories } = require('../backend/db/repositories');
const enersense = require('../backend/adapters/manufacturers/enersense');
const voltiolab = require('../backend/adapters/manufacturers/voltiolab');

const ROOT = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-telemetry-'));
const dbFile = path.join(temp, 'telemetry.sqlite');
const port = 31877;
const base = `http://127.0.0.1:${port}`;
const KEY = 'test-device-secret';
const PASSWORD = 'test-only-strong-password';
const env = {
  ...process.env, PORT: String(port), HOST: '127.0.0.1', APP_ENV: 'local', VATIO_ENV_FILE: path.join(temp, 'absent.env'), VATIO_DB: dbFile,
  VATIO_ADMIN_PASSWORD: PASSWORD, VATIO_DEVICE_KEY: KEY,
};
let child;

const post = async (url, body, headers = {}) => {
  const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const device = (body) => post('/api/telemetry', body, { 'x-device-key': KEY });
const esp = (over = {}) => ({ module_id: 'MX-001', load_id: 'freezer', load_name: 'Congelador vertical', manufacturer: 'EnerSense', voltage_v: 120.1, current_a: 3.43, power_w: 412, energy_kwh: 0.123, status: 'active', timestamp: '', ...over });
const gateway = (readings, extra = {}) => ({ gateway_id: 'ESP32-DEMO-01', site_id: 'la-espiga-chia', readings, ...extra });
async function authed(url, options = {}) {
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await login.json()).csrf;
  const response = await fetch(base + url, { ...options, headers: { cookie, 'x-csrf-token': csrf, ...(options.headers || {}) } });
  return { status: response.status, body: await response.json() };
}
const rows = (sql, ...params) => { const db = openDatabase(dbFile); try { return db.prepare(sql).all(...params); } finally { db.close(); } };

async function waitForServer() {
  for (let n = 0; n < 100; n += 1) {
    try { await fetch(base + '/api/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('Server failed to start');
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env });
  await waitForServer();
});
after(async () => {
  if (child && child.exitCode === null) { const closed = new Promise((r) => child.once('exit', r)); child.kill(); await closed; }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('before any device reports, the simulator is the reading source (11 loads, two manufacturers)', async () => {
  const latest = await authed('/api/telemetry/latest');
  assert.equal(latest.body.source, 'simulator');
  assert.equal(latest.body.readings.length, 11);
  assert.deepEqual([...new Set(latest.body.readings.map((r) => r.manufacturer))].sort(), ['EnerSense', 'VoltioLab']);
  const freezer = latest.body.readings.find((r) => r.load_id === 'freezer');
  assert.equal(freezer.module_id, 'MX-001');
  assert.ok(freezer.voltage_v > 117 && freezer.voltage_v < 123);
  assert.equal((await (await fetch(base + '/api/health')).json()).source, 'simulator');
});

test('ESP32 payload format works unchanged: 401 without the device key, 200 with it', async () => {
  const payload = gateway([esp(), esp({ module_id: 'MX-002', load_id: 'fridge', manufacturer: 'VoltioLab', power_w: 395 })]);
  const denied = await post('/api/telemetry', payload);
  assert.equal(denied.status, 401);
  const wrong = await post('/api/telemetry', payload, { 'x-device-key': 'nope' });
  assert.equal(wrong.status, 401);
  const ok = await device(payload);
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.ok, ok.body.received, ok.body.accepted, ok.body.duplicates, ok.body.rejected.length], [true, 2, 2, 0, 0]);
  assert.match(ok.body.received_at, /^\d{4}-\d{2}-\d{2}T/);
  // Stored in the product tables (module registry + readings), not only in the legacy table.
  assert.deepEqual(rows("SELECT id, manufacturer, status FROM modules WHERE id IN ('MX-001', 'MX-002') ORDER BY id").map((m) => [m.id, m.manufacturer, m.status]), [['MX-001', 'EnerSense', 'active'], ['MX-002', 'VoltioLab', 'active']]);
  const stored = rows("SELECT r.power_w, r.source, l.code FROM readings r JOIN loads l ON l.id = r.load_id WHERE r.source = 'esp32' ORDER BY l.code");
  assert.deepEqual(stored.map((r) => [r.code, r.power_w, r.source]), [['freezer', 412, 'esp32'], ['fridge', 395, 'esp32']]);
  assert.equal(rows('SELECT COUNT(*) AS n FROM telemetry')[0].n, 0, 'the legacy table is no longer written');
});

test('latest readings switch to the ESP32 and history lists the stored batches', async () => {
  const latest = await authed('/api/telemetry/latest');
  assert.equal(latest.body.source, 'esp32');
  assert.equal(latest.body.gateway.gateway_id, 'ESP32-DEMO-01');
  assert.deepEqual(latest.body.readings.map((r) => [r.module_id, r.load_id, r.power_w]), [['MX-001', 'freezer', 412], ['MX-002', 'fridge', 395]]);
  assert.equal(latest.body.readings[0].effective_status, 'active');
  const history = await authed('/api/telemetry/history?limit=10');
  assert.equal(history.body.count, 2);
  assert.equal(history.body.readings[0].site_id, 'la-espiga-chia');
});

test('the two simulated manufacturer formats are accepted through the same endpoint', async () => {
  const ts = new Date(Date.now() - 60000).toISOString();
  const a = await device({ site_id: 'la-espiga-chia', format: 'enersense', readings: [enersense.encode({ moduleId: 'MX-003', loadCode: 'pos', loadName: null, manufacturer: 'EnerSense', ts, powerW: 121, voltageV: 120, currentA: 1.008, energyKwh: 2, status: 'active' })] });
  const b = await device({ site_id: 'la-espiga-chia', readings: [voltiolab.encode({ moduleId: 'MX-004', loadCode: 'oven', loadName: null, manufacturer: 'VoltioLab', ts, powerW: 5900, voltageV: 119.8, currentA: 49.25, energyKwh: 3, status: 'active' })] });
  assert.deepEqual([a.status, a.body.accepted, b.status, b.body.accepted], [200, 1, 200, 1]);
  const stored = rows("SELECT m.manufacturer, r.power_w FROM readings r JOIN modules m ON m.id = r.module_id WHERE m.id IN ('MX-003', 'MX-004') ORDER BY m.id");
  assert.deepEqual(stored.map((r) => [r.manufacturer, r.power_w]), [['EnerSense', 121], ['VoltioLab', 5900]]);
});

test('re-sending a batch is idempotent', async () => {
  const ts = new Date(Date.now() - 120000).toISOString();
  const payload = gateway([esp({ timestamp: ts })]);
  assert.equal((await device(payload)).body.accepted, 1);
  const again = await device(payload);
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.accepted, again.body.duplicates], [0, 1]);
});

test('offline buffer sync over HTTP: 600 readings, 0 lost', async () => {
  const start = Date.now() - 700 * 60000;
  const readings = Array.from({ length: 600 }, (_, i) => enersense.encode({
    moduleId: 'MX-005', loadCode: 'coffee', loadName: null, manufacturer: 'EnerSense', ts: new Date(start + i * 60000).toISOString(),
    powerW: 150, voltageV: 120, currentA: 1.25, energyKwh: i / 400, status: 'active',
  }));
  const sync = await device({ site_id: 'la-espiga-chia', gateway_id: 'ESP32-DEMO-01', format: 'enersense', buffered: true, expected: 600, readings });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.accepted, 600);
  assert.equal(sync.body.sync.lost, 0);
  assert.equal(sync.body.sync.message, 'Se sincronizaron 600 lecturas, 0 perdidas');
  const tooMany = await device({ site_id: 'la-espiga-chia', readings: Array.from({ length: 101 }, () => esp()) });
  assert.equal(tooMany.status, 400);
});

test('bad payloads are rejected with a reason; a partial batch stores the valid readings', async () => {
  const invalidJson = await post('/api/telemetry', '{not json', { 'x-device-key': KEY });
  assert.equal(invalidJson.status, 400);
  assert.equal((await device({ gateway_id: 'ESP32-DEMO-01', site_id: 'la-espiga-chia', readings: [] })).status, 400);
  assert.equal((await device({ readings: [esp()] })).status, 400, 'site_id is required');
  assert.equal((await device(gateway([esp()], { site_id: 'nowhere' }))).status, 400);
  assert.equal((await device(gateway([esp()], { gateway_id: 'bad gateway!' }))).status, 400);
  const allBad = await device(gateway([esp({ power_w: -5 }), esp({ power_w: 'x' })]));
  assert.equal(allBad.status, 400);
  assert.equal(allBad.body.rejected.length, 2);
  const partial = await device(gateway([esp({ module_id: 'MX-006', load_id: 'ac', timestamp: new Date(Date.now() - 30000).toISOString() }), esp({ power_w: Number.MAX_SAFE_INTEGER })]));
  assert.equal(partial.status, 200);
  assert.deepEqual([partial.body.accepted, partial.body.rejected.length, partial.body.rejected[0].code], [1, 1, 'out_of_range']);
});

test('reset returns the live view to the simulator without deleting stored readings', async () => {
  const before = rows("SELECT COUNT(*) AS n FROM readings WHERE source = 'esp32'")[0].n;
  assert.ok(before > 600);
  assert.equal((await authed('/api/reset', { method: 'POST' })).status, 200);
  assert.equal((await authed('/api/telemetry/latest')).body.source, 'simulator');
  assert.equal((await authed('/api/telemetry/history')).body.count, 0);
  assert.equal(rows("SELECT COUNT(*) AS n FROM readings WHERE source = 'esp32'")[0].n, before);
});

test('seeded simulator data is readable by the repositories and the server keeps working on it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-telemetry-seeded-'));
  const seededPort = port + 1;
  const seededEnv = { ...env, PORT: String(seededPort), VATIO_DB: path.join(dir, 'seeded.sqlite') };
  let server;
  try {
    const seeded = spawnSync(process.execPath, ['scripts/seed-demo.js'], { cwd: ROOT, env: seededEnv, encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);
    const db = openDatabase(seededEnv.VATIO_DB);
    const repos = createRepositories(db);
    const freezer = repos.loads.getByCode('la-espiga-chia', 'freezer');
    assert.ok(repos.readings.latest(freezer.id));
    assert.equal(repos.loads.listBySite('la-espiga-chia').length, 11);
    db.close();

    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: seededEnv });
    for (let n = 0; n < 100; n += 1) { try { await fetch(`http://127.0.0.1:${seededPort}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const ingest = await fetch(`http://127.0.0.1:${seededPort}/api/telemetry`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-device-key': KEY }, body: JSON.stringify(gateway([esp({ timestamp: new Date(Date.now() - 1000).toISOString() })])),
    });
    assert.equal(ingest.status, 200);
    const check = openDatabase(seededEnv.VATIO_DB);
    const module1 = createRepositories(check).modules.get('MX-001');
    assert.equal(module1.manufacturer, 'EnerSense', 'the seeded registry entry is reused, not duplicated');
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM modules WHERE load_id = ?").get(freezer.id).n, 1);
    check.close();
  } finally {
    if (server && server.exitCode === null) { const closed = new Promise((r) => server.once('exit', r)); server.kill(); await closed; }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('health: production hides network details, local profile keeps them; both report version and uptime', async () => {
  const { startApp } = require('./helpers/api');
  const prod = await startApp({ seed: false, env: { APP_ENV: 'production', VATIO_ADMIN_PASSWORD: 'a-very-long-unique-password', VATIO_DEVICE_KEY: 'device-key-unique-0123456789' } });
  const local = await startApp({ seed: false });
  try {
    const p = await (await fetch(`${prod.base}/api/health`)).json();
    assert.deepEqual(Object.keys(p).sort(), ['ok', 'server_time', 'service', 'source', 'uptime_s', 'version']);
    assert.match(p.version, /^\d+\.\d+\.\d+/);
    const l = await (await fetch(`${local.base}/api/health`)).json();
    assert.ok(Array.isArray(l.local_ips) && 'port' in l && l.uptime_s >= 0);
  } finally { prod.close(); local.close(); }
});
