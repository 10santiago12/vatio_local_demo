'use strict';
/**
 * Site configuration defaults and the idempotent "make sure this site exists" use case.
 *
 * The defaults come from the spec ("DATOS DE DEMOSTRACIÓN"): tariff 950 COP/kWh flagged as an example,
 * system investment 1.800.000 COP and emission factor 0,126 kgCO2e/kWh with its source. Nothing here
 * creates users or readings. Running it again never overwrites what an administrator already changed:
 * the schedule, the first tariff and the settings are only written while still empty.
 */

const { localDateKey, addDays } = require('../domain/time');
const { MAIN_SITE_ID, MAIN_SCHEDULE } = require('../adapters/simulator/profiles');

const DEFAULT_TARIFF_COP_PER_KWH = 950;
const TARIFF_NOTE = 'Tarifa de ejemplo: reemplácela por la de su factura.';
const DEFAULT_INVESTMENT_COP = 1800000;
const DEFAULT_EMISSION_FACTOR = 0.126;
const EMISSION_FACTOR_SOURCE = 'Valor ilustrativo configurable: reemplácelo por el factor oficial de su operador.';
const MAIN_SITE = Object.freeze({ id: MAIN_SITE_ID, name: 'Panadería La Espiga – Chía', city: 'Chía' });

/**
 * @param {{repos: object, clock: {now: function(): number}, site: {id: string, name: string, city?: string}, schedule: Array,
 *   tariffFrom?: string, copPerKwh?: number, investmentCop?: number}} input
 *   `tariffFrom` is the first day the tariff applies to (default: 45 days before now, so the whole demo history is priced).
 * @returns {{created: boolean}}
 */
function ensureSite(input) {
  const { repos, site } = input;
  const nowIso = new Date(input.clock.now()).toISOString();
  const created = !repos.sites.get(site.id);
  if (created) repos.sites.create({ id: site.id, name: site.name, city: site.city ?? null });
  if (repos.sites.getSchedule(site.id).length === 0) {
    for (const entry of input.schedule) repos.sites.setSchedule(site.id, entry.weekday, { closed: entry.closed, opensAt: entry.opensAt, closesAt: entry.closesAt });
  }
  if (repos.tariffs.list(site.id).length === 0) {
    const effectiveFrom = input.tariffFrom || addDays(localDateKey(input.clock.now()), -45);
    repos.tariffs.create({ siteId: site.id, copPerKwh: input.copPerKwh ?? DEFAULT_TARIFF_COP_PER_KWH, effectiveFrom, note: TARIFF_NOTE });
  }
  const settings = repos.settings.get(site.id);
  if (settings.updated_by === null && settings.investment_cop === 0) {
    repos.settings.update(site.id, {
      investment_cop: input.investmentCop ?? DEFAULT_INVESTMENT_COP,
      emission_factor_kg_per_kwh: DEFAULT_EMISSION_FACTOR,
      emission_factor_source: EMISSION_FACTOR_SOURCE,
    }, { at: nowIso });
  }
  return { created };
}

/** The main site of the product (Panadería La Espiga - Chía) with its default configuration. */
function ensureMainSite({ repos, clock }) {
  return ensureSite({ repos, clock, site: MAIN_SITE, schedule: MAIN_SCHEDULE });
}

module.exports = {
  ensureSite, ensureMainSite, MAIN_SITE, DEFAULT_TARIFF_COP_PER_KWH, TARIFF_NOTE, DEFAULT_INVESTMENT_COP, DEFAULT_EMISSION_FACTOR, EMISSION_FACTOR_SOURCE,
};
