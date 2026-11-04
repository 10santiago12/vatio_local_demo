'use strict';
/**
 * Composition root: builds the application (repositories, clock, use cases) from a configuration and
 * an open database. `server.js` runs it with the real process; tests build it in-process with a
 * temporary database.
 *
 * Time: the clock is a holder so demo mode can swap the real clock for the simulated one. Demo mode
 * is on when the Demo Panel is enabled AND the database was seeded: the simulated clock then starts
 * where the seeded history ends (or after the last stored reading) and the simulated modules keep
 * producing readings through the same ingestion use case as real devices.
 */
const { migrate } = require('./db/migrate');
const { createRepositories } = require('./db/repositories');
const { SystemClock, SimulatedClock } = require('./adapters/clock');
const { MAIN_SITE_ID } = require('./adapters/simulator/profiles');
const { createIngestion } = require('./app/ingestion');
const { ensureMainSite } = require('./app/site-setup');
const { loadDemoScenario } = require('./app/demo-data');
const { hashPassword } = require('./app/passwords');
const { createAccess } = require('./app/access');
const { createAuth } = require('./app/auth');
const { createUserAdmin } = require('./app/users');
const { createSettingsService } = require('./app/settings');
const { createAnalytics } = require('./app/analytics');
const { createControl } = require('./app/control');
const { createRecommendations } = require('./app/recommendations');
const { createAlerts } = require('./app/alerts');
const { createOperations } = require('./app/operations');
const { createModules } = require('./app/modules');
const { createDemo } = require('./app/demo');
const { createValue } = require('./app/value');

/** Clock port whose implementation can be swapped (system <-> simulated). */
function createClockHolder(initial) {
  let current = initial;
  return {
    now: () => current.now(),
    nowIso: () => current.nowIso(),
    state: () => current.state(),
    get current() { return current; },
    use(next) { current = next; },
  };
}

/**
 * @param {{config: object, db: object, wallNow?: function(): number, onError?: function(string, Error): void}} input
 */
function createRuntime({ config, db, wallNow = Date.now }) {
  migrate(db);
  const repos = createRepositories(db);
  const clock = createClockHolder(new SystemClock());
  const siteId = MAIN_SITE_ID;

  function logError(source, error, context) {
    try {
      repos.errors.log({ at: new Date(clock.now()).toISOString(), source, message: error.message, stack: error.stack, context });
    } catch { /* the error log itself failed */ }
    if (!config.quiet) console.error(`${source}: ${error.message}`);
  }

  // Bootstrap administrator (password from the environment, never a default).
  if (!repos.users.getByUsername('admin') && config.adminPassword) {
    const { salt, hash } = hashPassword(config.adminPassword);
    repos.users.create({ username: 'admin', salt, hash, role: 'owner', displayName: 'Administrador' });
  }

  // Demo mode: simulated clock resumed where the seeded history ends.
  const seededEvent = repos.events.list({ name: 'demo_seeded', limit: 1 })[0];
  let demoMode = false;
  if (config.demoPanelEnabled && seededEvent) {
    const anchorMs = Date.parse(JSON.parse(seededEvent.properties).anchor);
    const lastTs = repos.loads.listBySite(siteId).map((l) => repos.readings.latest(l.id)).filter(Boolean).map((r) => Date.parse(r.ts));
    clock.use(new SimulatedClock({ startMs: Math.max(anchorMs, ...lastTs), realNow: wallNow }));
    demoMode = true;
  }
  ensureMainSite({ repos, clock });

  const ingestion = createIngestion({ repos, clock, options: { autoRegister: !config.isProduction } });
  const state = { scenario: loadDemoScenario({ repos, clock }), demoMode };
  const access = createAccess({ repos, clock });
  const auth = createAuth({ repos, access, wallNow });
  const analytics = createAnalytics({ repos, clock });
  const users = createUserAdmin({ repos, access, auth });
  const settings = createSettingsService({ repos, access, clock, onChange: () => analytics.invalidate() });

  const control = createControl({ repos, clock, access, analytics });
  const recommendations = createRecommendations({ repos, clock, analytics, access, control });
  const alerts = createAlerts({ repos, clock, analytics, access });
  const operations = createOperations({ repos, clock, analytics, recommendations });
  const value = createValue({ repos, clock, analytics });
  const app = {
    config, db, repos, clock, siteId, wallNow, state, logError,
    ingestion, access, auth, analytics, users, settings, control, recommendations, alerts, operations, value,
    scenario: () => state.scenario,
    close() { db.close(); },
  };
  const demoDeps = { repos, db, clock, state, config, wallNow, siteId, ingestion, analytics, alerts, control, recommendations, access, logError };
  app.demo = createDemo(demoDeps);
  app.modules = createModules({ repos, clock, access, onRegistered: (info) => app.demo.onModuleRegistered(info) });
  return app;
}

module.exports = { createRuntime, createClockHolder };
