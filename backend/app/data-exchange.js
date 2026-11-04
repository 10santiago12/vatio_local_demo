'use strict';
/**
 * Raw data for the data analyst (RF-17): filtered export as CSV or JSON, and re-import with a
 * verification report. After an import every accepted row is read back from the database and compared
 * field by field with the file, so "100 % preserved" is measured, not assumed.
 *
 * Export columns are the same in CSV and JSON, so a file exported by the system is accepted back as it is:
 *   site_id, load_code, ts, power_w, voltage_v, current_a, energy_kwh, module_id, source
 */
const { localDayStartMs, addDays } = require('../domain/time');
const { round } = require('../domain/stats');
const { badRequest, notFound } = require('../http/http-error');
const { csvLine } = require('./report-render');

const RAW_COLUMNS = Object.freeze(['site_id', 'load_code', 'ts', 'power_w', 'voltage_v', 'current_a', 'energy_kwh', 'module_id', 'source']);
const HOURLY_COLUMNS = Object.freeze(['site_id', 'load_code', 'hour_start', 'avg_power_w', 'max_power_w', 'energy_kwh', 'samples']);
const SOURCES = ['simulator', 'esp32', 'import'];
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXPORT_ROWS = 500000;
const MAX_IMPORT_ROWS = 50000;
const MAX_INVALID_SAMPLES = 10;

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF or LF). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

const numberOrNull = (value) => (value === '' || value === undefined || value === null ? null : Number(value));
const same = (a, b) => (a === null || a === undefined ? b === null || b === undefined : a === b);

