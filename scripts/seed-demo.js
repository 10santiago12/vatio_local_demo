'use strict';
/**
 * Seeds the database with the demo scenario: 3 sites, 11 loads with their modules, 45 days of history
 * (1-minute readings for the last 2 days, hourly aggregates before), the default tariff, investment and
 * emission factor, and two recommendations accepted more than 7 days ago. Idempotent: running it again
 * creates nothing new. It never creates users.
 *
 *   npm run seed:demo
 *   node scripts/seed-demo.js [--seed 20260311] [--now 2026-03-11T20:30:00Z]
 *
 * The database is VATIO_DB (default data/vatio.sqlite). In the production profile it refuses to run
 * unless VATIO_ALLOW_DEMO_SEED=yes is set explicitly: the server never seeds by itself.
 */

require('../backend/runtime-guard').assertNodeVersion();
const { getConfigOrExit } = require('../backend/config');
const { openDatabase } = require('../backend/db/connection');
const { migrate } = require('../backend/db/migrate');
const { createRepositories } = require('../backend/db/repositories');
const { SystemClock, SimulatedClock } = require('../backend/adapters/clock');
const { seedDemo } = require('../backend/app/demo-data');
const { DEFAULT_SEED } = require('../backend/adapters/simulator/scenario');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--seed') { options.seed = argv[i + 1]; i += 1; }
    else if (argv[i] === '--now') { options.now = argv[i + 1]; i += 1; }
    else throw new Error(`Opción desconocida: ${argv[i]}`);
  }
  return options;
}

function main() {
  const config = getConfigOrExit();
  if (config.isProduction && process.env.VATIO_ALLOW_DEMO_SEED !== 'yes') {
    console.error('Los datos de demostración no se cargan automáticamente en producción.');
    console.error('Si de verdad los necesita, defina VATIO_ALLOW_DEMO_SEED=yes y vuelva a ejecutar este comando.');
    process.exit(2);
  }
  const options = parseArgs(process.argv.slice(2));
  const seed = options.seed === undefined ? DEFAULT_SEED : (Number.isFinite(Number(options.seed)) ? Number(options.seed) : options.seed);
  const clock = options.now ? new SimulatedClock({ startMs: options.now, paused: true }) : new SystemClock();

  const started = process.hrtime.bigint();
  const db = openDatabase(config.dbPath);
  migrate(db);
  const result = seedDemo({ repos: createRepositories(db), db, clock, seed });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;

  if (result.skipped) console.log('Los datos de demostración ya estaban cargados: no se cambió nada.');
  else {
    console.log('Datos de demostración cargados.');
    console.log(` Sedes: ${result.sites.length} | cargas nuevas: ${result.loads} | módulos nuevos: ${result.modules}`);
    console.log(` Lecturas de 1 minuto: ${result.rawReadings} | agregados por hora: ${result.hourlyRows} | recomendaciones aceptadas: ${result.recommendations}`);
    console.log(` Fin del historial: ${result.anchor} (semilla ${result.seed})`);
  }
  console.log(` Base de datos: ${config.dbPath} | tiempo: ${seconds.toFixed(2)} s`);
  db.close();
}

main();
