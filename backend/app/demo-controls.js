'use strict';
/**
 * Controls of the Demo Panel (presenter tool). The HTTP layer will expose them behind the demo
 * permission; here they are plain functions over the simulator, the module fleet, the ingestion use
 * case and the repositories.
 *
 *  - injectAnomaly:        steady consumption N % above normal for a duration (fires the consumption alert);
 *  - simulateDeterioration: equipment draws +N % over the last days (fires the predictive-maintenance alert);
 *  - leaveSignOn:          the sign stays on tonight (fires the off-hours alert);
 *  - disconnectModule / reconnectModule: offline buffer (RF-08, RNF-08, RNF-18);
 *  - generateLoads:        N extra loads for the performance test.
 *
 * Effects that must be visible immediately rewrite the affected recent history (backfill), because the
 * domain rules look at the last minutes/days of stored readings.
 */

const { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY, localParts, localDayStartMs, addDays } = require('../domain/time');
const { rewriteLoadHistory, rawRow, hourlyRow } = require('./demo-data');
const { generateHistory } = require('../adapters/simulator/history');
const { MAIN_SITE_ID, MANUFACTURERS } = require('../adapters/simulator/profiles');

const OFFSET = -300;
const floorMinute = (ms) => Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE;
const floorHour = (ms) => Math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR;
const cycleOn = (abs, period, onMin, phase) => ((abs + phase) % period) < onMin;

class DemoControlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DemoControlError';
    this.code = code;
  }
}

/** A generic cycling load for the performance test (drawn from the seeded sequence). */
function generatedProfile(n, next) {
  const code = `extra-${String(n).padStart(2, '0')}`;
  const typicalPowerW = 100 + Math.floor(next() * 19) * 100;
  const period = 12 + Math.floor(next() * 4) * 2;
  const onMin = Math.max(3, Math.floor(period * (0.3 + next() * 0.4)));
  const idleW = Math.round(typicalPowerW * 0.03);
  return {
    code, name: `Carga de prueba ${String(n).padStart(2, '0')}`, icon: 'plug', moduleId: `MX-X${String(n).padStart(2, '0')}`,
    manufacturer: n % 2 === 0 ? MANUFACTURERS.VOLTIOLAB : MANUFACTURERS.ENERSENSE, typicalPowerW,
    criticality: n % 3 === 0 ? 'non_essential' : 'essential', controlMode: 'monitor_only', phase: n % period,
    plan: () => ({}),
    at: (plan, prev, p, c) => {
      const w = c.open ? (cycleOn(c.abs, period, onMin, p.phase) ? typicalPowerW : idleW) : idleW;
      return { w, mean: c.open ? (onMin * typicalPowerW + (period - onMin) * idleW) / period : idleW };
    },
  };
}

/**
 * @param {{repos: object, db: object, clock: {now: function(): number}, scenario: {engine: object}, fleet: object,
 *   ingestion: object, siteId?: string}} deps
 */
