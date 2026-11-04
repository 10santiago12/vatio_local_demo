'use strict';
/** Login, current session and logout. */
const { badRequest, HttpError } = require('./http-error');
const { json } = require('./router');
const { COOKIE } = require('../app/auth');

function register(router, app) {
  const cookieAttributes = (req, maxAge) => `; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${app.config.secureCookie(req) ? '; Secure' : ''}`;

  router.post('/api/auth/login', async (ctx) => {
    let payload;
    try { payload = await ctx.body(); } catch { throw badRequest('Solicitud inválida.'); }
    const result = app.auth.login(payload.username, payload.password, ctx.req.socket.remoteAddress);
    if (!result) throw new HttpError(401, 'Credenciales inválidas.', 'invalid_credentials');
    if (result.limited) throw new HttpError(429, 'Demasiados intentos.', 'too_many_attempts');
    const { id, ...session } = result;
    return { status: 200, body: session, headers: { 'Set-Cookie': `${COOKIE}=${id}${cookieAttributes(ctx.req, app.auth.SESSION_MS / 1000)}` } };
  }, { public: true, doc: 'Inicia sesión con usuario y contraseña.' });

  router.get('/api/auth/me', ({ user }) => json(200, app.auth.describe(user)), { doc: 'Perfil de la sesión: usuario, perfil, nombre y permisos.' });

  router.post('/api/auth/logout', (ctx) => {
    const session = app.auth.logout(ctx.req);
    if (session) app.access.audit({ user: session, event: 'logout', details: {} });
    return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': `${COOKIE}=${cookieAttributes(ctx.req, 0)}` } };
  }, { doc: 'Cierra la sesión e invalida la cookie.' });
}

module.exports = { register };
