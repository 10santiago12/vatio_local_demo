'use strict';
/**
 * Controlled actions (RF-06, RF-07, RF-12, RNF-18): manual toggles, proposals, the approvals inbox,
 * closing mode and the safe-state job. Every judgment is made by the pure domain functions
 * (`decideControlAction`, `previewClosingMode`, `executeClosingMode`, `discardPendingActions`); this
 * module persists their decisions and audits them. Execution is simulated: the stored power state of
 * the load changes and an audit row is written, no hardware is driven.
 */
const {
  decideControlAction, discardPendingActions, previewClosingMode, executeClosingMode, estimateClosingSavings,
} = require('../domain/control');
const { tariffAt } = require('../domain/cost');
const { analyzeUsage } = require('../domain/recommendations');
const { round } = require('../domain/stats');
const { MS_PER_DAY, localDateKey } = require('../domain/time');
const { formatCop } = require('../domain/text');
const { badRequest, conflict, notFound } = require('../http/http-error');
const { findLoad, modulesByLoad, communicationOf, moduleStates } = require('./module-state');

/** Origin as the approvals inbox shows it: recommendation, user or schedule. */
const ORIGIN_VIEW = Object.freeze({ manual: 'user', recommendation: 'recommendation', closing_mode: 'schedule', autonomous: 'schedule' });
const PENDING_APPROVAL_TEXT = 'Pendiente de aprobación del administrador.';

/**
 * @param {{repos: object, clock: {now: function(): number}, access: object, analytics: object}} deps
 */
