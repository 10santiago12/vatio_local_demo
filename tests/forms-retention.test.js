'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'forms', 'retencion.gs'), 'utf8');
function context(overrides = {}) {
  const sandbox = { Date, Object, String, Math, Error, isNaN, Logger: { log() {} }, ...overrides };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test('retención suma un mes calendario y ajusta fin de mes', () => {
  const c = context();
  assert.equal(c.finDeMesSiguiente(new Date('2026-01-31T10:30:00Z')).toISOString(), '2026-02-28T10:30:00.000Z');
  assert.equal(c.finDeMesSiguiente(new Date('2026-12-15T10:30:00Z')).toISOString(), '2027-01-15T10:30:00.000Z');
});

test('retención rechaza un formulario vinculado a otro libro antes de borrar', () => {
  let deleted = false;
  const c = context({
    PropertiesService: { getScriptProperties: () => ({ getProperty: n => n === 'FORM_ID' ? 'form' : '123' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getId: () => 'book' }) },
    FormApp: { DestinationType: { SPREADSHEET: 'sheet' }, openById: () => ({
      getDestinationType: () => 'sheet', getDestinationId: () => 'other', deleteResponse: () => { deleted = true; },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  });
  assert.throws(() => c.purgarRespuestasVencidas(), /no está vinculado/);
  assert.equal(deleted, false);
});

test('retención elimina solo respuestas y filas vencidas de la hoja vinculada', () => {
  const removedResponses = [], removedRows = [];
  const old = new Date('2020-01-01T00:00:00Z'), recent = new Date(Date.now());
  const sheet = {
    getSheetId: () => 123, getLastRow: () => 3,
    getRange: (row) => row === 1 ? { getDisplayValue: () => 'Marca temporal' } :
      { getValues: () => [[old], [recent]] },
    deleteRow: n => removedRows.push(n),
  };
  const c = context({
    PropertiesService: { getScriptProperties: () => ({ getProperty: n => n === 'FORM_ID' ? 'form' : '123' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getId: () => 'book', getSheets: () => [sheet] }) },
    FormApp: { DestinationType: { SPREADSHEET: 'sheet' }, openById: () => ({
      getDestinationType: () => 'sheet', getDestinationId: () => 'book',
      getResponses: () => [{ getTimestamp: () => old, getId: () => 'old' }, { getTimestamp: () => recent, getId: () => 'new' }],
      deleteResponse: id => removedResponses.push(id),
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  });
  c.purgarRespuestasVencidas();
  assert.deepEqual(removedResponses, ['old']);
  assert.deepEqual(removedRows, [2]);
});
