'use strict';
/** Operations screens: simple view, load list and detail, alerts and recommendations. */
const { json } = require('./router');

function register(router, app) {
  const { siteId } = app;

  router.get('/api/simple', () => json(200, app.operations.simpleView(siteId)), { permission: 'view_simple', doc: 'Vista simple: gasto de hoy, comparación con un día normal, ranking, alertas y 3 recomendaciones, sin datos técnicos.' });

  router.get('/api/loads', ({ query }) => json(200, app.operations.listLoads(siteId, query)), {
    permission: 'view_operations', doc: 'Panel de equipos. Filtros: criticality, status, period (today, 7d, 30d), sort (consumption, cost, name).',
  });
  router.get('/api/loads/:load', ({ params, user }) => json(200, app.operations.loadDetail(siteId, params.load, user.roleCode)), {
    permission: 'view_load_detail', doc: 'Detalle de un equipo; el bloque technical solo aparece para perfiles con acceso a diagnósticos.',
  });

  router.get('/api/alerts', ({ query }) => json(200, { alerts: app.alerts.list(siteId, query) }), { permission: 'view_alerts', doc: 'Alertas. Filtros: view (active, history, all), type, load.' });
  router.post('/api/alerts/run', () => json(200, (({ checked, created }) => ({ checked, created: created.length }))(app.alerts.run(siteId))), { permission: 'review_alert', doc: 'Ejecuta los detectores de alertas ahora.' });
  router.post('/api/alerts/:id/review', ({ params, user }) => json(200, app.alerts.review(siteId, params.id, user)), { permission: 'review_alert', doc: 'Marcar como revisada: la alerta pasa al historial.' });

  router.get('/api/recommendations', ({ query }) => {
    app.recommendations.ensureFresh(siteId);
    return json(200, { recommendations: app.recommendations.list(siteId, query) });
  }, { permission: 'view_recommendations', doc: 'Recomendaciones ordenadas por puntaje. Filtros: status, load.' });
  router.post('/api/recommendations/refresh', () => json(200, { created: app.recommendations.generate(siteId) }), { permission: 'decide_recommendation', doc: 'Genera recomendaciones nuevas ahora.' });
  router.post('/api/recommendations/:id/decision', async (ctx) => json(200, app.recommendations.decide(siteId, ctx.params.id, await ctx.body(), ctx.user)), {
    permission: 'decide_recommendation', doc: 'Aceptar (accept), posponer (postpone, days) o descartar (discard) con un motivo opcional.',
  });
}

module.exports = { register };
