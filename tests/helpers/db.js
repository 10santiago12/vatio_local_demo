'use strict';
// Test-only builders: a migrated in-memory database with repositories and a controllable clock.
const { openDatabase } = require('../../backend/db/connection');
const { migrate } = require('../../backend/db/migrate');
const { createRepositories } = require('../../backend/db/repositories');
const { SimulatedClock } = require('../../backend/adapters/clock');
const { ensureMainSite } = require('../../backend/app/site-setup');

// Wednesday 2026-03-11 15:30 in Bogota (UTC-5).
const ANCHOR_ISO = '2026-03-11T20:30:00.000Z';
const ANCHOR = Date.parse(ANCHOR_ISO);

/** A clock frozen at `startMs` (no real time involved); move it with advance(). */
function frozenClock(startMs = ANCHOR) {
  return new SimulatedClock({ startMs, paused: true, realNow: () => 0 });
}

/** @param {{file?: string, mainSite?: boolean, clock?: object}} [options] */
function createTestEnv(options = {}) {
  const db = openDatabase(options.file || ':memory:');
  migrate(db);
  const repos = createRepositories(db);
  const clock = options.clock || frozenClock();
  if (options.mainSite !== false) ensureMainSite({ repos, clock });
  return { db, repos, clock };
}

module.exports = { createTestEnv, frozenClock, ANCHOR, ANCHOR_ISO };
