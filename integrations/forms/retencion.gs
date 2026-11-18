/**
 * Retención de respuestas de Vatio en Google Forms y su hoja vinculada.
 *
 * Vincule este proyecto de Apps Script a la hoja de respuestas. Configure las
 * propiedades FORM_ID y RESPONSE_SHEET_ID con los ID de la copia correcta.
 * Ejecute validarConfiguracion antes de instalar un activador horario para
 * purgarRespuestasVencidas. No gestiona los correos de Outlook ni copias.
 *
 * Las eliminaciones son permanentes. Compruebe la cuenta, el formulario, la
 * hoja y el alcance de la política antes de autorizar el activador.
 */

function finDeMesSiguiente(fecha) {
  const y = fecha.getUTCFullYear();
  const m = fecha.getUTCMonth() + 1;
  const maximo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(fecha.getUTCDate(), maximo),
    fecha.getUTCHours(), fecha.getUTCMinutes(), fecha.getUTCSeconds(), fecha.getUTCMilliseconds()));
}

function datosDeRetencion() {
  const props = PropertiesService.getScriptProperties();
  const formId = (props.getProperty('FORM_ID') || '').trim();
  const sheetId = props.getProperty('RESPONSE_SHEET_ID') || '';
  if (!formId || !/^\d+$/.test(sheetId)) throw new Error('Configure FORM_ID y RESPONSE_SHEET_ID.');
  const libro = SpreadsheetApp.getActiveSpreadsheet();
  const formulario = FormApp.openById(formId);
  if (!libro || formulario.getDestinationType() !== FormApp.DestinationType.SPREADSHEET ||
      formulario.getDestinationId() !== libro.getId()) {
    throw new Error('El formulario no está vinculado a esta hoja de cálculo.');
  }
  const hoja = libro.getSheets().find(s => String(s.getSheetId()) === sheetId);
  if (!hoja) throw new Error('No existe la hoja de respuestas indicada.');
  const encabezado = String(hoja.getRange(1, 1).getDisplayValue()).trim().toLowerCase();
  if (!['marca temporal', 'timestamp', 'marca de tiempo'].includes(encabezado)) {
    throw new Error('La primera columna no es la marca temporal esperada.');
  }
  return { formulario, hoja };
}

function validarConfiguracion() {
  const { formulario, hoja } = datosDeRetencion();
  Logger.log('Configuración válida: formulario vinculado y hoja de respuestas identificada.');
  return { ok: true, respuestas: formulario.getResponses().length, filas: Math.max(0, hoja.getLastRow() - 1) };
}

function purgarRespuestasVencidas() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Ya hay una tarea de retención en ejecución.');
  try {
    const { formulario, hoja } = datosDeRetencion();
    // Margen de una hora para un activador horario; los retrasos o caídas del
    // proveedor pueden requerir una revisión manual. No garantiza el plazo.
    const limite = Date.now() + 60 * 60 * 1000;
    let formularios = 0;
    let filas = 0;
    let fallos = 0;
    for (const respuesta of formulario.getResponses()) {
      if (finDeMesSiguiente(respuesta.getTimestamp()).getTime() <= limite) {
        try { formulario.deleteResponse(respuesta.getId()); formularios++; } catch (_) { fallos++; }
      }
    }
    const ultima = hoja.getLastRow();
    if (ultima > 1) {
      const marcas = hoja.getRange(2, 1, ultima - 1, 1).getValues();
      for (let i = marcas.length - 1; i >= 0; i--) {
        const fecha = marcas[i][0];
        if (Object.prototype.toString.call(fecha) === '[object Date]' && !isNaN(fecha.getTime()) &&
            finDeMesSiguiente(fecha).getTime() <= limite) {
          try { hoja.deleteRow(i + 2); filas++; } catch (_) { fallos++; }
        }
      }
    }
    Logger.log('Retención: respuestas eliminadas=%s; filas eliminadas=%s; errores=%s.', formularios, filas, fallos);
    if (fallos) throw new Error('La tarea terminó con errores; revise la ejecución y repita.');
    return { formularios, filas };
  } finally { lock.releaseLock(); }
}