function createControl({ repos, clock, access, analytics }) {
  const nowIso = () => new Date(clock.now()).toISOString();

  function context(siteId, load) {
    const module_ = modulesByLoad(repos, siteId).get(load.id) || null;
    return { module: module_, moduleState: communicationOf(module_, clock.now()), domainLoad: analytics.domainLoad(load, module_ ? module_.id : null) };
  }

  /** Persists the outcome of a domain decision (action row, power state) and audits it. */
  function settle(decision, { siteId, load, user, origin, action, recommendationId = null, batchId = null, actionId = null, extra = {} }) {
    const at = nowIso();
    const decidedBy = user ? user.userId : null;
    const id = actionId ?? repos.controlActions.create({
      siteId, loadId: load.id, origin, action, recommendationId, batchId, requestedBy: decidedBy, reason: decision.message, requestedAt: at,
    }).id;
    if (decision.outcome === 'executed') {
      repos.controlActions.transition(id, { status: 'executed', decidedBy, at, reason: decision.message });
      repos.loads.setPowerState(load.id, decision.nextPowerState);
    } else if (decision.outcome === 'rejected' || decision.outcome === 'discarded') {
      repos.controlActions.transition(id, { status: decision.outcome, decidedBy, at, reason: decision.message });
    } else {
      repos.controlActions.annotate(id, decision.message);
    }
    access.audit({
      user, event: decision.audit.event, siteId, loadId: load.id, result: decision.audit.result, reason: decision.message,
      details: { actionId: id, action, origin, outcome: decision.outcome, reasonCode: decision.reason, flagged: decision.audit.flagged, simulated: true, ...extra },
    });
    return { actionId: id, outcome: decision.outcome, reason: decision.reason, message: decision.message };
  }

  function present(row, load, cache = {}) {
    const requester = row.requested_by ? (cache.users?.get(row.requested_by) ?? repos.users.getById(row.requested_by)?.username ?? null) : null;
    const rec = row.recommendation_id ? repos.recommendations.get(row.recommendation_id) : null;
    return {
      id: row.id, origin: ORIGIN_VIEW[row.origin], rawOrigin: row.origin, action: row.action, status: row.status,
      loadId: load.id, loadCode: load.code, loadName: load.name, criticality: load.criticality, controlMode: load.control_mode,
      executable: load.control_mode === 'control_enabled', requestedBy: requester, requestedAt: row.requested_at, decidedAt: row.decided_at, reason: row.reason,
      recommendationId: row.recommendation_id, recommendationTitle: rec ? rec.title : null,
      estimatedMonthlySavingsCop: rec ? Math.round(rec.monthly_savings_cop) : null,
    };
  }

  const requireLoad = (siteId, key) => {
    const load = findLoad(repos, siteId, key);
    if (!load) throw notFound('No existe ese equipo.', 'load_not_found');
    return load;
  };

  return {
    /** Manual on/off by an authorized person (permission toggle_load is checked by the route). */
    toggle({ siteId, loadKey, action, user }) {
      if (!['on', 'off'].includes(action)) throw badRequest('La acción debe ser "on" o "off".', 'invalid_action');
      const load = requireLoad(siteId, loadKey);
      const ctx = context(siteId, load);
      const decision = decideControlAction({
        load: ctx.domainLoad, action, origin: 'manual', approved: false, moduleState: ctx.moduleState, now: clock.now(), actor: user.username,
      });
      return { ...settle(decision, { siteId, load, user, origin: 'manual', action }), loadCode: load.code, simulated: true };
    },

    /** A proposal never executes: it waits in the approvals inbox (permission propose_action). */
    propose({ siteId, loadKey, action, reason, user }) {
      if (!['on', 'off'].includes(action)) throw badRequest('La acción debe ser "on" o "off".', 'invalid_action');
      const load = requireLoad(siteId, loadKey);
      const ctx = context(siteId, load);
      const decision = decideControlAction({
        load: ctx.domainLoad, action, origin: 'manual', approved: false, moduleState: ctx.moduleState, now: clock.now(), actor: user.username,
      });
      const note = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
      if (decision.outcome === 'rejected' || decision.outcome === 'discarded') {
        return { ...settle(decision, { siteId, load, user, origin: 'manual', action }), loadCode: load.code, simulated: true };
      }
      const row = repos.controlActions.create({
        siteId, loadId: load.id, origin: 'manual', action, requestedBy: user.userId,
        reason: note ? `${PENDING_APPROVAL_TEXT} Motivo: ${note}` : PENDING_APPROVAL_TEXT, requestedAt: nowIso(),
      });
      access.audit({ user, event: 'control_proposed', siteId, loadId: load.id, reason: row.reason, details: { actionId: row.id, action, origin: 'manual', simulated: true } });
      return { actionId: row.id, outcome: 'pending', reason: 'awaiting_approval', message: row.reason, loadCode: load.code, simulated: true };
    },

    /** Pending item created when a recommendation that implies switching a load off is accepted. */
    createFromRecommendation({ siteId, rec, load, user }) {
      const ctx = context(siteId, load);
      const probe = decideControlAction({
        load: ctx.domainLoad, action: 'off', origin: 'recommendation', approved: false, moduleState: ctx.moduleState, now: clock.now(), actor: user.username,
      });
      const executable = load.control_mode === 'control_enabled';
      const message = executable && probe.reason !== 'critical_load_protected' ? PENDING_APPROVAL_TEXT : probe.message;
      const row = repos.controlActions.create({
        siteId, loadId: load.id, origin: 'recommendation', recommendationId: rec.id, action: 'off', requestedBy: user.userId, reason: message, requestedAt: nowIso(),
      });
      access.audit({ user, event: 'control_requested', siteId, loadId: load.id, reason: message, details: { actionId: row.id, recommendationId: rec.id, executable, simulated: true } });
      return { actionId: row.id, executable, message };
    },

    approvals(siteId, { status = 'pending' } = {}) {
      const loads = new Map(repos.loads.listBySite(siteId).map((l) => [l.id, l]));
      const rows = repos.controlActions.list({ siteId, status, limit: 200 });
      return rows.map((row) => present(row, loads.get(row.load_id)));
    },

    proposalsOf(siteId, user) {
      const loads = new Map(repos.loads.listBySite(siteId).map((l) => [l.id, l]));
      return repos.controlActions.list({ siteId, limit: 100 }).filter((r) => r.requested_by === user.userId).map((row) => present(row, loads.get(row.load_id)));
    },

    /** Owner approves a pending action: the domain decides whether it can run now. */
    approve({ siteId, actionId, user }) {
      const row = repos.controlActions.get(Number(actionId));
      if (!row || row.site_id !== siteId) throw notFound('No existe esa solicitud.', 'action_not_found');
      if (row.status !== 'pending') throw conflict('Esta solicitud ya fue resuelta.', 'already_resolved');
      const load = repos.loads.get(row.load_id);
      const ctx = context(siteId, load);
      const decision = decideControlAction({
        load: ctx.domainLoad, action: row.action, origin: row.origin, approved: true, moduleState: ctx.moduleState, now: clock.now(), actor: user.username,
      });
      return { ...settle(decision, { siteId, load, user, origin: row.origin, action: row.action, actionId: row.id, recommendationId: row.recommendation_id, extra: { approvedBy: user.username } }), loadCode: load.code, simulated: true };
    },

    reject({ siteId, actionId, reason, user }) {
      const row = repos.controlActions.get(Number(actionId));
      if (!row || row.site_id !== siteId) throw notFound('No existe esa solicitud.', 'action_not_found');
      if (row.status !== 'pending') throw conflict('Esta solicitud ya fue resuelta.', 'already_resolved');
      const note = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : 'Rechazada por el administrador.';
      repos.controlActions.transition(row.id, { status: 'rejected', decidedBy: user.userId, at: nowIso(), reason: note });
      access.audit({ user, event: 'control_rejected', siteId, loadId: row.load_id, result: 'rejected', reason: note, details: { actionId: row.id, action: row.action, origin: row.origin, simulated: true } });
      return { actionId: row.id, outcome: 'rejected', message: note };
    },

    /** Closing mode, step 1: what would happen, without changing anything. */
    closingPreview(siteId) {
      const nowMs = clock.now();
      const modulesOfLoad = modulesByLoad(repos, siteId);
      const states = moduleStates(repos, siteId, nowMs);
      const loads = repos.loads.listBySite(siteId).map((l) => analytics.domainLoad(l, modulesOfLoad.get(l.id)?.id ?? null));
      const preview = previewClosingMode(loads, states);
      const tariff = tariffAt(analytics.tariffsOf(siteId), localDateKey(nowMs));
      const schedule = analytics.scheduleOf(siteId);
      const nightly = {};
      for (const item of preview.willSwitchOff) {
        const usage = analyzeUsage({ readings: analytics.series(item.loadId, nowMs - 15 * MS_PER_DAY, nowMs), schedule, now: nowMs });
        nightly[item.loadId] = usage.offHoursKwhPerDay;
      }
      const savings = estimateClosingSavings(preview, nightly, tariff ? tariff.copPerKwh : 0);
      return {
        willSwitchOff: preview.willSwitchOff, staysOn: preview.staysOn, alreadyOff: preview.alreadyOff,
        estimatedNightlySavings: { kwh: round(savings.kwh, 2), cop: Math.round(savings.cop), text: `Apagar estos equipos esta noche ahorraría unos ${formatCop(savings.cop)}.` },
        requiresConfirmation: true,
        confirmation: 'Envíe confirm: true para ejecutar el cierre.',
      };
    },

    /** Closing mode, step 2: executes what the preview lists (confirmation is mandatory). */
    closingConfirm({ siteId, confirm, user }) {
      if (confirm !== true) throw badRequest('Confirme el cierre para continuar: ningún equipo se apagó.', 'confirmation_required');
      const nowMs = clock.now();
      const modulesOfLoad = modulesByLoad(repos, siteId);
      const states = moduleStates(repos, siteId, nowMs);
      const loadRows = repos.loads.listBySite(siteId);
      const loads = loadRows.map((l) => analytics.domainLoad(l, modulesOfLoad.get(l.id)?.id ?? null));
      const result = executeClosingMode({ loads, moduleStates: states, now: nowMs, actor: user.username });
      const batchId = `closing-${nowIso()}`;
      const byId = new Map(loadRows.map((l) => [l.id, l]));
      for (const decision of result.decisions) {
        settle(decision, { siteId, load: byId.get(decision.loadId), user, origin: 'closing_mode', action: 'off', batchId, extra: { batchId } });
      }
      const preview = { willSwitchOff: result.decisions.map((d) => ({ loadId: d.loadId })) };
      access.audit({
        user, event: 'closing_mode', siteId, result: 'executed', reason: result.message,
        details: { batchId, switchedOff: result.switchedOff, failed: result.failed, kept: result.audit.kept, simulated: true, attempted: preview.willSwitchOff.length },
      });
      return {
        batchId, message: result.message, switchedOff: result.switchedOff.map((id) => byId.get(id).code), failed: result.failed,
        staysOn: result.staysOn, alreadyOff: result.alreadyOff, simulated: true,
      };
    },

    /**
     * Safe-state job (RNF-18): pending actions of modules silent for more than 5 minutes are discarded and
     * their loads stay energized. Returns the discarded actions.
     */
    runSafeState(siteId) {
      const nowMs = clock.now();
      const modulesOfLoad = modulesByLoad(repos, siteId);
      const loads = new Map(repos.loads.listBySite(siteId).map((l) => [l.id, l]));
      const pendingActions = repos.controlActions.list({ siteId, status: 'pending', limit: 500 }).map((row) => ({
        id: row.id, loadId: row.load_id, moduleId: modulesOfLoad.get(row.load_id)?.id, action: row.action, origin: row.origin, loadName: loads.get(row.load_id)?.name,
      }));
      if (!pendingActions.length) return [];
      const { discarded } = discardPendingActions({ pendingActions, moduleStates: moduleStates(repos, siteId, nowMs), now: nowMs });
      const at = nowIso();
      for (const d of discarded) {
        repos.controlActions.transition(d.actionId, { status: 'discarded', decidedBy: null, at, reason: d.message });
        access.audit({
          user: null, event: 'safe_state', siteId, loadId: d.loadId, result: 'discarded', reason: d.message,
          details: { actionId: d.actionId, action: d.audit.action, origin: d.audit.origin, reasonCode: d.reason, simulated: true },
        });
      }
      return discarded.map((d) => ({ actionId: d.actionId, loadId: d.loadId, message: d.message }));
    },
  };
}

module.exports = { createControl, ORIGIN_VIEW };
