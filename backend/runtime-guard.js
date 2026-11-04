'use strict';
// Startup guard. Must stay free of syntax and modules that older Node versions cannot load,
// so it can print a clear message before node:sqlite is required.
const MIN_NODE_MAJOR = 24;

/** Exits with a clear Spanish message when the runtime is older than Node 24. */
function assertNodeVersion(version = process.versions.node, exit = process.exit) {
  const major = Number(String(version).split('.')[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    console.error(`\nERROR: Vatio requiere Node.js ${MIN_NODE_MAJOR} o superior (versión detectada: ${version}).`);
    console.error('Instale Node.js 24 (consulte .nvmrc) y vuelva a ejecutar.\n');
    exit(1);
    return false;
  }
  return true;
}

module.exports = { MIN_NODE_MAJOR, assertNodeVersion };
