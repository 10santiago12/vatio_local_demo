'use strict';
// Operational data: alerts, recommendations, control actions, audit, events and the error log.

const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));

/** Builds a WHERE clause from optional equality filters; keys are fixed by the caller (never user input). */
function where(filters) {
  const parts = [];
  const params = [];
  for (const [column, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) { parts.push(`${column} = ?`); params.push(value); }
  }
  return { clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

function createOperationsRepositories(db) {
  const q = {
    alertInsert: db.prepare(`INSERT INTO alerts(site_id, load_id, type, detected_at, excess_pct, excess_cost_per_hour_cop, projected_monthly_cost_cop, message, details)
      VALUES(?,?,?,?,?,?,?,?,?)`),
    alert: db.prepare('SELECT * FROM alerts WHERE id = ?'),
    alertActive: db.prepare("SELECT * FROM alerts WHERE load_id = ? AND type = ? AND status = 'active'"),
    alertReview: db.prepare("UPDATE alerts SET status = 'reviewed', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'active'"),
    alertCount: db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE site_id = ? AND status = 'active'"),

    recInsert: db.prepare(`INSERT INTO recommendations(site_id, load_id, type, title, assumption, monthly_savings_kwh, monthly_savings_cop, score, confidence, created_at, baseline_window_start, baseline_window_end)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`),
    rec: db.prepare('SELECT * FROM recommendations WHERE id = ?'),
    recDecide: db.prepare(`UPDATE recommendations SET status = ?, decided_by = ?, decided_at = ?, reason = ?, postponed_until = ?,
      accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END
      WHERE id = ? AND status IN ('pending', 'postponed')`),

    actionInsert: db.prepare(`INSERT INTO control_actions(site_id, load_id, origin, recommendation_id, batch_id, action, status, requested_by, reason, requested_at)
      VALUES(?,?,?,?,?,?,'pending',?,?,?)`),
    action: db.prepare('SELECT * FROM control_actions WHERE id = ?'),
    actionDecide: db.prepare(`UPDATE control_actions SET status = ?, decided_by = ?, decided_at = ?, reason = COALESCE(?, reason),
      executed_at = CASE WHEN ? = 'executed' THEN ? ELSE executed_at END
      WHERE id = ? AND status IN ('pending', 'approved')`),

    auditInsert: db.prepare(`INSERT INTO audit(at, actor, event, site_id, details, user_id, role, load_id, result, reason, simulated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`),

    eventInsert: db.prepare('INSERT INTO events(at, user_id, site_id, name, properties) VALUES(?,?,?,?,?)'),
    errorInsert: db.prepare('INSERT INTO error_log(at, level, source, message, stack, context, request_id) VALUES(?,?,?,?,?,?,?)')
  };

  return {
    alerts: {
      create({ siteId, loadId, type, detectedAt, excessPct = null, excessCostPerHourCop = null, projectedMonthlyCostCop = null, message, details }) {
        const result = q.alertInsert.run(siteId, loadId, type, detectedAt, excessPct, excessCostPerHourCop, projectedMonthlyCostCop, message, json(details));
        return q.alert.get(Number(result.lastInsertRowid));
      },
      get: (id) => q.alert.get(id) ?? null,
      findActive: (loadId, type) => q.alertActive.get(loadId, type) ?? null,
      list({ siteId, loadId, status, type, limit = 200 } = {}) {
        const w = where({ site_id: siteId, load_id: loadId, status, type });
        return db.prepare(`SELECT * FROM alerts ${w.clause} ORDER BY detected_at DESC, id DESC LIMIT ?`).all(...w.params, limit);
      },
      /** Marks an active alert as reviewed. Returns false if it was not active. */
      review: (id, userId, at) => q.alertReview.run(userId, at, id).changes === 1,
      countActive: (siteId) => q.alertCount.get(siteId).n
    },
    recommendations: {
      create({ siteId, loadId, type, title, assumption, monthlySavingsKwh = 0, monthlySavingsCop = 0, score, confidence, createdAt, baselineWindowStart = null, baselineWindowEnd = null }) {
        const result = q.recInsert.run(siteId, loadId, type, title, assumption, monthlySavingsKwh, monthlySavingsCop, score, confidence, createdAt, baselineWindowStart, baselineWindowEnd);
        return q.rec.get(Number(result.lastInsertRowid));
      },
      get: (id) => q.rec.get(id) ?? null,
      /** Ordered by score, highest first. */
      list({ siteId, loadId, status, limit = 200 } = {}) {
        const w = where({ site_id: siteId, load_id: loadId, status });
        return db.prepare(`SELECT * FROM recommendations ${w.clause} ORDER BY score DESC, id LIMIT ?`).all(...w.params, limit);
      },
      /** Accept, postpone or discard a pending or postponed recommendation. Returns false if it was already final. */
      decide(id, { status, userId = null, at, reason = null, postponedUntil = null }) {
        return q.recDecide.run(status, userId, at, reason, postponedUntil, status, at, id).changes === 1;
      }
    },
    controlActions: {
      create({ siteId, loadId, origin, action, recommendationId = null, batchId = null, requestedBy = null, reason = null, requestedAt }) {
        const result = q.actionInsert.run(siteId, loadId, origin, recommendationId, batchId, action, requestedBy, reason, requestedAt);
        return q.action.get(Number(result.lastInsertRowid));
      },
      get: (id) => q.action.get(id) ?? null,
      list({ siteId, loadId, status, batchId, limit = 200 } = {}) {
        const w = where({ site_id: siteId, load_id: loadId, status, batch_id: batchId });
        return db.prepare(`SELECT * FROM control_actions ${w.clause} ORDER BY requested_at DESC, id DESC LIMIT ?`).all(...w.params, limit);
      },
      /** Moves a pending/approved action to approved, rejected, executed or discarded. Returns false if already final. */
      transition(id, { status, decidedBy = null, at, reason = null }) {
        return q.actionDecide.run(status, decidedBy, at, reason, status, at, id).changes === 1;
      }
    },
    audit: {
      append({ at = new Date().toISOString(), actor, event, siteId = null, details = {}, userId = null, role = null, loadId = null, result = null, reason = null, simulatedAt = null }) {
        const row = q.auditInsert.run(at, actor, event, siteId, JSON.stringify(details), userId, role, loadId, result, reason, simulatedAt);
        return Number(row.lastInsertRowid);
      },
      list({ siteId, userId, loadId, result, limit = 200 } = {}) {
        const w = where({ site_id: siteId, user_id: userId, load_id: loadId, result });
        return db.prepare(`SELECT * FROM audit ${w.clause} ORDER BY id DESC LIMIT ?`).all(...w.params, limit);
      }
    },
    events: {
      track({ at = new Date().toISOString(), name, userId = null, siteId = null, properties }) {
        return Number(q.eventInsert.run(at, userId, siteId, name, json(properties)).lastInsertRowid);
      },
      list({ name, userId, limit = 200 } = {}) {
        const w = where({ name, user_id: userId });
        return db.prepare(`SELECT * FROM events ${w.clause} ORDER BY id DESC LIMIT ?`).all(...w.params, limit);
      }
    },
    errors: {
      log({ at = new Date().toISOString(), level = 'error', source, message, stack = null, context, requestId = null }) {
        return Number(q.errorInsert.run(at, level, source, message, stack, json(context), requestId).lastInsertRowid);
      },
      list({ level, limit = 200 } = {}) {
        const w = where({ level });
        return db.prepare(`SELECT * FROM error_log ${w.clause} ORDER BY id DESC LIMIT ?`).all(...w.params, limit);
      }
    }
  };
}

module.exports = { createOperationsRepositories };
