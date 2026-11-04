const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIngestion, envelopeFromPayload, IngestionError } = require('../backend/app/ingestion');
const { createEngine } = require('../backend/adapters/simulator/engine');
const { createModuleFleet } = require('../backend/adapters/simulator/module-fleet');
const enersense = require('../backend/adapters/manufacturers/enersense');
const voltiolab = require('../backend/adapters/manufacturers/voltiolab');
const { createTestEnv, frozenClock, ANCHOR } = require('./helpers/db');

const SITE = 'la-espiga-chia';
const MIN = 60000;
const esp = (over = {}) => ({ module_id: 'MX-001', load_id: 'freezer', load_name: 'Congelador vertical', manufacturer: 'EnerSense', voltage_v: 120.1, current_a: 3.43, power_w: 412, energy_kwh: 0.123, status: 'active', timestamp: '', ...over });
const setup = (options) => {
  const env = createTestEnv();
  return { ...env, ingestion: createIngestion({ repos: env.repos, clock: env.clock, options }) };
};

test('ESP32 payload: registers the module and load, stores the reading, stamps reception time', () => {
  const { repos, clock, ingestion } = setup({ autoRegister: true });
  const r = ingestion.ingest({ siteId: SITE, gatewayId: 'ESP32-DEMO-01', readings: [esp(), esp({ module_id: 'MX-002', load_id: 'fridge', manufacturer: 'VoltioLab', power_w: 395 })] });
  assert.deepEqual([r.received, r.accepted, r.duplicates, r.rejected.length, r.sync], [2, 2, 0, 0, null]);
  assert.equal(r.receivedAt, new Date(clock.now()).toISOString());
  const module1 = repos.modules.get('MX-001');
  assert.equal(module1.manufacturer, 'EnerSense');
  assert.equal(module1.status, 'active');
  assert.equal(module1.last_heartbeat, r.receivedAt);
  const load = repos.loads.getByCode(SITE, 'freezer');
  assert.equal(load.name, 'Congelador vertical');
  assert.equal(load.control_mode, 'monitor_only');
  assert.equal(load.criticality, 'essential');
  const stored = repos.readings.latest(load.id);
  assert.equal(stored.ts, r.receivedAt);
  assert.equal(stored.source, 'esp32');
  assert.equal(stored.power_w, 412);
  assert.equal(stored.module_id, 'MX-001');
});

test('both manufacturer formats go through the same path and produce the same stored shape', () => {
  const { repos, ingestion } = setup({ autoRegister: true });
  const base = { moduleId: 'MX-010', loadCode: 'mixer', loadName: null, manufacturer: 'EnerSense', ts: new Date(ANCHOR - MIN).toISOString(), powerW: 1500, voltageV: 119.6, currentA: 12.542, energyKwh: 3.2, status: 'active' };
  const a = ingestion.ingest({ siteId: SITE, format: 'enersense', source: 'simulator', readings: [enersense.encode(base)] });
  const b = ingestion.ingest({ siteId: SITE, source: 'simulator', readings: [voltiolab.encode({ ...base, moduleId: 'MX-011', loadCode: 'whisk', manufacturer: 'VoltioLab' })] }); // format detected
  assert.equal(a.accepted + b.accepted, 2);
  const rowA = repos.readings.latest(repos.loads.getByCode(SITE, 'mixer').id);
  const rowB = repos.readings.latest(repos.loads.getByCode(SITE, 'whisk').id);
  const shape = ({ id, load_id, module_id, ...rest }) => rest;
  assert.deepEqual(shape({ ...rowA }), shape({ ...rowB }));
  assert.equal(repos.modules.get('MX-010').manufacturer, 'EnerSense');
  assert.equal(repos.modules.get('MX-011').manufacturer, 'VoltioLab');
  assert.equal(rowA.source, 'simulator');
});

test('idempotent: the same reading is stored once, per module and timestamp', () => {
  const { repos, ingestion } = setup({ autoRegister: true });
  const ts = new Date(ANCHOR - 5 * MIN).toISOString();
  const batch = [esp({ timestamp: ts }), esp({ timestamp: ts, power_w: 999 }), esp({ timestamp: new Date(ANCHOR - 4 * MIN).toISOString() })];
  const first = ingestion.ingest({ siteId: SITE, readings: batch });
  assert.deepEqual([first.accepted, first.duplicates], [2, 1], 'a duplicate inside the same batch');
  const again = ingestion.ingest({ siteId: SITE, readings: batch });
  assert.deepEqual([again.accepted, again.duplicates], [0, 3]);
  const load = repos.loads.getByCode(SITE, 'freezer');
  assert.equal(repos.readings.range(load.id, '2026-01-01', '2027-01-01').length, 2);
  assert.equal(repos.readings.range(load.id, ts, new Date(Date.parse(ts) + 1).toISOString())[0].power_w, 412, 'the first value wins');
});

