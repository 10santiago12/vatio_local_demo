'use strict';
/**
 * Demo Panel use cases (presenter tool): simulated clock controls, injected anomalies, deterioration,
 * "leave the sign on tonight", module disconnection with offline-buffer sync, critical-load and
 * unauthorized-action rejections, extra loads and reset to the seed.
 *
 * Demo mode = Demo Panel enabled AND database seeded. The simulated modules produce readings every
 * simulated minute and hand them to the same ingestion use case real devices use. `runJobs` is the
 * periodic job (also called after every demo action): it advances the simulated modules, refreshes
 * module statuses, runs the alert detectors, the safe-state rule and the recommendation generator.
 */
const { SimulatedClock } = require('../adapters/clock');
const { createModuleFleet } = require('../adapters/simulator/module-fleet');
const { MAIN_PROFILES } = require('../adapters/simulator/profiles');
const { authorize, PERMISSIONS } = require('../domain/permissions');
const { ROLES } = require('../domain/constants');
const { MS_PER_HOUR, MS_PER_DAY } = require('../domain/time');
const { badRequest, conflict } = require('../http/http-error');
const { createDemoControls, DemoControlError } = require('./demo-controls');
const { seedDemo, loadDemoScenario } = require('./demo-data');

const ADVANCE_MS = Object.freeze({ '1h': MS_PER_HOUR, '1d': MS_PER_DAY, '7d': 7 * MS_PER_DAY });

/**
 * @param {{repos: object, db: object, clock: object, state: object, config: object, wallNow: function(): number, siteId: string,
 *   ingestion: object, analytics: object, alerts: object, control: object, recommendations: object, access: object,
 *   logError: function(string, Error): void}} deps
 */
