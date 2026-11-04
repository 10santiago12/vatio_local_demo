'use strict';
/**
 * Application-layer access control and audit trail.
 *
 * Every protected action calls `require` (or `check`) with the permission it needs. The decision is
 * made by the domain `authorize`; a denial is written to the audit table (user, role, action, result
 * `rejected`, plain-Spanish reason) and raised as a 403, so a hidden button is never the only barrier
 * (RNF-10, RNF-14).
 */
const { authorize } = require('../domain/permissions');
const { HttpError } = require('../http/http-error');

/**
 * @param {{repos: object, clock: {now: function(): number, state: function(): {mode: string}}}} deps
 */
function createAccess({ repos, clock }) {
  const nowIso = () => new Date(clock.now()).toISOString();

  /**
   * Appends an audit row.
   * @param {{user?: object|null, event: string, siteId?: string, loadId?: number, result?: string, reason?: string, details?: object}} entry
   */
  function audit({ user = null, event, siteId = null, loadId = null, result = null, reason = null, details = {} }) {
    const at = nowIso();
    return repos.audit.append({
      at, actor: user ? user.username : 'system', event, siteId, details, userId: user ? user.userId : null,
      role: user ? user.roleCode : null, loadId, result, reason, simulatedAt: clock.state().mode === 'simulated' ? at : null,
    });
  }

  /** Decision without side effects on the request: returns the domain result and audits a denial. */
  function check(user, permission, context = {}) {
    const decision = authorize(user.roleCode, permission, { at: nowIso(), actor: user.username });
    if (!decision.allowed) {
      audit({
        user, event: 'permission_denied', siteId: context.siteId ?? null, loadId: context.loadId ?? null, result: 'rejected', reason: decision.message,
        details: { permission, attempted: context.action || permission, reasonCode: decision.reason, ...(context.details || {}) },
      });
    }
    return decision;
  }

  /** @throws {HttpError} 403 with the plain-Spanish message when the role lacks the permission. */
  function require_(user, permission, context = {}) {
    const decision = check(user, permission, context);
    if (!decision.allowed) throw new HttpError(403, decision.message, 'forbidden', { permission });
    return decision;
  }

  return { audit, check, require: require_ };
}

module.exports = { createAccess };