test('strict validation: bad readings are rejected one by one with a reason, good ones still stored', () => {
  const { repos, ingestion } = setup({ autoRegister: true });
  const good = new Date(ANCHOR - MIN).toISOString();
  const r = ingestion.ingest({
    siteId: SITE,
    readings: [
      esp({ timestamp: good }),
      esp({ power_w: -1 }),
      esp({ power_w: '412' }),
      esp({ power_w: Number.NaN }),
      esp({ power_w: 200000 }),
      esp({ voltage_v: 5000 }),
      esp({ status: 'on fire' }),
      esp({ module_id: 5 }),
      esp({ load_id: 'bad id!' , module_id: 'MX-050' }),
      esp({ timestamp: new Date(ANCHOR + 3600000).toISOString() }),
      esp({ timestamp: new Date(ANCHOR - 90 * 86400000).toISOString() }),
      esp({ timestamp: 'yesterday' }),
      'not an object',
      null,
    ],
  });
  assert.equal(r.accepted, 1);
  const codes = r.rejected.map((x) => x.code);
  assert.deepEqual(codes, ['out_of_range', 'invalid_format', 'invalid_format', 'out_of_range', 'out_of_range', 'invalid_format', 'invalid_format',
    'module_not_registered', 'timestamp_in_future', 'timestamp_too_old', 'invalid_format', 'invalid_format', 'invalid_format']);
  assert.ok(r.rejected.every((x) => typeof x.message === 'string' && x.message.length > 5));
  assert.equal(repos.readings.range(repos.loads.getByCode(SITE, 'freezer').id, '2026-01-01', '2027-01-01').length, 1);
});

test('envelope errors throw: unknown site, empty or oversized batch, bad payload', () => {
  const { ingestion } = setup({ autoRegister: true });
  const code = (envelope) => { try { ingestion.ingest(envelope); } catch (e) { return e instanceof IngestionError ? e.code : `other:${e.message}`; } return 'no error'; };
  assert.equal(code({ siteId: 'nowhere', readings: [esp()] }), 'unknown_site');
  assert.equal(code({ siteId: SITE, readings: [] }), 'empty_batch');
  assert.equal(code({ siteId: SITE, readings: 'x' }), 'empty_batch');
  assert.equal(code({ siteId: SITE, readings: Array.from({ length: 101 }, () => esp()) }), 'batch_too_large');
  assert.equal(code({ siteId: SITE, source: 'telepathy', readings: [esp()] }), 'invalid_payload');
  assert.equal(code({ siteId: SITE, buffered: true, readings: Array.from({ length: 1001 }, () => esp()) }), 'batch_too_large');

  assert.equal(envelopeFromPayload({ site_id: SITE, gateway_id: 'ESP32-DEMO-01', readings: [] }).gatewayId, 'ESP32-DEMO-01');
  for (const body of [null, [], 'x', {}, { site_id: 5 }, { site_id: 'Bad Site' }, { site_id: SITE, gateway_id: 'a b' }, { site_id: SITE, expected: -1 }, { site_id: SITE, format: 5 }]) {
    assert.throws(() => envelopeFromPayload(body), IngestionError, JSON.stringify(body));
  }
});

test('module registry: without auto-registration unknown, foreign or unassigned modules are rejected', () => {
  const { repos, ingestion } = setup({ autoRegister: false });
  const freezer = repos.loads.create({ siteId: SITE, code: 'freezer', name: 'Congelador vertical', criticality: 'critical' });
  repos.modules.register({ id: 'MX-001', siteId: SITE, loadId: freezer.id, manufacturer: 'EnerSense' });
  repos.modules.register({ id: 'MX-LOOSE', siteId: SITE, manufacturer: 'EnerSense' });
  repos.sites.create({ id: 'other-site', name: 'Otra' });
  repos.modules.register({ id: 'MX-OTHER', siteId: 'other-site', manufacturer: 'EnerSense' });
  const r = ingestion.ingest({ siteId: SITE, readings: [esp(), esp({ module_id: 'MX-NEW' }), esp({ module_id: 'MX-LOOSE' }), esp({ module_id: 'MX-OTHER' })] });
  assert.equal(r.accepted, 1);
  assert.deepEqual(r.rejected.map((x) => x.code), ['module_not_registered', 'module_without_load', 'module_not_in_site']);
  assert.equal(repos.modules.get('MX-NEW'), null, 'nothing was registered behind the scenes');
});

