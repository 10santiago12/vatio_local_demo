'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/api');

test('producción recibe el ESP32 conocido y muestra su potencia en Laya antes de aprender', async () => {
  const key = 'test-device-only-'.repeat(3);
  const env = await startApp({ seed: false, env: { APP_ENV: 'production', VATIO_DEVICE_KEY: key } });
  try {
    const owner = await env.as('owner');
    const send = id => owner.call('POST', '/api/telemetry', {
      gateway_id: 'ESP32', site_id: env.app.siteId, readings: [{ module_id: id, load_id: 'tv',
        voltage_v: 120, current_a: 1, power_w: 120, energy_kwh: 0.1, status: 'active' }],
    }, { 'X-Device-Key': key });
    assert.equal((await send('MX-008')).body.accepted, 1);
    assert.equal((await send('MX-999')).status, 400);
    const tv = (await owner.get('/api/recommendations')).body.laya.find(l => l.name === 'Televisor');
    assert.equal(tv.watts, 120);
    assert.equal(tv.ready, false);
    assert.equal(tv.suggestion, null);
  } finally { env.close(); }
});

test('Laya aprende del historial y enciende y apaga el televisor simulado al cambiar la demanda', async () => {
  const env = await startApp();
  try {
    const { app, repos } = env;
    const tv = repos.loads.getByCode(app.siteId, 'tv');
    const owner = await env.as('owner');
    repos.loads.setPowerState(tv.id, 'off');
    for (const [hours, action] of [[0, 'on'], [8, 'off']]) {
      if (hours) app.clock.current.advance(hours * 3600000);
      repos.modules.heartbeat('MX-008', new Date(app.clock.now()).toISOString());
      app.demo.runJobs();
      assert.equal(repos.loads.get(tv.id).power_state, action);
      const history = await owner.get('/api/control/approvals?status=executed');
      const row = history.body.approvals.find(r => r.loadId === tv.id && r.rawOrigin === 'autonomous' && r.action === action);
      assert.match(row?.reason || '', /Laya/);
      assert.equal(app.control.runLaya(app.siteId).length, 0);
    }
  } finally { env.close(); }
});
