'use strict';
/** Value screens: savings and return, attributable savings, reports, multisite comparison and raw data. */
const { badRequest } = require('./http-error');
const { json, file } = require('./router');
const { monthlyCsv, monthlyPdf, impactPdf } = require('../app/report-render');

function register(router, app) {
  const { siteId, value } = app;
  const formatOf = (query, allowed) => {
    const format = (query.format || allowed[0]).toLowerCase();
    if (!allowed.includes(format)) throw badRequest(`El formato debe ser: ${allowed.join(', ')}.`, 'invalid_format');
    return format;
  };
  const audit = (user, event, details) => app.access.audit({ user, event, siteId, result: 'executed', details });

  router.get('/api/savings', () => json(200, value.savings(siteId)), {
    permission: 'view_savings', doc: 'Ahorro acumulado (kWh y COP), inversión usada, retorno con rango mínimo-máximo (o "Retorno no estimable"), serie semanal real vs línea base y ahorro acumulado vs inversión.',
  });
  router.get('/api/savings/attributable', () => json(200, value.attributable(siteId)), {
    permission: 'view_savings', doc: 'Ahorro atribuible a cada recomendación aceptada: conclusivo, "No concluyente" o "En medición (día N de 7)", con aviso de estimación.',
  });
  router.get('/api/reports/monthly', ({ query }) => json(200, value.monthlyReport(siteId, query.month)), {
    permission: 'view_reports', doc: 'Reporte mensual (JSON). Parámetro: month (AAAA-MM, por defecto el mes actual); solo cuenta días completos.',
  });
  router.get('/api/reports/monthly/download', ({ query, user }) => {
    const format = formatOf(query, ['csv', 'pdf']);
    const report = value.monthlyReport(siteId, query.month);
    audit(user, 'report_downloaded', { report: 'monthly', month: report.month, format });
    const name = `vatio-reporte-${report.month}.${format}`;
    return format === 'csv' ? file(monthlyCsv(report), 'text/csv; charset=utf-8', name) : file(monthlyPdf(report), 'application/pdf', name);
  }, { permission: 'download_report', doc: 'Descarga el reporte mensual en CSV o PDF con los mismos valores del JSON. Parámetros: month, format (csv, pdf).' });

  router.get('/api/reports/impact', ({ query }) => json(200, value.impactReport(siteId, query)), {
    permission: 'view_impact_report', doc: 'Reporte de impacto ODS 7: kWh evitados, % de reducción, kgCO2e evitados, periodo, metodología y fuente del factor. Parámetros: from, to (AAAA-MM-DD).',
  });
  router.get('/api/reports/impact/download', ({ query, user }) => {
    const format = formatOf(query, ['pdf', 'json']);
    const report = value.impactReport(siteId, query);
    audit(user, 'report_downloaded', { report: 'impact', from: report.period.from, to: report.period.to, format });
    const name = `vatio-ods7-${report.period.from}-a-${report.period.to}.${format}`;
    return format === 'pdf' ? file(impactPdf(report), 'application/pdf', name) : file(JSON.stringify(report, null, 2), 'application/json; charset=utf-8', name);
  }, { permission: 'download_impact_report', doc: 'Descarga el reporte ODS 7 en PDF o JSON. Parámetros: from, to, format (pdf, json).' });

  router.get('/api/data/readings', ({ query }) => json(200, app.data.view(query)), {
    permission: 'view_raw_data', doc: 'Vista de datos crudos (JSON). Filtros: site, load, from, to (AAAA-MM-DD o instante ISO), granularity (raw, hourly), limit (hasta 5000).',
  });
  router.get('/api/data/export', ({ query, user }) => {
    const out = app.data.export(query, user);
    return file(out.body, out.contentType, out.name);
  }, { permission: 'export_raw_data', doc: 'Exporta los datos crudos en CSV o JSON. Filtros: site, load, from, to, granularity (raw, hourly), format (csv, json), limit.' });
  router.post('/api/data/import', async (ctx) => json(200, app.data.import(await ctx.body(), ctx.user)), {
    permission: 'import_raw_data', doc: 'Reimporta lecturas crudas (format csv o json, content o rows) y verifica cada fila contra la base de datos: informa cuántas se conservaron (100 % esperado).',
  });

  router.get('/api/multisite', ({ query }) => json(200, value.multisite(siteId, query)), {
    permission: 'view_multisite', doc: 'Comparativo de sedes normalizado por día de operación, con la mayor reducción resaltada. Filtro: days (7 a 45).',
  });
}

module.exports = { register };
