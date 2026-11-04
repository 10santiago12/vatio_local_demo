'use strict';
/** Owner-only monitoring: recent events, error log and runtime metrics. Permissions are checked by the route. */
const fs = require('node:fs');
const { badRequest } = require('../http/http-error');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts `AAAA-MM-DD` or an ISO instant; a date-only `to` includes the whole day. */
function parseBound(value, name, isEnd) {
  if (value === undefined || value === '') return undefined;
  const text = String(value);
  const iso = DATE_ONLY.test(text) ? `${text}T${isEnd ? '23:59:59.999' : '00:00:00.000'}Z` : text;
  if (Number.isNaN(Date.parse(iso))) throw badRequest(`El filtro "${name}" no es una fecha válida.`, 'invalid_filter');
  return new Date(iso).toISOString();
}

function parseLimit(value) {
  if (value === undefined || value === '') return 100;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw badRequest('El límite debe ser un entero entre 1 y 500.', 'invalid_filter');
  return n;
}

const parseJson = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

function createOps({ repos, config, auth, metrics, backups }) {
  function events(query) {
    const rows = repos.events.list({ name: query.name || undefined, from: parseBound(query.from, 'from', false), to: parseBound(query.to, 'to', true), limit: parseLimit(query.limit) });
    return { count: rows.length, events: rows.map((r) => ({ id: r.id, at: r.at, name: r.name, userId: r.user_id, properties: parseJson(r.properties) })) };
  }

  function errors(query) {
    const rows = repos.errors.list({ level: query.level || undefined, limit: parseLimit(query.limit) });
    return {
      count: rows.length,
      errors: rows.map((r) => ({ id: r.id, at: r.at, level: r.level, source: r.source, message: r.message, stack: r.stack, context: parseJson(r.context), requestId: r.request_id })),
    };
  }

  function dbSizeBytes() {
    try { return fs.statSync(config.dbPath).size; } catch { return 0; }
  }

  function metricsSnapshot() {
    const [lastOk] = repos.events.list({ name: 'backup_created', limit: 1 });
    const [lastFail] = repos.events.list({ name: 'backup_failed', limit: 1 });
    const last = [lastOk, lastFail].filter(Boolean).sort((a, b) => b.id - a.id)[0] || null;
    return {
      ...metrics.snapshot(),
      db: { size_bytes: dbSizeBytes() },
      sessions: { active: auth.activeSessions() },
      backup: { last_at: last ? last.at : null, last_status: last ? (last.name === 'backup_created' ? 'ok' : 'failed') : null, stored: backups.list().length },
    };
  }

  return { events, errors, metrics: metricsSnapshot };
}

module.exports = { createOps };
