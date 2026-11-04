'use strict';
/**
 * Tiny method + path router (no dependencies). Patterns may contain `:name` segments.
 *
 * A route carries its access rules, so the dispatcher can apply them before the handler runs:
 *   - `public: true`   no session needed (health, login, device telemetry);
 *   - `permission`     a domain permission checked with `authorize` (denials are audited);
 *   - `doc`            one Spanish line used by the API reference test.
 * Handlers receive a context and return `{status, body}` (JSON) or `{status, raw, contentType, headers}`.
 */

function compile(pattern) {
  const names = [];
  const source = pattern.split('/').map((segment) => {
    if (segment.startsWith(':')) { names.push(segment.slice(1)); return '([^/]+)'; }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${source}$`), names };
}

function createRouter() {
  const routes = [];
  function add(method, pattern, handler, options = {}) {
    const { regex, names } = compile(pattern);
    routes.push({ method, pattern, regex, names, handler, options });
    return routes[routes.length - 1];
  }
  return {
    add,
    get: (pattern, handler, options) => add('GET', pattern, handler, options),
    post: (pattern, handler, options) => add('POST', pattern, handler, options),
    put: (pattern, handler, options) => add('PUT', pattern, handler, options),
    patch: (pattern, handler, options) => add('PATCH', pattern, handler, options),
    delete: (pattern, handler, options) => add('DELETE', pattern, handler, options),
    /** @returns {{route: object, params: Object<string, string>}|null} */
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = route.regex.exec(pathname);
        if (!m) continue;
        const params = {};
        route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
        return { route, params };
      }
      return null;
    },
    /** Whether any method serves this path (to answer 405 instead of 404). */
    knows: (pathname) => routes.some((r) => r.regex.test(pathname)),
    list: () => routes.map(({ method, pattern, options }) => ({ method, pattern, ...options })),
  };
}

const json = (status, body) => ({ status, body });
const file = (body, contentType, filename) => ({
  status: 200, raw: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), contentType,
  headers: filename ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {},
});

module.exports = { createRouter, json, file };