function createDemoControls(deps) {
  const { repos, db, clock, scenario, fleet, ingestion } = deps;
  const { engine } = scenario;
  const siteId = deps.siteId || MAIN_SITE_ID;

  function loadOf(loadCode) {
    const load = repos.loads.getByCode(siteId, loadCode);
    if (!load) throw new DemoControlError('No existe esa carga.', 'unknown_load');
    const module_ = repos.modules.listBySite(siteId).find((m) => m.load_id === load.id);
    return { load, moduleId: module_ ? module_.id : null };
  }

  function rewrite(loadCode, fromMs) {
    const { load, moduleId } = loadOf(loadCode);
    const result = rewriteLoadHistory({ repos, db, engine, clock, load, moduleId, fromMs });
    if (moduleId && fleet.moduleIds().includes(moduleId)) fleet.setEnergyKwh(moduleId, result.energyKwh);
    return result;
  }

  return {
    /**
     * @param {{loadCode: string, pct: number, durationMinutes: number, backfillMinutes?: number}} input
     * @returns {{modifierId: number, startsAt: string, endsAt: string}}
     */
    injectAnomaly({ loadCode, pct, durationMinutes, backfillMinutes = 16 }) {
      if (!Number.isFinite(pct) || pct <= 0 || pct > 500) throw new DemoControlError('El exceso debe estar entre 1 % y 500 %.', 'invalid_percent');
      if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 24 * 60) throw new DemoControlError('La duración debe estar entre 1 minuto y 24 horas.', 'invalid_duration');
      loadOf(loadCode);
      const nowMs = floorMinute(clock.now());
      const startMs = nowMs - backfillMinutes * MS_PER_MINUTE;
      const endMs = nowMs + durationMinutes * MS_PER_MINUTE;
      const modifierId = engine.modifiers.add({ kind: 'anomaly', loadCode, startMs, endMs, pct });
      rewrite(loadCode, startMs);
      return { modifierId, startsAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString() };
    },

    /** The load draws `pct` % more (default 18 %) during the last `days` days (default 5), growing over the first 36 hours. */
    simulateDeterioration({ loadCode, days = 5, pct = 18 }) {
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new DemoControlError('El aumento debe estar entre 1 % y 100 %.', 'invalid_percent');
      if (!Number.isInteger(days) || days < 3 || days > 30) throw new DemoControlError('Los días deben estar entre 3 y 30.', 'invalid_days');
      loadOf(loadCode);
      for (const m of engine.modifiers.forLoad(loadCode)) if (m.kind === 'deterioration') engine.modifiers.remove(m.id);
      const startMs = floorHour(clock.now() - days * MS_PER_DAY);
      const modifierId = engine.modifiers.add({ kind: 'deterioration', loadCode, startMs, rampMs: 36 * MS_PER_HOUR, factor: pct / 100 });
      rewrite(loadCode, startMs);
      return { modifierId, startsAt: new Date(startMs).toISOString() };
    },

    /** The sign stays on from closing time tonight until 06:00 tomorrow. */
    leaveSignOn() {
      loadOf('sign');
      const nowMs = floorMinute(clock.now());
      const p = localParts(nowMs, OFFSET);
      const baseKey = p.hour < 6 ? addDays(p.date, -1) : p.date;
      const startMs = localDayStartMs(baseKey, OFFSET) + 20 * MS_PER_HOUR;
      const endMs = localDayStartMs(addDays(baseKey, 1), OFFSET) + 6 * MS_PER_HOUR;
      const modifierId = engine.modifiers.add({ kind: 'force_on', loadCode: 'sign', startMs, endMs, powerW: 250 });
      if (nowMs > startMs) rewrite('sign', startMs);
      return { modifierId, startsAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString() };
    },

    disconnectModule(moduleId) {
      fleet.disconnect(moduleId);
      return { moduleId, connected: false };
    },

    /**
     * Reconnects a module and syncs its offline buffer through the ingestion use case.
     * @returns {{moduleId: string, readingsBuffered: number, stored: number, lost: number, message: string}}
     */
    reconnectModule(moduleId) {
      const { readingsBuffered, batches } = fleet.reconnect(moduleId);
      let stored = 0;
      let lost = 0;
      for (const batch of batches) {
        const result = ingestion.ingest(batch);
        stored += result.sync.stored;
        lost += result.sync.lost;
      }
      return { moduleId, readingsBuffered, stored, lost, message: `Se sincronizaron ${stored} lecturas, ${lost} perdidas` };
    },

    /**
     * Creates `count` extra loads (each with its module and `days` days of history) for the performance test.
     * @returns {{created: number, loadCodes: string[]}}
     */
    generateLoads({ count = 20, days = 7 } = {}) {
      if (!Number.isInteger(count) || count < 1 || count > 200) throw new DemoControlError('La cantidad debe estar entre 1 y 200.', 'invalid_count');
      const nowMs = floorMinute(clock.now());
      const next = engine.rng.sequence(`extra-loads-${repos.loads.listBySite(siteId).length}`);
      const existing = repos.loads.listBySite(siteId).filter((l) => l.code.startsWith('extra-')).length;
      const created = [];
      for (let i = 1; i <= count; i += 1) {
        const profile = generatedProfile(existing + i, next);
        engine.addProfile(profile);
        const load = repos.loads.create({
          siteId, code: profile.code, name: profile.name, icon: profile.icon, typicalPowerW: profile.typicalPowerW,
          criticality: profile.criticality, controlMode: profile.controlMode,
        });
        repos.modules.register({ id: profile.moduleId, siteId, loadId: load.id, manufacturer: profile.manufacturer, registeredAt: new Date(nowMs).toISOString() });
        repos.modules.heartbeat(profile.moduleId, new Date(nowMs).toISOString());
        const raw = [];
        const hourly = [];
        generateHistory({
          engine, loads: [{ code: profile.code, startMs: floorHour(nowMs) - days * MS_PER_DAY }], endMs: nowMs, rawFromMs: floorHour(nowMs - 2 * MS_PER_DAY),
          sink: { raw: (c, r) => raw.push(rawRow(load.id, profile.moduleId, r)), hourly: (c, h) => hourly.push(hourlyRow(load.id, h)) },
        });
        repos.readings.insertMany(raw);
        repos.readings.insertHourlyMany(hourly);
        fleet.addModule({ moduleId: profile.moduleId, loadCode: profile.code, manufacturer: profile.manufacturer, energyKwh: raw.length ? raw[raw.length - 1].energyKwh : 0 });
        created.push(profile.code);
      }
      return { created: created.length, loadCodes: created };
    },
  };
}

module.exports = { createDemoControls, DemoControlError };
