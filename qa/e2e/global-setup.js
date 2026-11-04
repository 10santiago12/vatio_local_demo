'use strict';
const { startServer, login } = require('../lib/server');

// Starts a throwaway server and exposes its URL and credentials to the workers through the environment.
module.exports = async () => {
  const server = await startServer({ port: 31903, seed: true });
  const session = await login(server.baseUrl, server.adminPassword);
  process.env.QA_BASE_URL = server.baseUrl;
  process.env.QA_ADMIN_PASSWORD = server.adminPassword;
  process.env.QA_SESSION_COOKIE = session.cookie;
  globalThis.__vatioServer = server;
};
