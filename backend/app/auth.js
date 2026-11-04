'use strict';
/**
 * Authentication: password login with throttling, in-memory sessions with CSRF tokens, logout and
 * session invalidation when a user is deactivated or changes role.
 *
 * Session lifetime and login throttling use the wall clock (`wallNow`), never the simulated demo
 * clock, so advancing simulated time cannot log everybody out.
 */
const crypto = require('node:crypto');
const { ROLES } = require('../domain/constants');
const { permissionsOf } = require('../domain/permissions');
const { verifyPassword } = require('./passwords');

const SESSION_MS = 8 * 3600000;
const THROTTLE_WINDOW_MS = 60000;
const THROTTLE_MAX = 10;
const COOKIE = 'vatio_session';

/**
 * @param {{repos: object, access: object, wallNow: function(): number}} deps
 */
function createAuth({ repos, access, wallNow }) {
  const sessions = new Map();
  const attempts = new Map();

  /** Public description of a session (what /api/auth/me returns). */
  function describe(session) {
    return {
      username: session.username,
      role: ROLES[session.roleCode],
      roleCode: session.roleCode,
      displayName: session.displayName,
      permissions: permissionsOf(session.roleCode),
      csrf: session.csrf,
    };
  }

  function login(username, password, ip) {
    const now = wallNow();
    let a = attempts.get(ip);
    if (!a || now - a.since > THROTTLE_WINDOW_MS) { a = { since: now, count: 0 }; attempts.set(ip, a); }
    if (++a.count > THROTTLE_MAX) return { limited: true };
    const user = repos.users.getByUsername(typeof username === 'string' ? username : '');
    const valid = verifyPassword(password, user?.salt, user?.hash);
    if (!user || !user.active || !valid) {
      access.audit({ user: null, event: 'login_failed', result: 'rejected', reason: 'Usuario o contraseña incorrectos.', details: {} });
      return null;
    }
    attempts.delete(ip);
    const id = crypto.randomBytes(32).toString('hex');
    const session = {
      userId: user.id, username: user.username, roleCode: user.role, displayName: user.display_name || user.username,
      csrf: crypto.randomBytes(32).toString('hex'), expires: now + SESSION_MS,
    };
    sessions.set(id, session);
    repos.users.touchLogin(user.id, new Date(now).toISOString());
    access.audit({ user: session, event: 'login', details: {} });
    return { id, ...describe(session) };
  }

  function cookieValue(req) {
    return (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  }

  /** The live session of a request, or null. The role is re-read from the database on every request. */
  function session(req) {
    const id = cookieValue(req);
    const s = id ? sessions.get(id) : null;
    if (!s || s.expires < wallNow()) { if (id) sessions.delete(id); return null; }
    const user = repos.users.getById(s.userId);
    if (!user || !user.active) { sessions.delete(id); return null; }
    s.roleCode = user.role;
    return s;
  }

  function logout(req) {
    const id = cookieValue(req);
    const s = id ? sessions.get(id) : null;
    if (id) sessions.delete(id);
    return s || null;
  }

  /** Drops every session of a user (deactivation, password reset). */
  function invalidateUser(userId) {
    let dropped = 0;
    for (const [id, s] of sessions) if (s.userId === userId) { sessions.delete(id); dropped += 1; }
    return dropped;
  }

  /** Number of live (not expired) sessions. */
  function activeSessions() {
    const now = wallNow();
    return [...sessions.values()].filter((s) => s.expires >= now).length;
  }

  return { activeSessions, login, session, logout, invalidateUser, describe, COOKIE, SESSION_MS };
}

module.exports = { createAuth, COOKIE };
