'use strict';
/**
 * Creates one demo user per role (demo-owner, demo-finance, ...). Passwords:
 *   VATIO_DEMO_PASSWORD_<ROLE>  password of one role (for example VATIO_DEMO_PASSWORD_FINANCE)
 *   VATIO_DEMO_PASSWORD         one password for every role
 *   otherwise a random password is generated and printed ONCE below (it is not stored in clear).
 * Passwords need at least 16 characters. Existing users are left untouched. In the production profile
 * the script refuses to run unless VATIO_ALLOW_DEMO_SEED=yes.
 *
 *   npm run seed:users
 */
require('../backend/runtime-guard').assertNodeVersion();
const { getConfigOrExit } = require('../backend/config');
const { openDatabase } = require('../backend/db/connection');
const { migrate } = require('../backend/db/migrate');
const { createRepositories } = require('../backend/db/repositories');
const { seedDemoUsers } = require('../backend/app/demo-users');

function main() {
  const config = getConfigOrExit();
  if (config.isProduction && process.env.VATIO_ALLOW_DEMO_SEED !== 'yes') {
    console.error('Los usuarios de demostración no se crean en producción.');
    console.error('Si de verdad los necesita, defina VATIO_ALLOW_DEMO_SEED=yes y vuelva a ejecutar este comando.');
    process.exit(2);
  }
  const db = openDatabase(config.dbPath);
  migrate(db);
  const { created, skipped } = seedDemoUsers({ repos: createRepositories(db), env: process.env });
  for (const name of skipped) console.log(`Ya existía: ${name}`);
  if (created.length) {
    console.log('Usuarios de demostración creados (anote las contraseñas generadas: no se vuelven a mostrar):');
    for (const u of created) console.log(` ${u.username.padEnd(28)} ${u.generated ? u.password : '(definida en el entorno)'}`);
  }
  console.log(` Base de datos: ${config.dbPath}`);
  db.close();
}
main();
