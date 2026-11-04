const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/api');

let env;
let owner;
before(async () => { env = await startApp(); owner = await env.as('owner'); });
after(() => env.close());

const FORBIDDEN_KEYS = /voltage|current(?!PowerW)|powerFactor|errorCode|\bvoltaje\b/i;

test('loads list: current W, kWh and COP today, module status, criticality, control mode, active alerts, sort and filter', async () => {
  const res = await owner.get('/api/loads');
  assert.equal(res.status, 200);
  const { loads } = res.body;
  assert.ok(loads.length >= 11);
  const freezer = loads.find((l) => l.code === 'freezer');
  assert.equal(freezer.criticality, 'critical');
  for (const key of ['currentPowerW', 'todayKwh', 'todayCostCop', 'moduleStatus', 'controlMode', 'activeAlerts', 'dataAgeSeconds']) assert.ok(key in freezer, key);
  assert.ok(freezer.todayKwh > 0 && freezer.todayCostCop > 0);

  const byCost = (await owner.get('/api/loads?sort=cost&period=7d')).body.loads;
  for (let i = 1; i < byCost.length; i += 1) assert.ok(byCost[i - 1].periodCostCop >= byCost[i].periodCostCop);
  const critical = (await owner.get('/api/loads?criticality=critical')).body.loads;
  assert.ok(critical.length > 0 && critical.every((l) => l.criticality === 'critical'));
  assert.equal((await owner.get('/api/loads?sort=bogus')).status, 400);
});

test('load detail: current power with data age, live and daily series, hourly baseline with band, cost; technical block by role', async () => {
  const detail = (await owner.get('/api/loads/freezer')).body;
  assert.equal(detail.current.stale, false);
  assert.ok(detail.current.dataAgeSeconds <= 60);
  assert.ok(detail.liveSeries.length >= 100 && detail.liveSeries.length <= 125);
  assert.ok(detail.dailyConsumption.length >= 25);
  assert.equal(detail.baseline.status, 'ready');
  assert.equal(detail.baseline.hourly.length, 24);
  assert.ok(detail.baseline.hourly[0].bandHighW >= detail.baseline.hourly[0].bandLowW);
  assert.ok(detail.cost.todayCop > 0 && detail.cost.monthCop >= detail.cost.todayCop);
  assert.ok(detail.technical, 'owner holds the diagnostics permission');
  for (const key of ['voltageV', 'currentA', 'powerW', 'energyKwhCounter', 'manufacturer', 'moduleId']) assert.ok(key in detail.technical, key);

  const manager = await env.as('operations_manager');
  const plain = (await manager.get('/api/loads/freezer')).body;
  assert.equal(plain.technical, undefined);
  const technician = await env.as('installer_technician');
  assert.equal((await technician.get('/api/loads/freezer')).status, 403, 'technician has no load detail permission');
  assert.equal((await owner.get('/api/loads/nothing')).status, 404);
});

test('a stale reading is flagged after 60 seconds without data', async () => {
  const load = env.repos.loads.getByCode(env.app.siteId, 'pos');
  const latest = env.repos.readings.latest(load.id);
  env.app.clock.current.advance(5 * 60_000);
  const stale = (await owner.get('/api/loads/pos')).body.current;
  assert.ok(stale.dataAgeSeconds > 60);
  assert.equal(stale.stale, true);
  assert.ok(latest);
  env.app.demo.runJobs();
});

test('simple view: spend today, % against a typical day, ranking, plain alerts and top-3 recommendations, no technical data', async () => {
  const view = await env.as('non_technical_employee');
  const res = await view.get('/api/simple');
  assert.equal(res.status, 200);
  assert.ok(res.body.todaySpendCop > 0);
  assert.equal(res.body.comparison.available, true);
  assert.ok(Number.isFinite(res.body.comparison.pct));
  for (let i = 1; i < res.body.ranking.length; i += 1) assert.ok(res.body.ranking[i - 1].costCop >= res.body.ranking[i].costCop);
  assert.ok(res.body.recommendations.length <= 3);
  assert.doesNotMatch(Object.keys(JSON.parse(res.text)).concat(res.text.match(/"[A-Za-z]+":/g) || []).join(' '), FORBIDDEN_KEYS);
  assert.doesNotMatch(res.text, /factor de potencia|voltaje|corriente|código de error/i);
  assert.equal((await view.get('/api/loads')).status, 403);
});

test('consumption alert: injected anomaly raises it right away with the injected excess, no duplicates, review moves it to history', async () => {
  await owner.post('/api/alerts/run');
  const nowIso = env.app.clock.nowIso();
  const injected = await owner.post('/api/demo/anomaly', { loadCode: 'pos', pct: 60, durationMinutes: 30 });
  assert.equal(injected.status, 200);
  const alerts = (await owner.get('/api/alerts?view=active&type=consumption&load=pos')).body.alerts;
  assert.equal(alerts.length, 1);
  const alert = alerts[0];
  assert.ok(Date.parse(alert.detectedAt) - Date.parse(nowIso) <= 5 * 60_000, 'raised within 5 simulated minutes');
  assert.ok(Math.abs(alert.excessPct - 60) <= 15, `excess ${alert.excessPct} close to the injected 60 %`);
  assert.match(alert.message, /%/);

  await owner.post('/api/alerts/run');
  await owner.post('/api/alerts/run');
  assert.equal((await owner.get('/api/alerts?view=active&type=consumption&load=pos')).body.alerts.length, 1, 'no duplicates');

  const reviewed = await owner.post(`/api/alerts/${alert.id}/review`);
  assert.equal(reviewed.status, 200);
  assert.equal((await owner.get('/api/alerts?view=active&type=consumption&load=pos')).body.alerts.length, 0);
  assert.equal((await owner.get('/api/alerts?view=history&type=consumption&load=pos')).body.alerts.length, 1);
  assert.equal((await owner.post(`/api/alerts/${alert.id}/review`)).status, 409);
});

