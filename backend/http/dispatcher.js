'use strict';
/**
 * Request pipeline: route lookup, session, CSRF, permission, handler, error mapping.
 *
 * Order for protected API routes (which keeps the contract of the first MVP): no session -> 401, a
 * state-changing method without the CSRF token -> 403, a role without the permission -> 403 with a
 * plain-Spanish message and an audit row, then the handler.
 */
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { HttpError } = require('./http-error');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function send(res, status, body, contentType = 'application/json; charset=utf-8', headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': payload.length, 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'El contenido enviado es demasiado grande.', 'payload_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function mimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
}

function serveStatic(res, pathname) {
  let relative = pathname === '/' ? '/index.html' : pathname;
  try { relative = decodeURIComponent(relative); } catch { return send(res, 400, 'Bad request', 'text/plain; charset=utf-8'); }
  const resolved = path.normalize(path.join(PUBLIC_DIR, relative));
  const within = path.relative(PUBLIC_DIR, resolved);
  if (within.startsWith('..') || path.isAbsolute(within)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  fs.readFile(resolved, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (fallbackErr, fallback) => {
        if (fallbackErr) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fallback);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeType(resolved), 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/**
 * @param {{router: object, app: object}} deps `app` is the runtime (config, auth, access, services, logging).
 * @returns {function(import('http').IncomingMessage, import('http').ServerResponse): Promise<void>}
 */
function createDispatcher({ router, app }) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const isApi = pathname.startsWith('/api/');
      const matched = router.match(req.method, pathname);
      if (!isApi) return serveStatic(res, pathname);

      const options = matched ? matched.route.options : {};
      let user = null;
      if (!options.public) {
        user = app.auth.session(req);
        if (!user) throw new HttpError(401, 'Autenticación requerida.', 'unauthenticated');
        if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== user.csrf) throw new HttpError(403, 'CSRF inválido.', 'csrf');
      }
      if (!matched) throw new HttpError(router.knows(pathname) ? 405 : 404, router.knows(pathname) ? 'Método no permitido.' : 'No existe ese recurso.', 'not_found');
      if (options.permission) app.access.require(user, options.permission, { action: options.action || `${req.method} ${matched.route.pattern}` });
      if (options.guard) options.guard(app, user);

      let cachedBody;
      const ctx = {
        req, res, url, app, user, params: matched.params, query: Object.fromEntries(url.searchParams),
        /** Parsed JSON body ({} when empty). */
        async body() {
          if (cachedBody === undefined) {
            const text = await readBody(req);
            try { cachedBody = text.trim() ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'Solicitud inválida.', 'invalid_json'); }
          }
          return cachedBody;
        },
        rawBody: () => readBody(req),
      };
      const result = await matched.route.handler(ctx);
      if (!result || result.handled) return undefined;
      if (result.raw !== undefined) return send(res, result.status, result.raw, result.contentType, result.headers);
      return send(res, result.status, result.body, 'application/json; charset=utf-8', result.headers);
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message, code: error.code, ...error.extra });
      app.logError('http', error, { method: req.method, path: pathname });
      return send(res, 500, { error: 'Ocurrió un problema inesperado. Intente de nuevo en unos minutos.', code: 'internal_error' });
    }
  };
}

module.exports = { createDispatcher, send, readBody };
