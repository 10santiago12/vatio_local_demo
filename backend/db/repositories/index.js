'use strict';
const { createReferenceRepositories } = require('./reference');
const { createMeasurementRepositories } = require('./measurement');
const { createOperationsRepositories } = require('./operations');

/**
 * Builds every repository over a migrated database. All SQL lives in this folder;
 * handlers and use-cases receive the plain-function repositories only.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function createRepositories(db) {
  return {
    ...createReferenceRepositories(db),
    ...createMeasurementRepositories(db),
    ...createOperationsRepositories(db)
  };
}

module.exports = { createRepositories };