test('recommendations: persisted by the domain, descending score, never switch off a critical load, accept/postpone/discard', async () => {
  const list = (await owner.get('/api/recommendations')).body.recommendations;
  assert.ok(list.length > 0, 'the seeded scenario yields recommendations');
  for (let i = 1; i < list.length; i += 1) assert.ok(list[i - 1].score >= list[i].score, 'descending score');
  for (const r of list) {
    const load = env.repos.loads.get(r.loadId);
    if (load.criticality === 'critical') assert.ok(!['off_hours_shutdown', 'schedule', 'reduce_standby'].includes(r.type), `${r.type} on critical ${load.code}`);
  }
  const [first, second, third] = list;
  const postponed = await owner.post(`/api/recommendations/${first.id}/decision`, { action: 'postpone', days: 3 });
  assert.equal(postponed.body.recommendation.status, 'postponed');
  const discarded = await owner.post(`/api/recommendations/${second.id}/decision`, { action: 'discard', reason: 'No aplica' });
  assert.equal(discarded.body.recommendation.status, 'discarded');
  assert.equal(discarded.body.recommendation.reason, 'No aplica');
  assert.equal((await owner.post(`/api/recommendations/${third.id}/decision`, { action: 'explode' })).status, 400);
  assert.equal((await owner.post(`/api/recommendations/${second.id}/decision`, { action: 'accept' })).status, 409);
});

test('accepting a switch-off recommendation: monitor-only creates only an explanatory pending item, control-enabled a pending action', async () => {
  const manager = await env.as('operations_manager');
  assert.equal((await manager.post('/api/recommendations/1/decision', { action: 'accept' })).status, 403, 'only the owner decides');
  const monitorLoad = env.repos.loads.getByCode(env.app.siteId, 'tv');
  const controlLoad = env.repos.loads.getByCode(env.app.siteId, 'warmer');
  env.repos.loads.updateConfig(monitorLoad.id, { criticality: 'non_essential', controlMode: 'monitor_only' });
  env.repos.loads.updateConfig(controlLoad.id, { criticality: 'non_essential', controlMode: 'control_enabled' });
  const at = env.app.clock.nowIso();
  const make = (load) => env.repos.recommendations.create({
    siteId: env.app.siteId, loadId: load.id, type: 'off_hours_shutdown', title: `Apagar ${load.name} al cerrar`, assumption: 'prueba', monthlySavingsKwh: 10, monthlySavingsCop: 5000, score: 50, confidence: 0.8, createdAt: at,
  });
  const a = make(monitorLoad);
  const b = make(controlLoad);
  const accepted = await owner.post(`/api/recommendations/${a.id}/decision`, { action: 'accept' });
  assert.equal(accepted.body.recommendation.status, 'accepted');
  assert.ok(accepted.body.recommendation.acceptedAt);
  assert.equal(accepted.body.controlAction.executable, false);
  const pendingMonitor = env.repos.controlActions.get(accepted.body.controlAction.actionId);
  assert.equal(pendingMonitor.status, 'pending');
  assert.match(pendingMonitor.reason, /solo monitoreo/i);
  assert.equal(env.repos.loads.get(monitorLoad.id).power_state, 'on', 'nothing was executed');

  const withControl = await owner.post(`/api/recommendations/${b.id}/decision`, { action: 'accept' });
  assert.equal(withControl.body.controlAction.executable, true);
  assert.match(withControl.body.controlAction.message, /aprobaci/i);
  assert.equal(env.repos.loads.get(controlLoad.id).power_state, 'on', 'waits for the owner approval');
});

test('a load still building its baseline (day N of 7) gets no recommendations and no deviation alerts', async () => {
  const technician = await env.as('installer_technician');
  assert.equal((await technician.post('/api/modules', { id: 'MX-BUILD-1', manufacturer: 'VoltioLab', loadName: 'Plancha nueva' })).status, 201);
  const load = env.repos.loads.listBySite(env.app.siteId).find((l) => l.name === 'Plancha nueva');
  env.app.clock.current.advance(24 * 3_600_000);
  env.app.demo.runJobs();
  const detail = (await owner.get(`/api/loads/${load.code}`)).body;
  assert.equal(detail.baseline.status, 'building');
  assert.ok(detail.baseline.dayN >= 1 && detail.baseline.requiredDays === 7);
  assert.deepEqual(detail.recommendations, []);
  await owner.post('/api/recommendations/refresh');
  await owner.post('/api/alerts/run');
  assert.equal(env.repos.recommendations.list({ siteId: env.app.siteId, loadId: load.id }).length, 0);
  const deviation = env.repos.alerts.list({ siteId: env.app.siteId, loadId: load.id }).filter((a) => a.type !== 'inactive_module');
  assert.equal(deviation.length, 0);
});
