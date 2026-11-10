'use strict';

const { json } = require('./router');
const { presentUser } = require('../app/users');

function register(router, app) {
  router.get('/api/public/contact', () => json(200, {
    feedbackUrl: app.config.feedbackUrl,
    pqrEmail: app.config.pqrEmail,
  }), { public: true, doc: 'Canales públicos configurados de sugerencias y PQR.' });

  router.get('/api/me/personal-data', ({ user }) => {
    const account = presentUser(app.repos.users.getById(user.userId));
    const consents = app.repos.consents.list(user.userId);
    const sites = app.repos.users.sitesFor(user.userId).map(({ id, name }) => ({ id, name }));
    // Select fields individually so internal details cannot disclose information about another user.
    const audit = app.repos.audit.list({ userId: user.userId, limit: 100 })
      .map(({ at, event, role, result }) => ({ at, event, role, result }));
    const events = app.repos.events.list({ userId: user.userId, limit: 100 })
      .map(({ at, name }) => ({ at, name }));
    app.access.audit({ user, event: 'personal_data_accessed', result: 'executed', details: {} });
    return json(200, { account, consents, sites, activity: { audit, events } });
  }, { doc: 'Consulta los datos de cuenta y las autorizaciones del titular autenticado y audita el acceso.' });
}

module.exports = { register };
