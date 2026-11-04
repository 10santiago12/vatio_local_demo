'use strict';
const crypto = require('node:crypto');

const MIN_PASSWORD_LENGTH = 16;
const MAX_PASSWORD_LENGTH = 256;

/** @returns {{salt: string, hash: string}} scrypt hash with a fresh random salt. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

/** Constant-time check; always spends the same work, also when the user does not exist. */
function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(typeof password === 'string' && password.length <= MAX_PASSWORD_LENGTH ? password : '', salt || '00000000000000000000000000000000', 64);
  const actual = hash ? Buffer.from(hash, 'hex') : Buffer.alloc(64);
  return Boolean(hash) && actual.length === candidate.length && crypto.timingSafeEqual(candidate, actual);
}

/** Plain-Spanish problem with a password, or null when it is acceptable. */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `La contraseña no puede superar ${MAX_PASSWORD_LENGTH} caracteres.`;
  return null;
}

module.exports = { hashPassword, verifyPassword, passwordProblem, MIN_PASSWORD_LENGTH };
