'use strict';

/** An error that maps to an HTTP answer. `message` is plain Spanish (it is shown to the user). */
class HttpError extends Error {
  /**
   * @param {number} status HTTP status.
   * @param {string} message Plain-Spanish text for the user.
   * @param {string} [code] Stable machine code.
   * @param {object} [extra] Extra fields merged into the JSON body.
   */
  constructor(status, message, code = 'error', extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const badRequest = (message, code = 'invalid_request', extra) => new HttpError(400, message, code, extra);
const notFound = (message = 'No se encontró lo que busca.', code = 'not_found') => new HttpError(404, message, code);
const conflict = (message, code = 'conflict') => new HttpError(409, message, code);
const unprocessable = (message, code = 'unprocessable', extra) => new HttpError(422, message, code, extra);

module.exports = { HttpError, badRequest, notFound, conflict, unprocessable };
