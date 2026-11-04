const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers/api');
const { createHttpServer } = require('../backend/http');

const DOC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'api.md'), 'utf8');

test('docs/api.md documents every registered route with its method, path and permission', async () => {
  const env = await startApp({ seed: false });
  try {
    const { router } = createHttpServer(env.app);
    const routes = router.list();
    assert.ok(routes.length >= 60);
    const sections = DOC.split(/\n(?=### )/);
    const missing = [];
    for (const route of routes) {
      const heading = `${route.method} ${route.pattern}`;
      const section = sections.find((s) => s.split('\n')[0].includes(`\`${heading}\``));
      if (!section) { missing.push(`${heading} (no section)`); continue; }
      if (route.public) {
        if (!/público/i.test(section.split('\n')[0])) missing.push(`${heading} (public not stated)`);
      } else if (route.permission) {
        if (!section.split('\n')[0].includes(`\`${route.permission}\``)) missing.push(`${heading} (permission ${route.permission})`);
      }
    }
    assert.deepEqual(missing, []);
  } finally { env.close(); }
});

test('every route carries a Spanish one-line description', async () => {
  const env = await startApp({ seed: false });
  try {
    const { router } = createHttpServer(env.app);
    for (const route of router.list()) assert.ok(route.doc && route.doc.length > 10, `${route.method} ${route.pattern}`);
  } finally { env.close(); }
});
