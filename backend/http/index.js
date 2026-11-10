'use strict';
/** Builds the HTTP server: every area registers its routes on one small router. */
const http = require('node:http');
const { createRouter } = require('./router');
const { createDispatcher } = require('./dispatcher');

const AREAS = ['telemetry', 'auth', 'privacy', 'admin', 'operations', 'control', 'demo', 'value', 'ops'];

/** @returns {{router: object, server: import('http').Server}} */
function createHttpServer(app) {
  const router = createRouter();
  for (const area of AREAS) require(`./${area}`).register(router, app);
  const server = http.createServer(createDispatcher({ router, app }));
  return { router, server };
}

module.exports = { createHttpServer, AREAS };
