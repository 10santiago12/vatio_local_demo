'use strict';
/** Value screens: savings and return, attributable savings, reports, multisite comparison and raw data. */
const { json } = require('./router');

function register(router, app) {
  const { siteId, value } = app;

  router.get('/api/savings', () => json(200, value.savings(siteId)), {
    permission: 'view_savings', doc: 'Ahorro acumulado (kWh y COP), inversión usada, retorno con rango mínimo-máximo (o "Retorno no estimable"), serie semanal real vs línea base y ahorro acumulado vs inversión.',
  });
  router.get('/api/savings/attributable', () => json(200, value.attributable(siteId)), {
    permission: 'view_savings', doc: 'Ahorro atribuible a cada recomendación aceptada: conclusivo, "No concluyente" o "En medición (día N de 7)", con aviso de estimación.',
  });
  router.get('/api/multisite', ({ query }) => json(200, value.multisite(siteId, query)), {
    permission: 'view_multisite', doc: 'Comparativo de sedes normalizado por día de operación, con la mayor reducción resaltada. Filtro: days (7 a 45).',
  });
}

module.exports = { register };