test('auto-registration never gives one load two modules', () => {
  const { ingestion } = setup({ autoRegister: true });
  ingestion.ingest({ siteId: SITE, readings: [esp()] });
  const r = ingestion.ingest({ siteId: SITE, readings: [esp({ module_id: 'MX-777' })] });
  assert.equal(r.accepted, 0);
  assert.equal(r.rejected[0].code, 'load_has_another_module');
});

test('module heartbeat and status: active, error, inactive after 2 minutes of silence, active again', () => {
  const { repos, clock, ingestion } = setup({ autoRegister: true });
  ingestion.ingest({ siteId: SITE, readings: [esp()] });
  assert.equal(repos.modules.get('MX-001').status, 'active');
  clock.advance(2 * MIN);
  assert.deepEqual(ingestion.refreshModuleStatuses(), [], 'exactly 2 minutes is still healthy');
  clock.advance(MIN);
  const changed = ingestion.refreshModuleStatuses();
  assert.deepEqual(changed.map((c) => c.moduleId), ['MX-001']);
  assert.equal(repos.modules.get('MX-001').status, 'inactive');
  assert.deepEqual(ingestion.refreshModuleStatuses(), [], 'already inactive');
  ingestion.ingest({ siteId: SITE, readings: [esp()] });
  assert.equal(repos.modules.get('MX-001').status, 'active');
  ingestion.ingest({ siteId: SITE, readings: [esp({ status: 'error' })] });
  assert.equal(repos.modules.get('MX-001').status, 'error');
  clock.advance(10 * MIN);
  assert.deepEqual(ingestion.refreshModuleStatuses(), [], 'a module in error is not downgraded to inactive');
});

function fleetEnv(extra = {}) {
  const env = createTestEnv();
  const engine = createEngine({ seed: 1 });
  const ingestion = createIngestion({ repos: env.repos, clock: env.clock, options: { autoRegister: true, ...extra.ingestion } });
  const fleet = createModuleFleet({
    engine, clock: env.clock, siteId: SITE, bufferCapacity: extra.bufferCapacity,
    modules: [
      { moduleId: 'MX-001', loadCode: 'freezer', manufacturer: 'EnerSense' },
      { moduleId: 'MX-002', loadCode: 'fridge', manufacturer: 'VoltioLab' },
    ],
  });
  const pump = () => fleet.tick().map((batch) => ingestion.ingest(batch));
  return { ...env, engine, ingestion, fleet, pump };
}

test('live ticks from two manufacturers land in the same table', () => {
  const { repos, clock, ingestion, fleet, pump } = fleetEnv();
  const first = fleet.tick();
  assert.deepEqual(first.map((b) => b.format).sort(), ['enersense', 'voltiolab'], 'each manufacturer speaks its own format');
  for (const b of first) ingestion.ingest(b);
  for (let i = 0; i < 3; i += 1) { clock.advance(MIN); pump(); }
  const loadA = repos.loads.getByCode(SITE, 'freezer');
  const loadB = repos.loads.getByCode(SITE, 'fridge');
  assert.ok(repos.readings.range(loadA.id, '2026-01-01', '2027-01-01').length >= 3);
  assert.ok(repos.readings.range(loadB.id, '2026-01-01', '2027-01-01').length >= 3);
  assert.equal(repos.modules.get('MX-001').manufacturer, 'EnerSense');
  assert.equal(repos.modules.get('MX-002').manufacturer, 'VoltioLab');
});

