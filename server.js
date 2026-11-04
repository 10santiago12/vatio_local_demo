require('./backend/runtime-guard').assertNodeVersion();

const config = require('./backend/config').getConfigOrExit();
const { openDatabase } = require('./backend/db/connection');
const { createRuntime } = require('./backend/runtime');
const { createHttpServer } = require('./backend/http');
const { localIPv4Addresses } = require('./backend/http/telemetry');

const app = createRuntime({ config, db: openDatabase(config.dbPath) });
const { server } = createHttpServer(app);

// Periodic work: simulated modules (demo mode), module statuses, alert detectors, safe-state rule and
// recommendations; raw readings older than 2 days are folded into hourly aggregates.
function runSafely(task, name) {
  try { task(); } catch (error) { app.logError(name, error); }
}
setInterval(() => runSafely(() => app.demo.runJobs(), 'jobs'), app.state.demoMode ? 1000 : 30 * 1000).unref();
setInterval(() => runSafely(() => app.ingestion.compact(), 'readings-compaction'), 60 * 60 * 1000).unref();

// Anything that escapes a handler is recorded in error_log before the process decides what to do.
process.on('unhandledRejection', (reason) => app.logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))));
process.on('uncaughtException', (error) => { app.logError('uncaughtException', error); process.exit(1); });

app.backups.start();

server.listen(config.port, config.host, () => {
  const ips = localIPv4Addresses();
  console.log('');
  console.log('======================================================');
  console.log(' Vatio Local está ejecutándose');
  console.log('======================================================');
  console.log(` Navegador en este PC: http://localhost:${config.port}`);
  for (const ip of ips) {
    console.log(` Red local:             http://${ip}:${config.port}`);
    console.log(` ESP32 POST:            http://${ip}:${config.port}/api/telemetry`);
  }
  console.log(` Perfil: ${config.appEnv} | Host: ${config.host}`);
  console.log(` Clave de dispositivo configurada: ${Boolean(config.deviceKey)}`);
  console.log('======================================================');
  console.log('');
  console.log('Si el ESP32 no puede conectarse, revisa el Firewall de Windows');
  console.log(`y permite conexiones TCP entrantes al puerto ${config.port}.`);
  console.log('');
});
