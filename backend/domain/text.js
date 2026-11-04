'use strict';
/**
 * Minimal Colombian number formatting for the plain-Spanish sentences the domain produces
 * (alert text, recommendation text). Screens keep their own formatting; this exists only so that
 * a message such as "Te cuesta $ 480 por noche" is built where the numbers are known.
 * Format: dot thousands separator, comma decimals, pesos as "$ 1.234.567" (rounded to whole pesos).
 */

const copFormat = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

/**
 * Pesos in Colombian format, rounded to the nearest peso.
 * @param {number} value
 * @returns {string} e.g. "$ 1.234.567"
 */
function formatCop(value) {
  return `$ ${copFormat.format(Math.round(value))}`;
}

/**
 * Decimal number with a comma, trimmed of trailing zeros.
 * @param {number} value
 * @param {number} [digits] Maximum fraction digits.
 * @returns {string} e.g. "12,5"
 */
function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
}

module.exports = { formatCop, formatNumber };
