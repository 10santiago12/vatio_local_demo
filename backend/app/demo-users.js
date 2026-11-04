'use strict';
/**
 * Demo users: one account per role, for presentations and tests. Passwords come from the environment
 * (`VATIO_DEMO_PASSWORD` for all, or `VATIO_DEMO_PASSWORD_<ROLE>` per role) or are generated; generated
 * ones are returned once so the script can print them. Existing users are never touched.
 */
const crypto = require('node:crypto');
const { ROLES } = require('../domain/constants');
const { hashPassword, passwordProblem } = require('./passwords');

/** Username of the demo account of a role, e.g. `demo-finance`. */
const demoUsername = (role) => `demo-${role.replace(/_/g, '-')}`;

function generatePassword() {
  return crypto.randomBytes(14).toString('base64url');
}

/**
 * @param {{repos: object, env?: Object<string, string>}} input
 * @returns {{created: Array<{username: string, role: string, password: string, generated: boolean}>, skipped: string[]}}
 */
function seedDemoUsers({ repos, env = {} }) {
  const created = [];
  const skipped = [];
  for (const role of Object.keys(ROLES)) {
    const username = demoUsername(role);
    if (repos.users.getByUsername(username)) { skipped.push(username); continue; }
    const fromEnv = env[`VATIO_DEMO_PASSWORD_${role.toUpperCase()}`] || env.VATIO_DEMO_PASSWORD || '';
    const password = fromEnv || generatePassword();
    const problem = passwordProblem(password);
    if (problem) throw new Error(`${username}: ${problem}`);
    const { salt, hash } = hashPassword(password);
    repos.users.create({ username, salt, hash, role, displayName: ROLES[role] });
    created.push({ username, role, password, generated: !fromEnv });
  }
  return { created, skipped };
}

module.exports = { seedDemoUsers, demoUsername };
