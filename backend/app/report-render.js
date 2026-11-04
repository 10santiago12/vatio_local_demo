'use strict';
/**
 * Renders the report objects built by `value.js` as CSV and PDF. Nothing is recalculated here: the files
 * print exactly the values of the JSON report (CSV with plain numbers, PDF with Colombian formatting), so
 * the three versions can never disagree.
 */
const { buildPdf } = require('./pdf');
const { formatCop, formatNumber } = require('../domain/text');

/** One CSV field: quoted only when needed (comma, quote or line break). */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const csvLine = (values) => values.map(csvField).join(',');

const kwh = (value) => `${formatNumber(value, 2)} kWh`;
const pct = (value) => `${formatNumber(value, 2)} %`;
const paybackText = (summary) => (summary.paybackStatus === 'estimated' ? `${formatNumber(summary.paybackMonths, 1)} meses` : 'Retorno no estimable');

/** Monthly report as CSV: a `total` row followed by one row per load. */
function monthlyCsv(report) {
  const s = report.summary;
  const rows = [
    csvLine(['section', 'code', 'name', 'consumption_kwh', 'consumption_cost_cop', 'baseline_kwh', 'savings_kwh', 'savings_cop']),
    csvLine(['total', '', report.siteName, s.consumptionKwh, s.consumptionCostCop, s.baselineKwh, s.savingsKwh, s.savingsCop]),
    ...report.loads.map((l) => csvLine(['load', l.code, l.name, l.consumptionKwh, l.consumptionCostCop, l.baselineKwh, l.savingsKwh, l.savingsCop])),
  ];
  return `${rows.join('\r\n')}\r\n`;
}

/** Monthly report as PDF. */
function monthlyPdf(report) {
  const s = report.summary;
  const lines = [
    { text: `Reporte mensual de energía - ${report.siteName}`, bold: true, size: 16 },
    `Mes: ${report.month}${report.period.partial ? ' (parcial: solo días completos)' : ''}`,
    `Periodo analizado: ${report.period.from} a ${report.period.to} (${report.period.days} días)`,
    `Generado: ${report.generatedAt}`,
    { text: 'Resumen', bold: true, size: 12, gap: 10 },
    `Consumo: ${kwh(s.consumptionKwh)}`,
    `Costo del consumo: ${formatCop(s.consumptionCostCop)}`,
    `Consumo esperado según la línea base: ${kwh(s.baselineKwh)}`,
    `Ahorro del periodo: ${kwh(s.savingsKwh)}`,
    `Ahorro en pesos: ${formatCop(s.savingsCop)}`,
    `Inversión: ${formatCop(s.investmentCop)}`,
    `Retorno de la inversión: ${paybackText(s)}`,
    { text: 'Equipos', bold: true, size: 12, gap: 10 },
    ...report.loads.map((l) => `${l.name} (${l.code}): consumo ${kwh(l.consumptionKwh)}, costo ${formatCop(l.consumptionCostCop)}, línea base ${kwh(l.baselineKwh)}, ahorro ${kwh(l.savingsKwh)} (${formatCop(l.savingsCop)})`),
  ];
  if (report.recommendations.length) {
    lines.push({ text: 'Recomendaciones aceptadas', bold: true, size: 12, gap: 10 });
    for (const r of report.recommendations) {
      lines.push(`${r.title} (${r.loadName}): ${r.label}${r.savingsKwh !== null ? `, ${kwh(r.savingsKwh)} (${formatCop(r.savingsCop)})` : ''}`);
    }
  }
  lines.push({ text: report.note, gap: 10, size: 9 });
  return buildPdf({ title: `Reporte mensual ${report.month}`, lines });
}

/** ODS 7 impact report as PDF. */
function impactPdf(report) {
  const lines = [
    { text: `Reporte de impacto ODS 7 - ${report.siteName}`, bold: true, size: 16 },
    'ODS 7: energía asequible y no contaminante',
    `Periodo: ${report.period.from} a ${report.period.to} (${report.period.days} días)`,
    `Generado: ${report.generatedAt}`,
    { text: 'Resultados', bold: true, size: 12, gap: 10 },
    `Energía evitada: ${kwh(report.avoidedKwh)}`,
    `Consumo de la línea base: ${kwh(report.baselineKwh)}`,
    `Consumo real: ${kwh(report.actualKwh)}`,
    `Reducción: ${pct(report.reductionPct)}`,
    `Emisiones evitadas: ${formatNumber(report.avoidedKgCo2e, 2)} kgCO2e`,
    `Factor de emisión: ${formatNumber(report.emissionFactorKgPerKwh, 3)} kgCO2e por kWh`,
    `Fuente del factor: ${report.emissionFactorSource}`,
    { text: 'Metodología', bold: true, size: 12, gap: 10 },
    report.methodology,
  ];
  return buildPdf({ title: `Reporte ODS 7 ${report.period.from} a ${report.period.to}`, lines });
}

module.exports = { monthlyCsv, monthlyPdf, impactPdf, csvLine, csvField };
