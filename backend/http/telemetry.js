'use strict';
/** Health, server info, device telemetry (ESP32 and manufacturer formats) and the live view of readings. */
const os = require('node:os');
const { envelopeFromPayload, IngestionError } = require('../app/ingestion');
const { json } = require('./router');

function localIPv4Addresses() {
  const ips = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const net of entries || []) if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
  }
  return [...new Set(ips)];
}

/** Legacy API shape of a stored reading row (what the UI and the ESP32 docs describe). */
function legacyReading(row, nowMs) {
  const ageSec = Math.max(0, Math.round((nowMs - Date.parse(row.ts)) / 1000));
  const status = row.module_status || 'active';
  return {
    module_id: row.module_id, load_id: row.load_code, load_name: row.load_name, manufacturer: row.manufacturer || 'ESP32 virtual',
    voltage_v: row.voltage_v, current_a: row.current_a, power_w: row.power_w, energy_kwh: row.energy_kwh, status,
    timestamp: row.ts, received_at: row.ts, age_seconds: ageSec, effective_status: ageSec > 120 ? 'inactive' : status,
  };
}

function register(router, app) {
  const { repos, clock, config, siteId } = app;
  // Readings from a real device older than this instant are hidden after POST /api/reset.
  let ignoreDeviceBefore = '';
  let gatewayState = { gateway_id: null, site_id: siteId, last_received_at: null };
  const last = repos.readings.latestBySite(siteId, { source: 'esp32' }).map((r) => r.ts).sort().pop();
  if (last) gatewayState = { gateway_id: 'ESP32', site_id: siteId, last_received_at: last };

  const deviceRows = () => repos.readings.latestBySite(siteId, { source: 'esp32', since: ignoreDeviceBefore });

  /** Live readings of the simulator (no database writes): what every simulated load draws right now. */
  function simulatorReadings(nowMs) {
    const engine = app.scenario().engine;
    const stored = new Map(repos.readings.latestBySite(siteId).map((r) => [r.load_code, r]));
    const iso = new Date(nowMs).toISOString();
    return engine.profiles().map((profile) => {
      const sample = engine.sample(profile.code, nowMs);
      return {
        module_id: profile.moduleId, load_id: profile.code, load_name: profile.name, manufacturer: profile.manufacturer,
        voltage_v: sample.voltageV, current_a: sample.currentA, power_w: sample.powerW, energy_kwh: stored.get(profile.code)?.energy_kwh ?? 0,
        status: 'active', timestamp: iso, received_at: iso, age_seconds: 0, effective_status: 'active',
      };
    });
  }

  function latestPayload() {
    const nowMs = clock.now();
    const rows = deviceRows();
    const hasReal = rows.length > 0;
    return {
      source: hasReal ? 'esp32' : 'simulator',
      gateway: hasReal ? gatewayState : { gateway_id: 'SIMULATOR', site_id: siteId, last_received_at: new Date(nowMs).toISOString() },
      server_time: new Date(nowMs).toISOString(),
      readings: hasReal ? rows.map((row) => legacyReading(row, nowMs)) : simulatorReadings(nowMs),
    };
  }

  router.get('/api/health', () => json(200, {
    ok: true, service: 'Vatio Local', source: deviceRows().length ? 'esp32' : 'simulator', local_ips: localIPv4Addresses(),
    port: config.port, server_time: new Date(clock.now()).toISOString(),
  }), { public: true, doc: 'Estado del servicio.' });

  router.get('/api/info', () => {
    const ips = localIPv4Addresses();
    return json(200, {
      port: config.port, local_ips: ips, browser_urls: ips.map((ip) => `http://${ip}:${config.port}/`),
      telemetry_urls: ips.map((ip) => `http://${ip}:${config.port}/api/telemetry`), device_key_configured: Boolean(config.deviceKey),
    });
  }, { doc: 'Direcciones del servidor para configurar el ESP32.' });

  router.get('/api/telemetry/latest', () => json(200, latestPayload()), { doc: 'Última lectura de cada equipo (vista en vivo).' });

  router.get('/api/telemetry/history', ({ query }) => {
    const limit = Math.max(1, Math.min(1000, Number(query.limit || 250)));
    const nowMs = clock.now();
    const readings = repos.readings.recentBySite(siteId, { source: 'esp32', since: ignoreDeviceBefore, limit })
      .reverse().map((row) => ({ site_id: siteId, gateway_id: gatewayState.gateway_id, ...legacyReading(row, nowMs) }));
    return json(200, { count: readings.length, readings });
  }, { doc: 'Historial reciente de lecturas del ESP32.' });

  router.post('/api/telemetry', async (ctx) => {
    if (!config.deviceKey || ctx.req.headers['x-device-key'] !== config.deviceKey) return json(401, { ok: false, error: 'X-Device-Key inválida.' });
    try {
      const payload = JSON.parse(await ctx.rawBody() || '{}');
      const result = app.ingestion.ingest(envelopeFromPayload(payload));
      if (result.accepted + result.duplicates === 0) return json(400, { ok: false, error: result.rejected[0]?.message || 'Lectura inválida.', rejected: result.rejected });
      if (result.accepted > 0) gatewayState = { gateway_id: String(payload.gateway_id || 'ESP32').slice(0, 80), site_id: payload.site_id, last_received_at: result.receivedAt };
      return json(200, {
        ok: true, received: result.received, accepted: result.accepted, duplicates: result.duplicates, rejected: result.rejected, sync: result.sync, received_at: result.receivedAt,
      });
    } catch (error) {
      if (error instanceof IngestionError || error instanceof SyntaxError) return json(400, { ok: false, error: error instanceof SyntaxError ? 'JSON inválido.' : error.message });
      app.logError('telemetry', error);
      return json(500, { ok: false, error: 'Error interno al guardar las lecturas.' });
    }
  }, { public: true, doc: 'Recibe lecturas del ESP32 o de un fabricante (clave X-Device-Key).' });

  router.post('/api/reset', () => {
    ignoreDeviceBefore = new Date(clock.now()).toISOString();
    gatewayState = { gateway_id: null, site_id: siteId, last_received_at: null };
    return json(200, { ok: true, source: 'simulator' });
  }, { permission: 'configure', doc: 'Oculta las lecturas del ESP32 y vuelve a la vista del simulador.' });
}

module.exports = { register, localIPv4Addresses };
