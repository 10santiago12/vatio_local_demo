'use strict';
/** Product events sent by the UI. (Owner-only monitoring and backup endpoints are added below.) */
const { json } = require('./router');

function register(router, app) {
  router.post('/api/events', async (ctx) => json(202, app.uiEvents.record(ctx.user, await ctx.body())), {
    doc: 'Registra un evento de uso de la interfaz (page_view, report_view, help_opened) con la página opcional; máximo 60 por minuto por usuario.',
  });
}

module.exports = { register };
