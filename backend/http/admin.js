'use strict';
/** Administration: users, audit trail, site settings, tariffs and per-load configuration. */
const { ROLES } = require('../domain/constants');
const { localDayStartMs, addDays } = require('../domain/time');
const { badRequest, notFound } = require('./http-error');
const { json } = require('./router');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** ISO bound of a local date key (start of that day), or null when absent. */
function dayBound(value, field, offsetDays = 0) {
  if (value === undefined || value === '') return null;
  if (!DATE_KEY.test(value) || Number.isNaN(Date.parse(value))) throw badRequest(`El filtro "${field}" debe tener el formato AAAA-MM-DD.`, 'invalid_filter');
  return new Date(localDayStartMs(addDays(value, offsetDays))).toISOString();
}

function register(router, app) {
  const { repos, siteId } = app;
  const idOf = (ctx) => ctx.params.id;

  // ---- Users (owner) ----
  router.get('/api/users', () => json(200, { users: app.users.list(), roles: app.users.roles() }), { permission: 'manage_users', doc: 'Lista usuarios y perfiles disponibles.' });
  router.post('/api/users', async (ctx) => json(201, app.users.create(await ctx.body(), ctx.user)), { permission: 'manage_users', doc: 'Crea un usuario con perfil y contraseña definida por el administrador (mínimo 16 caracteres).' });
  router.patch('/api/users/:id/role', async (ctx) => json(200, app.users.changeRole(idOf(ctx), (await ctx.body()).role, ctx.user)), { permission: 'manage_users', doc: 'Cambia el perfil de un usuario.' });
  router.post('/api/users/:id/deactivate', (ctx) => json(200, app.users.setActive(idOf(ctx), false, ctx.user)), { permission: 'manage_users', doc: 'Desactiva un usuario y cierra sus sesiones.' });
  router.post('/api/users/:id/activate', (ctx) => json(200, app.users.setActive(idOf(ctx), true, ctx.user)), { permission: 'manage_users', doc: 'Reactiva un usuario.' });
  router.post('/api/users/:id/reset-password', async (ctx) => json(200, app.users.resetPassword(idOf(ctx), (await ctx.body()).password, ctx.user)), { permission: 'manage_users', doc: 'Define una contraseña nueva (mínimo 16 caracteres) y cierra las sesiones del usuario.' });

  // ---- Audit ----
  router.get('/api/audit', ({ query }) => {
    const limit = Math.max(1, Math.min(500, Number(query.limit || 100)));
    const offset = Math.max(0, Number(query.offset || 0));
    let loadId;
    if (query.load) {
      const load = /^\d+$/.test(query.load) ? repos.loads.get(Number(query.load)) : repos.loads.getByCode(siteId, query.load);
      if (!load) throw notFound('No existe ese equipo.', 'load_not_found');
      loadId = load.id;
    }
    if (query.role && !Object.prototype.hasOwnProperty.call(ROLES, query.role)) throw badRequest('El perfil indicado no existe.', 'invalid_filter');
    if (query.result && !['executed', 'rejected', 'discarded'].includes(query.result)) throw badRequest('El resultado debe ser executed, rejected o discarded.', 'invalid_filter');
    const rows = repos.audit.list({
      actor: query.user, role: query.role, event: query.action, loadId, result: query.result,
      from: dayBound(query.from, 'from'), to: dayBound(query.to, 'to', 1), limit, offset,
    });
    const loadCodes = new Map(repos.loads.listBySite(siteId).map((l) => [l.id, l.code]));
    return json(200, {
      count: rows.length,
      entries: rows.map((r) => ({
        id: r.id, at: r.at, user: r.actor, role: r.role, roleName: ROLES[r.role] || null, action: r.event, result: r.result, reason: r.reason,
        loadId: r.load_id, loadCode: loadCodes.get(r.load_id) || null, siteId: r.site_id, simulatedAt: r.simulated_at, details: r.details ? JSON.parse(r.details) : {},
      })),
    });
  }, { permission: 'view_audit', doc: 'Registro de auditoría con filtros: from, to, user, role, action, load, result, limit, offset.' });

  // ---- Settings, tariffs, load configuration (owner) ----
  router.get('/api/settings', () => json(200, app.settings.getSettings(siteId)), { permission: 'configure', doc: 'Configuración del local: inversión, factor de emisión, umbral de alertas y horario.' });
  router.put('/api/settings', async (ctx) => json(200, app.settings.updateSettings(siteId, await ctx.body(), ctx.user)), { permission: 'configure', doc: 'Actualiza la configuración (validada).' });
  router.get('/api/tariffs', () => json(200, { tariffs: app.settings.listTariffs(siteId) }), { permission: 'configure', doc: 'Historial de tarifas.' });
  router.post('/api/tariffs', async (ctx) => json(201, app.settings.createTariff(siteId, await ctx.body(), ctx.user)), { permission: 'configure', doc: 'Crea una tarifa con fecha de inicio; solo afecta los costos desde esa fecha.' });
  router.get('/api/loads/config', () => json(200, { loads: app.settings.listLoadConfigs(siteId) }), { permission: 'configure', doc: 'Criticidad y modo de control de cada equipo.' });
  router.put('/api/loads/:load/config', async (ctx) => json(200, app.settings.updateLoadConfig(siteId, ctx.params.load, await ctx.body(), ctx.user)), { permission: 'configure', doc: 'Cambia nombre, criticidad y modo de control; un equipo crítico nunca puede tener control habilitado.' });
}

module.exports = { register };
