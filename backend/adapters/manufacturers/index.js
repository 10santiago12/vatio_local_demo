'use strict';
/**
 * Registry of manufacturer adapters (RNF-03: adding a manufacturer = adding one adapter here).
 *
 * `normalizeReading(raw, formatId?)` returns the common Reading model. When `formatId` is not given
 * the format is detected from the shape of the payload.
 */

const esp32 = require('./esp32');
const enersense = require('./enersense');
const voltiolab = require('./voltiolab');
const { ReadingFormatError } = require('./reading');

/** Most specific detectors first: the ESP32 format only needs `module_id`. */
const ADAPTERS = Object.freeze([enersense, voltiolab, esp32]);
const BY_ID = Object.freeze(Object.fromEntries(ADAPTERS.map((a) => [a.id, a])));

function adapterFor(formatId) {
  const adapter = BY_ID[formatId];
  if (!adapter) throw new ReadingFormatError(`El formato "${String(formatId)}" no está soportado. Formatos: ${Object.keys(BY_ID).join(', ')}.`, 'format');
  return adapter;
}

function detectAdapter(raw) {
  const adapter = ADAPTERS.find((a) => a.detect(raw));
  if (!adapter) throw new ReadingFormatError('No se reconoce el formato de la lectura.');
  return adapter;
}

/**
 * @param {*} raw One reading in a manufacturer format.
 * @param {string} [formatId] 'esp32' | 'enersense' | 'voltiolab'; detected when omitted.
 * @returns {import('./reading').Reading}
 * @throws {ReadingFormatError}
 */
function normalizeReading(raw, formatId) {
  return (formatId ? adapterFor(formatId) : detectAdapter(raw)).normalize(raw);
}

module.exports = { ADAPTERS, formatIds: () => Object.keys(BY_ID), adapterFor, detectAdapter, normalizeReading, ReadingFormatError };