test('offline buffer (RNF-08): 600 readings stored locally, synced on reconnect, 0 lost', () => {
  const { repos, clock, ingestion, fleet, pump } = fleetEnv();
  clock.advance(MIN);
  pump();
  const freezer = repos.loads.getByCode(SITE, 'freezer');
  const before = repos.readings.range(freezer.id, '2026-01-01', '2027-01-01').length;

  fleet.disconnect('MX-001');
  assert.equal(fleet.isConnected('MX-001'), false);
  clock.advance(600 * MIN);
  const live = fleet.tick();
  assert.ok(live.every((b) => b.format === 'voltiolab'), 'only the connected module reports live');
  for (const b of live) ingestion.ingest(b);
  assert.equal(fleet.bufferedCount('MX-001'), 600);
  assert.equal(repos.readings.range(freezer.id, '2026-01-01', '2027-01-01').length, before, 'nothing arrived while disconnected');

  // The silent module is flagged inactive within the 2-minute rule.
  assert.deepEqual(ingestion.refreshModuleStatuses().map((c) => c.moduleId).sort(), ['MX-001']);
  assert.equal(repos.modules.get('MX-001').status, 'inactive');

  const { readingsBuffered, batches } = fleet.reconnect('MX-001');
  assert.equal(readingsBuffered, 600);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].buffered, true);
  assert.equal(batches[0].expected, 600);
  const sync = ingestion.ingest(batches[0]);
  assert.equal(sync.accepted, 600);
  assert.equal(sync.sync.lost, 0);
  assert.equal(sync.sync.message, 'Se sincronizaron 600 lecturas, 0 perdidas');
  assert.equal(repos.readings.range(freezer.id, '2026-01-01', '2027-01-01').length, before + 600);
  assert.equal(repos.modules.get('MX-001').status, 'active');
  assert.equal(fleet.bufferedCount('MX-001'), 0);
  // The synced series is gapless: one reading per minute.
  const rows = repos.readings.range(freezer.id, '2026-01-01', '2027-01-01');
  for (let i = 1; i < rows.length; i += 1) assert.equal(Date.parse(rows[i].ts) - Date.parse(rows[i - 1].ts), MIN);
  // The cumulative counter kept growing through the outage.
  assert.ok(rows[rows.length - 1].energy_kwh > rows[0].energy_kwh);
  assert.equal(repos.events.list({ name: 'buffer_synced' })[0].name, 'buffer_synced');

  // Re-sending the same sync loses nothing and duplicates nothing.
  const again = ingestion.ingest(batches[0]);
  assert.deepEqual([again.accepted, again.duplicates, again.sync.lost], [0, 600, 0]);
  assert.match(again.sync.message, /Se sincronizaron 0 lecturas, 0 perdidas \(600 ya estaban registradas\)/);
});

test('offline buffer overflow is reported honestly as lost readings', () => {
  const { repos, clock, ingestion, fleet } = fleetEnv({ bufferCapacity: 100 });
  fleet.tick();
  fleet.disconnect('MX-002');
  clock.advance(130 * MIN);
  fleet.tick();
  assert.equal(fleet.bufferedCount('MX-002'), 100);
  assert.equal(fleet.overflowed('MX-002'), 30);
  const { batches } = fleet.reconnect('MX-002');
  const sync = ingestion.ingest(batches[0]);
  assert.equal(sync.accepted, 100);
  assert.equal(sync.sync.lost, 30);
  assert.match(sync.sync.message, /Se sincronizaron 100 lecturas, 30 perdidas/);
  assert.equal(repos.readings.range(repos.loads.getByCode(SITE, 'fridge').id, '2026-01-01', '2027-01-01').length >= 100, true);
});

test('retention: raw readings older than 2 days become hourly aggregates', () => {
  const { repos, clock, ingestion } = setup({ autoRegister: true });
  const start = Date.parse('2026-03-08T10:00:00.000Z'); // more than 2 days before the clock
  const readings = Array.from({ length: 120 }, (_, i) => esp({ timestamp: new Date(start + i * MIN).toISOString(), power_w: i < 60 ? 100 : 300 }));
  for (let i = 0; i < readings.length; i += 100) ingestion.ingest({ siteId: SITE, readings: readings.slice(i, i + 100) });
  ingestion.ingest({ siteId: SITE, readings: [esp({ timestamp: new Date(ANCHOR - MIN).toISOString() })] });
  const load = repos.loads.getByCode(SITE, 'freezer');
  const result = ingestion.compact();
  assert.equal(result.hoursWritten, 2);
  assert.equal(result.rawRemoved, 120);
  const hourly = repos.readings.hourlyRange(load.id, '2026-03-08', '2026-03-09');
  assert.deepEqual(hourly.map((h) => [h.hour_start, h.avg_power_w, h.samples]), [['2026-03-08T10:00:00.000Z', 100, 60], ['2026-03-08T11:00:00.000Z', 300, 60]]);
  assert.ok(Math.abs(hourly[0].energy_kwh - 0.1) < 1e-9);
  assert.equal(repos.readings.range(load.id, '2026-01-01', '2027-01-01').length, 1, 'the recent reading stays raw');
  void clock;
});

test('the use case only uses the injected clock', () => {
  const clock = frozenClock(Date.parse('2030-01-01T00:00:00.000Z'));
  const env = createTestEnv({ clock });
  const ingestion = createIngestion({ repos: env.repos, clock, options: { autoRegister: true } });
  const r = ingestion.ingest({ siteId: SITE, readings: [esp()] });
  assert.equal(r.receivedAt, '2030-01-01T00:00:00.000Z');
  assert.equal(env.repos.modules.get('MX-001').registered_at, '2030-01-01T00:00:00.000Z');
});
