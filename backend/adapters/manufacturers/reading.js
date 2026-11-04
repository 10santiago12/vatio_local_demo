'use strict';
/**
 * Common Reading model (RNF-03) and the helpers every manufacturer adapter shares.
 *
 * Whatever a module speaks on the wire, the application only ever sees:
 *
 *   {moduleId, loadCode, loadName, manufacturer, ts, powerW, voltageV, currentA, energyKwh, status}
 *
 * - `ts` is an ISO-8601 UTC string, or null when the device does not stamp its readings (the server
 *   then uses the reception time);
 * - `energyKwh` is the cumulative counter of the module in kWh;
 * - `status` is one of the module statuses of the schema: active, inactive, error;
 * - `loadCode` / `loadName` are optional hints; the module registry is the source of truth.
 *
 * Adapters validate the TYPES of what they read (finite numbers, strings) and convert units. Business
 * ranges and time windows are checked by the ingestion use case.
 */

class ReadingFormatError extends Error {
  /**
   * @param {string} message Plain description of what is wrong.
   * @param {string} [field] Wire field that caused it.
   */
  constructor(message, field) {
    super(message);
    this.name = 'ReadingFormatError';
    this.field = field || null;
  }
}

/** Reads a finite number from a wire field. Strings are NOT coerced: "12" is a format error. */
function finiteNumber(value, field, { optional = false, fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw new ReadingFormatError(`Falta el campo ${field}.`, field);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ReadingFormatError(`El campo ${field} debe ser un número finito.`, field);
  return value;
}

function text(value, field, { optional = false, max = 120 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw new ReadingFormatError(`Falta el campo ${field}.`, field);
  }
  if (typeof value !== 'string' || value.length > max) throw new ReadingFormatError(`El campo ${field} debe ser un texto de máximo ${max} caracteres.`, field);
  return value;
}

/** ISO-8601 string from a wire timestamp (ISO text or epoch seconds); null when absent and optional. */
function instant(value, field, { optional = true, epochSeconds = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw new ReadingFormatError(`Falta el campo ${field}.`, field);
  }
  const ms = epochSeconds ? (typeof value === 'number' ? value * 1000 : NaN) : (typeof value === 'string' ? Date.parse(value) : NaN);
  if (!Number.isFinite(ms)) throw new ReadingFormatError(`El campo ${field} no es una fecha válida.`, field);
  return new Date(ms).toISOString();
}

/** @param {Object<string, string>} table Wire status -> schema status. */
function statusFrom(value, table, field) {
  const mapped = typeof value === 'string' ? table[value.toLowerCase()] : undefined;
  if (!mapped) throw new ReadingFormatError(`El estado "${String(value)}" del campo ${field} no es válido.`, field);
  return mapped;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = { ReadingFormatError, finiteNumber, text, instant, statusFrom, isObject };