function createDemo(deps) {
  const { repos, db, clock, state, config, wallNow, siteId, ingestion, analytics, alerts, control, recommendations, access, logError } = deps;
  let fleet = null;
  let controls = null;

  function buildLive() {
    const sc = state.scenario;
    const profiles = new Set(sc.engine.profiles().map((p) => p.code));
    const loads = new Map(repos.loads.listBySite(siteId).map((l) => [l.id, l]));
    const modules = [];
    const initialEnergyKwh = {};
    for (const m of repos.modules.listBySite(siteId)) {
      const load = loads.get(m.load_id);
      if (!load || !profiles.has(load.code)) continue;
      modules.push({ moduleId: m.id, loadCode: load.code, manufacturer: m.manufacturer });
      initialEnergyKwh[load.code] = repos.readings.latest(load.id)?.energy_kwh ?? 0;
    }
    fleet = createModuleFleet({ engine: sc.engine, clock, siteId, modules, initialEnergyKwh });
    controls = createDemoControls({ repos, db, clock, scenario: sc, fleet, ingestion, siteId });
  }
  if (state.demoMode) buildLive();

  function requireDemoMode() {
    if (!state.demoMode) throw conflict('Esta acción necesita los datos de demostración. Cárguelos con "npm run seed:demo" o use "Reiniciar la demostración".', 'demo_not_seeded');
  }

  /** One pass of the periodic work. Safe to call at any time; never throws. */
  function runJobs() {
    const out = { ingested: 0, alertsCreated: 0, discarded: 0 };
    const guard = (name, fn) => { try { fn(); } catch (error) { logError(name, error); } };
    if (fleet) {
      guard('simulated-modules', () => {
        for (const batch of fleet.tick()) out.ingested += ingestion.ingest(batch).accepted;
        if (out.ingested > 5000) ingestion.compact();
      });
    }
    guard('module-status', () => ingestion.refreshModuleStatuses());
    guard('alerts', () => { out.alertsCreated = alerts.run(siteId).created.length; });
    guard('safe-state', () => { out.discarded = control.runSafeState(siteId).length; });
    guard('recommendations', () => recommendations.ensureFresh(siteId));
    return out;
  }

  function clockState() {
    return { ...clock.state(), demoMode: state.demoMode };
  }

  function wrap(fn) {
    try { return fn(); } catch (error) {
      if (error instanceof DemoControlError) throw badRequest(error.message, error.code);
      throw error;
    }
  }

  return {
    runJobs,

    state() {
      return {
        enabled: config.demoPanelEnabled, demoMode: state.demoMode, clock: clockState(),
        modules: fleet ? fleet.moduleIds().map((id) => ({ id, connected: fleet.isConnected(id), buffered: fleet.bufferedCount(id) })) : [],
        activeAlerts: repos.alerts.countActive(siteId),
      };
    },

    /** Speed (1, 60, 3600), pause/resume and jumps ('1h', '1d', '7d'). */
    setClock({ speed, paused, advance }) {
      requireDemoMode();
      const sim = clock.current;
      if (speed !== undefined) {
        try { sim.setSpeed(speed); } catch { throw badRequest('La velocidad debe ser 1, 60 o 3600.', 'invalid_speed'); }
      }
      if (paused !== undefined) { if (paused) sim.pause(); else sim.resume(); }
      if (advance !== undefined) {
        if (!ADVANCE_MS[advance]) throw badRequest('El salto debe ser 1h, 1d o 7d.', 'invalid_advance');
        sim.advance(ADVANCE_MS[advance]);
      }
      const jobs = runJobs();
      return { clock: clockState(), jobs };
    },

    injectAnomaly({ loadCode, pct, durationMinutes }) {
      requireDemoMode();
      const result = wrap(() => controls.injectAnomaly({ loadCode, pct, durationMinutes }));
      analytics.invalidate();
      return { ...result, jobs: runJobs() };
    },

    simulateDeterioration({ loadCode, days, pct }) {
      requireDemoMode();
      const result = wrap(() => controls.simulateDeterioration({ loadCode, days, pct }));
      analytics.invalidate();
      return { ...result, jobs: runJobs() };
    },

    leaveSignOn() {
      requireDemoMode();
      const result = wrap(() => controls.leaveSignOn());
      analytics.invalidate();
      return { ...result, jobs: runJobs() };
    },

    disconnectModule(moduleId) {
      requireDemoMode();
      if (!fleet.moduleIds().includes(moduleId)) throw badRequest('Ese módulo no es simulado.', 'unknown_module');
      return controls.disconnectModule(moduleId);
    },

    reconnectModule(moduleId) {
      requireDemoMode();
      if (!fleet.moduleIds().includes(moduleId)) throw badRequest('Ese módulo no es simulado.', 'unknown_module');
      const result = controls.reconnectModule(moduleId);
      return { ...result, jobs: runJobs() };
    },

    generateLoads({ count }) {
      requireDemoMode();
      const result = wrap(() => controls.generateLoads({ count }));
      analytics.invalidate();
      return result;
    },

    /** The attempt to switch a critical load off is rejected by the domain and audited. */
    tryCriticalOff(user) {
      return control.toggle({ siteId, loadKey: 'freezer', action: 'off', user });
    },

    /** Shows what happens when a role without permission tries something: rejection plus an audit row. */
    tryUnauthorized(user, { asRole = 'non_technical_employee', permission = 'toggle_load' } = {}) {
      if (!Object.prototype.hasOwnProperty.call(ROLES, asRole)) throw badRequest('El perfil indicado no existe.', 'invalid_role');
      if (!Object.prototype.hasOwnProperty.call(PERMISSIONS, permission)) throw badRequest('El permiso indicado no existe.', 'invalid_permission');
      const decision = authorize(asRole, permission, { at: new Date(clock.now()).toISOString(), actor: user.username });
      if (decision.allowed) return { allowed: true, message: `El perfil ${ROLES[asRole]} sí tiene ese permiso: no hay nada que rechazar.` };
      const auditId = access.audit({
        user, event: 'permission_denied', siteId, result: 'rejected', reason: decision.message,
        details: { permission, attempted: 'demo:try-unauthorized', simulatedRole: asRole, reasonCode: decision.reason },
      });
      return { allowed: false, message: decision.message, auditId, simulatedRole: asRole };
    },

    /** Back to the seed: operational data is wiped and regenerated from the same seed and anchor. */
    reset(user) {
      const seeded = repos.events.list({ name: 'demo_seeded', limit: 1 })[0];
      const anchorMs = seeded ? Date.parse(JSON.parse(seeded.properties).anchor) : Math.floor(clock.now() / 60000) * 60000;
      const seed = seeded ? JSON.parse(seeded.properties).seed : undefined;
      const mainCodes = new Set(MAIN_PROFILES.map((p) => p.code));
      const mainModules = new Set(MAIN_PROFILES.map((p) => p.moduleId));
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM alerts; DELETE FROM control_actions; DELETE FROM recommendations; DELETE FROM baselines; DELETE FROM readings; DELETE FROM readings_hourly; DELETE FROM tariffs; DELETE FROM settings;');
        for (const m of repos.modules.list()) if (!mainModules.has(m.id)) db.prepare('DELETE FROM modules WHERE id = ?').run(m.id);
        for (const site of repos.sites.list()) {
          for (const load of repos.loads.listBySite(site.id)) {
            if (!mainCodes.has(load.code)) { try { db.prepare('DELETE FROM loads WHERE id = ?').run(load.id); } catch { /* referenced by the audit trail: kept */ } }
          }
        }
        for (const p of MAIN_PROFILES) {
          db.prepare('UPDATE loads SET name = ?, criticality = ?, control_mode = ?, power_state = ? WHERE code = ?').run(p.name, p.criticality, p.controlMode, 'on', p.code);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const anchorClock = new SimulatedClock({ startMs: anchorMs, paused: true, realNow: () => 0 });
      const summary = seedDemo({ repos, db, clock: anchorClock, seed });
      state.scenario = { seeded: true, ...loadDemoScenario({ repos, clock: anchorClock }) };
      clock.use(new SimulatedClock({ startMs: anchorMs, realNow: wallNow }));
      state.demoMode = true;
      buildLive();
      analytics.invalidate();
      access.audit({ user, event: 'demo_reset', siteId, result: 'executed', details: { anchor: summary.anchor, loads: summary.loads, rawReadings: summary.rawReadings } });
      return { anchor: summary.anchor, clock: clockState(), loadsCreated: summary.loads, rawReadings: summary.rawReadings, hourlyRows: summary.hourlyRows };
    },

    /** Called when a technician registers a module while the simulator is running: it starts measuring. */
    onModuleRegistered({ module: module_, load }) {
      if (!state.demoMode || !fleet) return;
      controls.addSimulatedModule({ moduleId: module_.id, loadCode: load.code, loadName: load.name, manufacturer: module_.manufacturer });
    },
  };
}

module.exports = { createDemo, ADVANCE_MS };