/** @param {{repos: object, clock: {now: function(): number}, access: object, analytics: object}} deps */
function createDataExchange({ repos, clock, access, analytics }) {
  function bound(value, field, exclusiveEnd) {
    if (value === undefined || value === '') return undefined;
    if (DATE_KEY.test(value) && !Number.isNaN(Date.parse(value))) return new Date(localDayStartMs(exclusiveEnd ? addDays(value, 1) : value)).toISOString();
    if (!Number.isNaN(Date.parse(value)) && /T/.test(value)) return new Date(value).toISOString();
    throw badRequest(`El filtro "${field}" debe ser una fecha AAAA-MM-DD o un instante ISO.`, 'invalid_filter');
  }

  function filters(query) {
    if (query.site && !repos.sites.get(query.site)) throw notFound('No existe esa sede.', 'site_not_found');
    const granularity = query.granularity || 'raw';
    if (!['raw', 'hourly'].includes(granularity)) throw badRequest('La granularidad debe ser raw o hourly.', 'invalid_filter');
    return {
      siteId: query.site || null, loadCode: query.load || null, from: bound(query.from, 'from', false), to: bound(query.to, 'to', true), granularity,
    };
  }

  function fetchRows(f, limit) {
    const args = { siteId: f.siteId, loadCode: f.loadCode, from: f.from, to: f.to, limit };
    return f.granularity === 'hourly' ? repos.readings.exportHourly(args) : repos.readings.exportRaw(args);
  }
  const columnsOf = (f) => (f.granularity === 'hourly' ? HOURLY_COLUMNS : RAW_COLUMNS);

  function resolveLimit(value, fallback, max) {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`El límite debe ser un entero entre 1 y ${max}.`, 'invalid_limit');
    return n;
  }

  return {
    RAW_COLUMNS,

    /** JSON preview of raw data (screen "Datos crudos"). */
    view(query) {
      const f = filters(query);
      const limit = resolveLimit(query.limit, 200, 5000);
      const rows = fetchRows(f, limit);
      return { granularity: f.granularity, count: rows.length, limit, columns: columnsOf(f), rows };
    },

    /** Export as CSV or JSON; audited with the filters used. */
    export(query, user) {
      const f = filters(query);
      const format = (query.format || 'csv').toLowerCase();
      if (!['csv', 'json'].includes(format)) throw badRequest('El formato debe ser csv o json.', 'invalid_format');
      const limit = resolveLimit(query.limit, MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);
      const rows = fetchRows(f, limit + 1);
      const truncated = rows.length > limit;
      if (truncated) rows.pop();
      const columns = columnsOf(f);
      access.audit({
        user, event: 'data_exported', result: 'executed',
        details: { format, granularity: f.granularity, count: rows.length, truncated, site: f.siteId, load: f.loadCode, from: f.from ?? null, to: f.to ?? null },
      });
      const stamp = new Date(clock.now()).toISOString().slice(0, 10);
      const name = `vatio-datos-${f.granularity}-${stamp}.${format}`;
      if (format === 'json') {
        return { name, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ granularity: f.granularity, count: rows.length, truncated, columns, rows }) };
      }
      const lines = [csvLine(columns), ...rows.map((r) => csvLine(columns.map((c) => r[c])))];
      return { name, contentType: 'text/csv; charset=utf-8', body: `${lines.join('\r\n')}\r\n` };
    },

    /**
     * Imports raw readings and verifies them against the database.
     * @param {{format: 'csv'|'json', content?: string, rows?: Array}} input
     */
    import(input, user) {
      const format = String(input.format || '').toLowerCase();
      if (!['csv', 'json'].includes(format)) throw badRequest('El formato debe ser csv o json.', 'invalid_format');
      let records;
      if (format === 'json') {
        let parsed = input.rows;
        if (parsed === undefined) {
          try { parsed = JSON.parse(String(input.content ?? '')); } catch { throw badRequest('El archivo JSON no es válido.', 'invalid_file'); }
        }
        records = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.rows) ? parsed.rows : null;
        if (!records) throw badRequest('El archivo JSON debe contener una lista de lecturas (o un objeto con "rows").', 'invalid_file');
      } else {
        const table = parseCsv(String(input.content ?? ''));
        if (!table.length) throw badRequest('El archivo CSV está vacío.', 'invalid_file');
        const header = table[0].map((h) => h.trim());
        const missing = RAW_COLUMNS.filter((c) => !header.includes(c) && !['module_id', 'source', 'voltage_v', 'current_a', 'energy_kwh'].includes(c));
        if (missing.length) throw badRequest(`Al archivo le faltan columnas: ${missing.join(', ')}.`, 'invalid_file');
        records = table.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
      }
      if (records.length > MAX_IMPORT_ROWS) throw badRequest(`El archivo tiene demasiadas filas: el máximo es ${MAX_IMPORT_ROWS}.`, 'file_too_large');

      const invalid = [];
      const valid = [];
      const loads = new Map();
      const loadOf = (siteId, code) => {
        const key = `${siteId}|${code}`;
        if (!loads.has(key)) loads.set(key, repos.sites.get(siteId) ? repos.loads.getByCode(siteId, code) : null);
        return loads.get(key);
      };
      records.forEach((r, index) => {
        const reject = (reason) => invalid.push({ row: index + 1, reason });
        if (!r || typeof r !== 'object') return reject('La fila no es un registro.');
        const load = loadOf(r.site_id, r.load_code);
        if (!load) return reject('El equipo o la sede no existen.');
        if (typeof r.ts !== 'string' || Number.isNaN(Date.parse(r.ts)) || new Date(r.ts).toISOString() !== r.ts) return reject('La fecha debe ser un instante ISO en UTC, por ejemplo 2026-03-01T14:05:00.000Z.');
        const powerW = numberOrNull(r.power_w);
        const voltageV = numberOrNull(r.voltage_v);
        const currentA = numberOrNull(r.current_a);
        const energyKwh = numberOrNull(r.energy_kwh);
        if (powerW === null || !Number.isFinite(powerW) || powerW < 0) return reject('La potencia debe ser un número mayor o igual a 0.');
        for (const v of [voltageV, currentA, energyKwh]) if (v !== null && (!Number.isFinite(v) || v < 0)) return reject('Voltaje, corriente y energía deben ser números mayores o iguales a 0.');
        const moduleId = r.module_id === '' || r.module_id === undefined ? null : r.module_id;
        if (moduleId !== null && !repos.modules.get(moduleId)) return reject('El módulo indicado no existe.');
        const source = r.source === '' || r.source === undefined ? 'import' : r.source;
        if (!SOURCES.includes(source)) return reject('La fuente debe ser simulator, esp32 o import.');
        valid.push({ loadId: load.id, ts: r.ts, powerW, voltageV, currentA, energyKwh, moduleId, source });
      });

      const inserted = valid.length ? repos.readings.insertMany(valid) : 0;
      // Read every accepted row back and compare it with the file.
      const byLoad = new Map();
      for (const row of valid) {
        const list = byLoad.get(row.loadId) || [];
        list.push(row);
        byLoad.set(row.loadId, list);
      }
      let verified = 0;
      for (const [loadId, list] of byLoad) {
        const sorted = list.map((r) => r.ts).sort();
        const stored = new Map(repos.readings.range(loadId, sorted[0], new Date(Date.parse(sorted[sorted.length - 1]) + 1).toISOString()).map((s) => [s.ts, s]));
        for (const row of list) {
          const s = stored.get(row.ts);
          if (s && s.power_w === row.powerW && same(s.voltage_v, row.voltageV) && same(s.current_a, row.currentA) && same(s.energy_kwh, row.energyKwh)
            && same(s.module_id, row.moduleId) && s.source === row.source) verified += 1;
        }
      }
      if (inserted) analytics.invalidate();
      const result = {
        received: records.length, valid: valid.length, invalid: invalid.length, invalidSamples: invalid.slice(0, MAX_INVALID_SAMPLES),
        inserted, duplicates: valid.length - inserted, conflicts: valid.length - verified, verified,
        preservedPct: valid.length ? round((verified / valid.length) * 100, 2) : null,
      };
      result.message = valid.length === 0
        ? 'No se importó nada: ninguna fila era válida.'
        : `Se verificaron ${verified} de ${valid.length} filas válidas (${result.preservedPct} % conservado). Nuevas: ${inserted}; ya existían: ${result.duplicates}; con error: ${invalid.length}.`;
      access.audit({ user, event: 'data_imported', result: 'executed', details: { format, ...result, invalidSamples: undefined } });
      return result;
    },
  };
}

module.exports = { createDataExchange, parseCsv };
