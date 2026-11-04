'use strict';
/**
 * Recommendation use cases (RF-05, HU-05): generate and persist with the domain rules (descending score,
 * never switching a critical load off, none for loads still building their baseline), list with savings,
 * score explanation and evidence, and decide (accept, postpone, discard).
 *
 * Accepting a recommendation that implies switching a load off creates a PENDING control action: a
 * control-enabled load waits for the administrator's approval; a monitor-only load gets a pending item
 * that carries the explanation and can never be executed.
 */
const { generateRecommendations } = require('../domain/recommendations');
const { MS_PER_DAY, MS_PER_HOUR } = require('../domain/time');
const { badRequest, conflict, notFound } = require('../http/http-error');
const { findLoad } = require('./module-state');

const SWITCH_OFF_TYPES = ['off_hours_shutdown', 'schedule', 'reduce_standby'];
const DECISIONS = Object.freeze({ accept: 'accepted', postpone: 'postponed', discard: 'discarded' });
/** A discarded recommendation is not offered again for this long. */
const DISCARD_QUIET_DAYS = 30;
const REGENERATE_MS = 6 * MS_PER_HOUR;

/** @param {{repos: object, clock: {now: function(): number}, analytics: object, access: object, control: object}} deps */
function createRecommendations({ repos, clock, analytics, access, control }) {
  let lastGeneratedAt = null;

  function present(row) {
    const load = repos.loads.get(row.load_id);
    return {
      id: row.id, loadId: row.load_id, loadCode: load ? load.code : null, loadName: load ? load.name : null, type: row.type, title: row.title,
      description: row.description, assumption: row.assumption, monthlySavingsKwh: row.monthly_savings_kwh, monthlySavingsCop: row.monthly_savings_cop,
      score: row.score, scoreExplanation: row.score_explanation, confidence: row.confidence, evidence: row.evidence ? JSON.parse(row.evidence) : null,
      status: row.status, createdAt: row.created_at, decidedAt: row.decided_at, acceptedAt: row.accepted_at, postponedUntil: row.postponed_until, reason: row.reason,
    };
  }

  /** Whether a candidate repeats something already pending, applied, postponed or recently discarded. */
  function alreadyKnown(siteId, candidate, nowMs) {
    return repos.recommendations.list({ siteId, loadId: candidate.loadId }).some((r) => {
      if (r.type !== candidate.type) return false;
      if (r.status === 'discarded') return nowMs - Date.parse(r.decided_at) < DISCARD_QUIET_DAYS * MS_PER_DAY;
      return true;
    });
  }

  function generate(siteId) {
    const nowMs = clock.now();
    const tariffs = analytics.tariffsOf(siteId);
    const schedule = analytics.scheduleOf(siteId);
    const entries = [];
    for (const row of repos.loads.listBySite(siteId)) {
      const baseline = analytics.baselineOf(row, nowMs);
      if (baseline.status !== 'ready') continue;
      const alert = repos.alerts.findActive(row.id, 'maintenance');
      entries.push({
        load: { id: row.id, name: row.name, criticality: row.criticality, typicalPowerW: row.typical_power_w }, baseline,
        readings: analytics.series(row.id, nowMs - 16 * MS_PER_DAY, nowMs),
        maintenanceAlert: alert ? { type: alert.type, excessPct: alert.excess_pct, projectedMonthlyCostCop: alert.projected_monthly_cost_cop } : null,
      });
    }
    const createdAt = new Date(nowMs).toISOString();
    const created = [];
    if (tariffs.length) {
      for (const c of generateRecommendations({ loads: entries, schedule, tariffs, now: nowMs })) {
        if (alreadyKnown(siteId, c, nowMs)) continue;
        const baseline = entries.find((e) => e.load.id === c.loadId).baseline;
        created.push(repos.recommendations.create({
          siteId, loadId: c.loadId, type: c.type, title: c.title, assumption: c.assumption, monthlySavingsKwh: c.monthlySavingsKwh,
          monthlySavingsCop: c.monthlySavingsCop, score: c.score, confidence: c.confidence, createdAt, baselineWindowStart: baseline.windowStart,
          baselineWindowEnd: baseline.windowEnd, description: c.description, evidence: c.evidence, scoreExplanation: c.scoreExplanation,
        }));
      }
    }
    lastGeneratedAt = nowMs;
    return created.map(present);
  }

  return {
    present,
    generate,
    /** Generates when nothing was generated for 6 simulated hours (called before listing and by the job). */
    ensureFresh(siteId) {
      const nowMs = clock.now();
      if (lastGeneratedAt === null || nowMs - lastGeneratedAt >= REGENERATE_MS || nowMs < lastGeneratedAt) generate(siteId);
    },

    list(siteId, { status = 'pending', load } = {}) {
      if (!['pending', 'accepted', 'postponed', 'discarded', 'all'].includes(status)) throw badRequest('El estado no es válido.', 'invalid_filter');
      let loadId;
      if (load) {
        const row = findLoad(repos, siteId, load);
        if (!row) throw notFound('No existe ese equipo.', 'load_not_found');
        loadId = row.id;
      }
      return repos.recommendations.list({ siteId, loadId, status: status === 'all' ? undefined : status }).map(present);
    },

    /** Accept, postpone or discard (with an optional reason). */
    decide(siteId, id, input, user) {
      const row = repos.recommendations.get(Number(id));
      if (!row || row.site_id !== siteId) throw notFound('No existe esa recomendación.', 'recommendation_not_found');
      const status = DECISIONS[input.action];
      if (!status) throw badRequest('La acción debe ser accept, postpone o discard.', 'invalid_action');
      const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 300) : null;
      const nowMs = clock.now();
      const at = new Date(nowMs).toISOString();
      let postponedUntil = null;
      if (status === 'postponed') {
        const days = input.days === undefined ? 7 : input.days;
        if (!Number.isInteger(days) || days < 1 || days > 90) throw badRequest('Posponer: indique entre 1 y 90 días.', 'invalid_days');
        postponedUntil = new Date(nowMs + days * MS_PER_DAY).toISOString();
      }
      if (!repos.recommendations.decide(row.id, { status, userId: user.userId, at, reason, postponedUntil })) throw conflict('Esta recomendación ya fue resuelta.', 'already_resolved');
      const updated = repos.recommendations.get(row.id);
      let controlAction = null;
      if (status === 'accepted' && SWITCH_OFF_TYPES.includes(row.type)) {
        controlAction = control.createFromRecommendation({ siteId, rec: updated, load: repos.loads.get(row.load_id), user });
      }
      access.audit({
        user, event: `recommendation_${input.action}`, siteId, loadId: row.load_id, result: 'executed', reason,
        details: { recommendationId: row.id, title: row.title, controlActionId: controlAction ? controlAction.actionId : null },
      });
      return { recommendation: present(updated), controlAction };
    },
  };
}

module.exports = { createRecommendations };
