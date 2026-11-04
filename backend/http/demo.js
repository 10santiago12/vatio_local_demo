'use strict';
/**
 * Demo Panel API (presenter tool). Guarded twice: the environment flag (on in local, off in production
 * unless VATIO_ENABLE_DEMO_PANEL=yes) and the owner role (permission view_demo_panel).
 */
const { HttpError } = require('./http-error');
const { json } = require('./router');
const { OUTCOME_STATUS } = require('./control');

const guard = (app) => {
  if (!app.config.demoPanelEnabled) throw new HttpError(404, 'El panel de demostración no está habilitado en este entorno.', 'demo_disabled');
};
const options = (doc) => ({ permission: 'view_demo_panel', guard, doc });

function register(router, app) {
  const { demo } = app;
  const bodyOf = async (ctx) => ctx.body();

  router.get('/api/demo/state', () => json(200, demo.state()), options('Estado del panel: reloj simulado, módulos simulados y alertas activas.'));
  router.post('/api/demo/clock', async (ctx) => json(200, demo.setClock(await bodyOf(ctx))), options('Reloj simulado: speed (1, 60, 3600), paused, advance (1h, 1d, 7d).'));
  router.post('/api/demo/anomaly', async (ctx) => json(200, demo.injectAnomaly(await bodyOf(ctx))), options('Inyecta un consumo anormal: loadCode, pct, durationMinutes.'));
  router.post('/api/demo/deterioration', async (ctx) => json(200, demo.simulateDeterioration(await bodyOf(ctx))), options('Simula el deterioro de un equipo: loadCode, days, pct.'));
  router.post('/api/demo/sign-on', () => json(200, demo.leaveSignOn()), options('Deja el letrero encendido esta noche.'));
  router.post('/api/demo/modules/:id/disconnect', ({ params }) => json(200, demo.disconnectModule(params.id)), options('Desconecta un módulo simulado (guarda lecturas en su memoria).'));
  router.post('/api/demo/modules/:id/reconnect', ({ params }) => json(200, demo.reconnectModule(params.id)), options('Reconecta un módulo y sincroniza su memoria: "Se sincronizaron N lecturas, 0 perdidas".'));
  router.post('/api/demo/try-critical-off', ({ user }) => {
    const result = demo.tryCriticalOff(user);
    return json(OUTCOME_STATUS[result.outcome], result);
  }, options('Intenta apagar un equipo crítico: se rechaza y queda auditado.'));
  router.post('/api/demo/try-unauthorized', async (ctx) => json(200, demo.tryUnauthorized(ctx.user, await bodyOf(ctx))), options('Intenta una acción sin permiso (asRole, permission): muestra el rechazo y el registro de auditoría.'));
  router.post('/api/demo/generate-loads', async (ctx) => json(200, demo.generateLoads(await bodyOf(ctx))), options('Crea N equipos de prueba con su historial (count).'));
  router.post('/api/demo/reset', ({ user }) => json(200, demo.reset(user)), options('Reinicia la demostración a los datos de la semilla.'));
}

module.exports = { register };
