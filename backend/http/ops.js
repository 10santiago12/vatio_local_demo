'use strict';
/** UI events (any session) and the owner-only monitoring and backup endpoints. */
const fs = require('node:fs');
const { HttpError } = require('./http-error');
const { json } = require('./router');

function register(router, app) {
  router.post('/api/events', async (ctx) => json(202, app.uiEvents.record(ctx.user, await ctx.body())), {
    doc: 'Registra un evento de uso de la interfaz (page_view, report_view, help_opened) con la página opcional; máximo 60 por minuto por usuario.',
  });

  router.get('/api/ops/events', ({ query }) => json(200, app.ops.events(query)), {
    permission: 'view_ops', doc: 'Eventos de uso recientes. Filtros: name, from, to, limit.',
  });
  router.get('/api/ops/errors', ({ query }) => json(200, app.ops.errors(query)), {
    permission: 'view_ops', doc: 'Errores no controlados registrados por el servidor. Filtros: level, limit.',
  });
  router.get('/api/ops/metrics', () => json(200, app.ops.metrics()), {
    permission: 'view_ops', doc: 'Métricas: tiempo activo, solicitudes por clase de estado, latencia p50 y p95, tamaño de la base, sesiones y último respaldo.',
  });

  router.get('/api/ops/backups', () => json(200, { backups: app.backups.list(), keep: app.config.backupKeep, intervalHours: app.config.backupIntervalHours }), {
    permission: 'manage_backups', doc: 'Lista los respaldos guardados en el servidor, del más nuevo al más antiguo.',
  });
  router.post('/api/ops/backups', async ({ user }) => {
    try {
      const backup = await app.backups.run({ user, trigger: 'manual' });
      app.access.audit({ user, event: 'backup_created', result: 'executed', details: { name: backup.name } });
      return json(201, { backup });
    } catch {
      throw new HttpError(500, 'No se pudo crear el respaldo. El detalle quedó en el registro de errores.', 'backup_failed');
    }
  }, { permission: 'manage_backups', doc: 'Crea un respaldo ahora (copia consistente de la base con verificación de integridad).' });
  router.get('/api/ops/backups/:name/download', ({ params, res, user }) => {
    const file = app.backups.fileOf(params.name);
    const stat = fs.statSync(file);
    app.access.audit({ user, event: 'backup_downloaded', result: 'executed', details: { name: params.name } });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${params.name}"`,
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return { handled: true };
  }, { permission: 'manage_backups', doc: 'Descarga el archivo SQLite de un respaldo (la copia fuera del servidor).' });
}

module.exports = { register };
