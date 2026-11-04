'use strict';
/** Control: approvals inbox, manual toggle, proposals, closing mode, modules and the first-MVP control request. */
const { badRequest, HttpError } = require('./http-error');
const { json } = require('./router');

/** HTTP status of a control outcome. */
const LEGACY_CRITICAL = ['freezer', 'fridge', 'pos'];
const OUTCOME_STATUS = Object.freeze({ executed: 200, pending: 202, rejected: 422, discarded: 409 });

function register(router, app) {
  const { siteId, control, modules } = app;

  router.get('/api/control/approvals', ({ query }) => json(200, { approvals: control.approvals(siteId, { status: query.status || 'pending' }) }), {
    permission: 'approve_action', doc: 'Bandeja de aprobaciones: acciones pendientes con origen (recommendation, user, schedule), equipo y ahorro estimado.',
  });
  router.post('/api/control/approvals/:id/approve', ({ params, user }) => {
    const result = control.approve({ siteId, actionId: params.id, user });
    return json(OUTCOME_STATUS[result.outcome], result);
  }, { permission: 'approve_action', doc: 'Aprueba una acción; el dominio decide si se ejecuta o queda pendiente (solo monitoreo, módulo sin señal).' });
  router.post('/api/control/approvals/:id/reject', async (ctx) => json(200, control.reject({ siteId, actionId: ctx.params.id, reason: (await ctx.body()).reason, user: ctx.user })), {
    permission: 'approve_action', doc: 'Rechaza una acción pendiente con un motivo opcional.',
  });

  router.post('/api/control/toggle', async (ctx) => {
    const body = await ctx.body();
    const result = control.toggle({ siteId, loadKey: body.load, action: body.action, user: ctx.user });
    return json(OUTCOME_STATUS[result.outcome], result);
  }, { permission: 'toggle_load', doc: 'Encender o apagar un equipo (load, action on/off). Un equipo crítico nunca se apaga; en solo monitoreo queda pendiente.' });

  router.post('/api/control/proposals', async (ctx) => {
    const body = await ctx.body();
    const result = control.propose({ siteId, loadKey: body.load, action: body.action, reason: body.reason, user: ctx.user });
    return json(OUTCOME_STATUS[result.outcome], result);
  }, { permission: 'propose_action', doc: 'Propone una acción: nunca se ejecuta, queda en la bandeja del administrador.' });
  router.get('/api/control/proposals', ({ user }) => json(200, { proposals: control.proposalsOf(siteId, user) }), { permission: 'propose_action', doc: 'Propuestas hechas por el usuario actual.' });

  router.get('/api/control/closing-mode', () => json(200, control.closingPreview(siteId)), {
    permission: 'activate_closing_mode', doc: 'Vista previa del modo cierre: qué se apaga, qué queda encendido y por qué, y el ahorro estimado de la noche.',
  });
  router.post('/api/control/closing-mode', async (ctx) => json(200, control.closingConfirm({ siteId, confirm: (await ctx.body()).confirm, user: ctx.user })), {
    permission: 'activate_closing_mode', doc: 'Ejecuta el modo cierre; exige confirm: true.',
  });

  router.get('/api/modules', () => json(200, { modules: modules.list(siteId) }), { permission: 'view_modules', doc: 'Módulos de medición con estado, latido y última lectura.' });
  router.post('/api/modules', async (ctx) => json(201, modules.register(siteId, await ctx.body(), ctx.user)), {
    permission: 'register_module', doc: 'Registra un módulo (id, manufacturer, loadCode o loadName); aparece activo y reporta su primera lectura en 2 minutos.',
  });
  router.get('/api/modules/:id/diagnostics', ({ params }) => json(200, modules.diagnostics(siteId, params.id)), { permission: 'view_diagnostics', doc: 'Diagnóstico de un módulo en lenguaje sencillo.' });

  // First-MVP contract: POST /api/control/requests {site_id, load_id, action}.
  router.post('/api/control/requests', async (ctx) => {
    let request;
    try { request = await ctx.body(); } catch { throw badRequest('Solicitud inválida.'); }
    if (request.site_id !== siteId) throw new HttpError(403, 'Sede no autorizada.', 'site_forbidden');
    if (request.action !== 'off' || typeof request.load_id !== 'string') throw badRequest('Solicitud inválida.');
    if (!app.repos.loads.getByCode(siteId, request.load_id)) {
      // First-MVP rule: the critical loads are rejected (and audited) even before a module registered them.
      if (!LEGACY_CRITICAL.includes(request.load_id)) throw badRequest('Solicitud inválida.');
      app.access.audit({ user: ctx.user, event: 'critical_load_off_attempt', siteId, result: 'rejected', reason: 'Equipo crítico: no se puede apagar.', details: { loadCode: request.load_id, simulated: true } });
      throw new HttpError(422, 'Carga crítica: acción rechazada.', 'critical_load_protected');
    }
    const result = control.toggle({ siteId, loadKey: request.load_id, action: 'off', user: ctx.user });
    if (result.outcome === 'rejected' || result.outcome === 'discarded') {
      const critical = result.reason === 'critical_load_protected';
      throw new HttpError(422, critical ? 'Carga crítica: acción rechazada.' : result.message, result.reason);
    }
    return json(201, { id: result.actionId, status: result.outcome, simulated: true, message: result.message });
  }, { permission: 'toggle_load', doc: 'Solicitud de apagado del primer MVP (equivale a /api/control/toggle con action off).' });
}

module.exports = { register, OUTCOME_STATUS };
