'use strict';
/**
 * Page-view style events sent by the UI (POST /api/events): a fixed whitelist of names, one short
 * `page` property and a per-user rate limit, so the endpoint cannot be used to fill the database.
 */
const { badRequest, HttpError } = require('../http/http-error');

const UI_EVENTS = Object.freeze(['page_view', 'report_view', 'help_opened']);
const LIMIT = 60;
const WINDOW_MS = 60000;
const PAGE = /^[\w\-./#]{1,60}$/;

function createUiEvents({ track, wallNow }) {
  const windows = new Map();
  return {
    record(user, input) {
      const now = wallNow();
      let w = windows.get(user.userId);
      if (!w || now - w.since > WINDOW_MS) { w = { since: now, count: 0 }; windows.set(user.userId, w); }
      if (++w.count > LIMIT) throw new HttpError(429, 'Demasiados eventos. Intente de nuevo en un minuto.', 'rate_limited');
      const name = input && input.name;
      if (!UI_EVENTS.includes(name)) throw badRequest('Evento no permitido.', 'invalid_event');
      const page = input.page === undefined ? null : String(input.page);
      if (page !== null && !PAGE.test(page)) throw badRequest('La página indicada no es válida.', 'invalid_event');
      track(name, { user, properties: page === null ? undefined : { page } });
      return { ok: true };
    },
  };
}

module.exports = { createUiEvents, UI_EVENTS };
