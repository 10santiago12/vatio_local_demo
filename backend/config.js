'use strict';
/**
 * Environment configuration for Vatio (zero dependencies).
 *
 * - `.env` is parsed with a tiny parser and never overrides real environment variables.
 * - APP_ENV selects the profile: `local` (default) or `production`.
 * - Production refuses weak or missing secrets so an insecure deployment cannot start silently.
 */
const fs = require('node:fs');
const path = require('node:path');

const PROFILES = ['local', 'production'];
const MIN_ADMIN_PASSWORD = 16;
const MIN_DEVICE_KEY_PRODUCTION = 16;
const ROOT_DIR = path.join(__dirname, '..');

// Values that appear in docs, old READMEs or templates and must never be used in production.
const INSECURE_VALUES = new Set([
  'vatio-demo-2026', 'change-me', 'changeme', 'password', 'admin', 'secret',
  'replace-with-a-unique-password', 'replace-with-a-unique-device-key'
]);

class ConfigError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Parses KEY=VALUE lines. Supports comments, `export`, and single or double quotes. */
function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[match[1]] = value;
  }
  return out;
}

/** Loads a .env file into `env`. Existing variables always win. Returns the keys applied. */
function loadEnvFile(file, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const applied = [];
  for (const [key, value] of Object.entries(parseEnv(text.replace(/^﻿/, '')))) {
    if (env[key] === undefined) { env[key] = value; applied.push(key); }
  }
  return applied;
}

function isWeak(value) {
  return INSECURE_VALUES.has(String(value).trim().toLowerCase());
}

/** Validates an env object and returns the configuration, or throws ConfigError with every problem. */
function buildConfig(env = process.env) {
  const problems = [];
  const appEnv = (env.APP_ENV || 'local').trim().toLowerCase();
  if (!PROFILES.includes(appEnv)) problems.push(`APP_ENV debe ser "local" o "production" (recibido: "${env.APP_ENV}").`);
  const production = appEnv === 'production';

  let port = 3000;
  if (env.PORT !== undefined && env.PORT !== '') {
    port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT debe ser un entero entre 1 y 65535 (recibido: "${env.PORT}").`);
  }
  const host = (env.HOST || (production ? '0.0.0.0' : '127.0.0.1')).trim();

  const adminPassword = env.VATIO_ADMIN_PASSWORD || '';
  const deviceKey = env.VATIO_DEVICE_KEY || '';
  if (adminPassword && adminPassword.length < MIN_ADMIN_PASSWORD) problems.push(`VATIO_ADMIN_PASSWORD debe tener al menos ${MIN_ADMIN_PASSWORD} caracteres.`);
  if (production) {
    if (!adminPassword) problems.push('VATIO_ADMIN_PASSWORD es obligatoria en producción (mínimo 16 caracteres).');
    if (!deviceKey) problems.push('VATIO_DEVICE_KEY es obligatoria en producción.');
    if (adminPassword && isWeak(adminPassword)) problems.push('VATIO_ADMIN_PASSWORD usa un valor inseguro conocido; elija una contraseña única.');
    if (deviceKey && isWeak(deviceKey)) problems.push('VATIO_DEVICE_KEY usa un valor inseguro conocido; elija una clave única.');
    if (deviceKey && deviceKey.length < MIN_DEVICE_KEY_PRODUCTION) problems.push(`VATIO_DEVICE_KEY debe tener al menos ${MIN_DEVICE_KEY_PRODUCTION} caracteres en producción.`);
    if (adminPassword && deviceKey && adminPassword === deviceKey) problems.push('VATIO_ADMIN_PASSWORD y VATIO_DEVICE_KEY deben ser distintas.');
  }
  // Demo Panel: on in local, off in production unless VATIO_ENABLE_DEMO_PANEL=yes.
  const demoFlag = String(env.VATIO_ENABLE_DEMO_PANEL || '').trim().toLowerCase();
  if (demoFlag && !['yes', 'no'].includes(demoFlag)) problems.push('VATIO_ENABLE_DEMO_PANEL debe ser "yes" o "no".');
  const demoPanelEnabled = demoFlag ? demoFlag === 'yes' : !production;
  // Backups: directory, how many to keep and the schedule (hours; 0 = off). Scheduled by default only in production.
  const backupKeep = env.VATIO_BACKUP_KEEP === undefined || env.VATIO_BACKUP_KEEP === '' ? 7 : Number(env.VATIO_BACKUP_KEEP);
  if (!Number.isInteger(backupKeep) || backupKeep < 1 || backupKeep > 365) problems.push('VATIO_BACKUP_KEEP debe ser un entero entre 1 y 365.');
  const backupIntervalHours = env.VATIO_BACKUP_INTERVAL_HOURS === undefined || env.VATIO_BACKUP_INTERVAL_HOURS === '' ? (production ? 6 : 0) : Number(env.VATIO_BACKUP_INTERVAL_HOURS);
  if (!Number.isFinite(backupIntervalHours) || backupIntervalHours < 0 || backupIntervalHours > 720) problems.push('VATIO_BACKUP_INTERVAL_HOURS debe ser un número entre 0 y 720 (0 desactiva los respaldos programados).');
  const feedbackValue = (env.VATIO_FEEDBACK_URL || '').trim();
  let feedbackUrl = null;
  if (feedbackValue) {
    const url = URL.parse(feedbackValue);
    if (!url || url.protocol !== 'https:' || url.username || url.password) {
      problems.push('VATIO_FEEDBACK_URL debe ser una URL HTTPS sin credenciales.');
    } else {
      feedbackUrl = url.href;
    }
  }
  const pqrEmail = (env.VATIO_PQR_EMAIL || '').trim() || null;
  if (pqrEmail && !/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(pqrEmail)) {
    problems.push('VATIO_PQR_EMAIL debe contener una sola dirección de correo válida.');
  }
  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    demoPanelEnabled,
    feedbackUrl,
    pqrEmail,
    appEnv,
    isProduction: production,
    host,
    port,
    adminPassword,
    deviceKey,
    dbPath: env.VATIO_DB ? path.resolve(env.VATIO_DB) : path.join(ROOT_DIR, 'data', 'vatio.sqlite'),
    backupDir: env.VATIO_BACKUP_DIR ? path.resolve(env.VATIO_BACKUP_DIR) : path.join(ROOT_DIR, 'data', 'backups'),
    backupKeep,
    backupIntervalHours,
    /** Secure cookies in production, behind an HTTPS proxy, or over direct TLS. */
    secureCookie(req) {
      const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      return production || forwarded === 'https' || Boolean(req?.socket?.encrypted);
    }
  });
}

let cached;
/** Loads `.env` (if present) and validates once per process. */
function getConfig() {
  if (!cached) {
    loadEnvFile(process.env.VATIO_ENV_FILE || path.join(ROOT_DIR, '.env'));
    cached = buildConfig(process.env);
  }
  return cached;
}

/** Like getConfig but prints a Spanish message and exits instead of throwing. */
function getConfigOrExit() {
  try { return getConfig(); } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error('\nERROR de configuración:');
    for (const problem of error.problems) console.error(` - ${problem}`);
    console.error('\nRevise sus variables de entorno o el archivo .env (ver .env.example y README.md).\n');
    process.exit(1);
  }
}

module.exports = { ConfigError, parseEnv, loadEnvFile, buildConfig, getConfig, getConfigOrExit };
