'use strict';
/**
 * Avoided emissions for the ODS 7 impact report (RF-16, HU-11; calculation rule 9).
 *
 * Rule: kgCO2e avoided = kWh avoided * emission factor (kgCO2e/kWh, configurable per site).
 * Reduction % = kWh avoided / baseline kWh * 100. The report always carries the period, the
 * methodology text and the source of the factor so it can be audited. A negative avoided energy
 * (consumption above the baseline) is reported as it is: it is an increase, never hidden.
 */

const { round } = require('./stats');
const { formatNumber } = require('./text');
const { toIso } = require('./time');

/**
 * Avoided emissions and reduction against the baseline.
 * @param {{avoidedKwh: number, baselineKwh: number, factorKgPerKwh: number, factorSource?: string,
 *   periodStart: (string|number|Date), periodEnd: (string|number|Date)}} input
 * @returns {{avoidedKwh: number, baselineKwh: number, reductionPct: number, avoidedKgCo2e: number, factorKgPerKwh: number,
 *   factorSource: string, period: {start: string, end: string}, methodology: string}}
 * @throws {RangeError} when the factor is negative or not finite.
 */
function avoidedEmissions(input) {
  const { avoidedKwh, baselineKwh, factorKgPerKwh } = input;
  if (!Number.isFinite(factorKgPerKwh) || factorKgPerKwh < 0) throw new RangeError('The emission factor must be a number >= 0');
  const factorSource = input.factorSource && String(input.factorSource).trim() ? String(input.factorSource).trim() : 'Sin fuente indicada';
  const reductionPct = baselineKwh > 0 ? (avoidedKwh / baselineKwh) * 100 : 0;
  return {
    avoidedKwh,
    baselineKwh,
    reductionPct: round(reductionPct, 2),
    avoidedKgCo2e: avoidedKwh * factorKgPerKwh,
    factorKgPerKwh,
    factorSource,
    period: { start: toIso(input.periodStart), end: toIso(input.periodEnd) },
    methodology: `kgCO2e evitados = kWh evitados × factor de emisión (${formatNumber(factorKgPerKwh, 3)} kgCO2e por kWh; fuente: ${factorSource}). `
      + 'Los kWh evitados son la diferencia entre el consumo esperado según la línea base y el consumo real del periodo. '
      + 'El porcentaje de reducción compara los kWh evitados con el consumo de la línea base. Es una estimación: no incluye factores externos como el clima o el número de clientes.',
  };
}

module.exports = { avoidedEmissions };
