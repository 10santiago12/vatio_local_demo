'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const VIEWS = ['Inicio', 'Operaciones', 'Alertas', 'Recomendaciones', 'Control', 'Ahorro y retorno', 'Reportes',
  'Módulos', 'Datos crudos', 'Multisede', 'Configuración', 'Panel de Demo'];

const baseUrl = () => process.env.QA_BASE_URL;
const viewUrl = (view) => `${baseUrl()}/?view=${encodeURIComponent(view)}`;

async function addSession(context) {
  const cookies = process.env.QA_SESSION_COOKIE.split('; ').map((c) => {
    const [name, ...v] = c.split('=');
    return { name, value: v.join('='), url: baseUrl() };
  });
  await context.addCookies(cookies);
}

/** Collects console errors, page errors and failed or erroring requests. */
function watch(page) {
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  return problems;
}

async function uiLogin(page, password) {
  await page.goto(baseUrl());
  await page.fill('#username', 'admin');
  await page.fill('#password', password);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('.rank-row');
}

test.describe('autenticacion', () => {
  test('login correcto y contrasena incorrecta', async ({ page }) => {
    await page.goto(baseUrl());
    await page.fill('#username', 'admin');
    await page.fill('#password', 'contrasena-incorrecta-123');
    await page.click('#login-form button[type=submit]');
    await expect(page.locator('#login-error')).toHaveText('No fue posible iniciar sesión.');
    await page.fill('#password', process.env.QA_ADMIN_PASSWORD);
    await page.click('#login-form button[type=submit]');
    await expect(page.locator('.rank-row').first()).toBeVisible();
  });

  test('logout vuelve al login, borra la cookie y no deja token en el navegador', async ({ page, context }) => {
    await uiLogin(page, process.env.QA_ADMIN_PASSWORD);
    expect((await context.cookies()).some((c) => c.name === 'vatio_session')).toBe(true);
    await page.click('[data-action=logout]');
    await page.waitForSelector('#login-form');
    expect((await context.cookies()).some((c) => c.name === 'vatio_session' && c.value)).toBe(false);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored.toLowerCase()).not.toMatch(/token|csrf|session/);
  });
});

test.describe('sesion iniciada', () => {
  test.beforeEach(async ({ context }) => { await addSession(context); });

  test('cada vista carga sin errores de consola ni peticiones fallidas (con capturas)', async ({ page }, info) => {
    const problems = watch(page);
    const dir = path.join(__dirname, '..', 'results', 'screenshots', info.project.name);
    fs.mkdirSync(dir, { recursive: true });
    for (const view of VIEWS) {
      await page.goto(viewUrl(view));
      await expect(page.locator('main.main')).toBeVisible();
      await expect(page.locator('main.main')).not.toBeEmpty();
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: path.join(dir, `${view.replace(/[^a-z0-9]+/gi, '_')}.png`), fullPage: true });
    }
    expect(problems).toEqual([]);
  });

  test('el tema cambia y persiste tras recargar', async ({ page }) => {
    await page.goto(`${baseUrl()}/?view=Inicio&theme=dark`);
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.click('[data-action=toggle-theme]');
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(after).not.toBe(before);
    await page.goto(`${baseUrl()}/?view=Inicio`);
    await page.waitForSelector('main.main');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(after);
  });

  test('sin desbordamiento horizontal en ninguna vista', async ({ page }) => {
    const bad = [];
    for (const view of VIEWS) {
      await page.goto(viewUrl(view));
      await page.waitForSelector('main.main');
      await page.waitForLoadState('networkidle');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 1) bad.push(`${view}: +${over}px`);
    }
    expect(bad).toEqual([]);
  });

  test('ningun elemento se superpone con la barra inferior (movil)', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'La barra inferior solo existe en movil');
    const bad = [];
    for (const view of VIEWS) {
      await page.goto(viewUrl(view));
      await page.waitForSelector('#bottom-nav .bn-btn');
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const hits = await page.evaluate(() => {
        const nav = document.getElementById('bottom-nav').getBoundingClientRect();
        const out = [];
        for (const el of document.querySelectorAll('main.main *')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
          if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) continue; // e.g. closed <details>
          if (el.children.length) continue; // leaves only: text and controls
          // Visible area = element box clipped by every scrolling ancestor.
          let top = r.top; let bottom = r.bottom;
          for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            const o = getComputedStyle(a);
            if (o.overflowY !== 'visible' || o.overflowX !== 'visible') { const ar = a.getBoundingClientRect(); top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
          }
          if (bottom > top && bottom > nav.top + 1 && top < nav.bottom) out.push(`${el.tagName}.${el.className}`);
        }
        return out;
      });
      if (hits.length) bad.push(`${view}: ${hits.slice(0, 3).join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  test('barra inferior y hoja Más navegan entre vistas (movil)', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Solo movil');
    await page.goto(viewUrl('Inicio'));
    const bar = page.locator('#bottom-nav');
    await expect(bar).toBeVisible();
    const buttons = bar.locator('.bn-btn[data-view]');
    expect(await buttons.count()).toBeGreaterThanOrEqual(3);
    const second = buttons.nth(1);
    const target = await second.getAttribute('data-view');
    await second.click();
    await expect(bar.locator(`.bn-btn[data-view="${target}"]`)).toHaveAttribute('aria-current', 'page');
    await bar.locator('[data-action=open-more]').click();
    const sheet = page.locator('.sheet[role=dialog]');
    await expect(sheet).toBeVisible();
    const item = sheet.locator('[data-view]').first();
    const moreView = await item.getAttribute('data-view');
    await item.click();
    await expect(page.locator('.sheet[role=dialog]')).toHaveCount(0);
    await expect(bar.locator('[data-action=open-more]')).toHaveAttribute('aria-current', 'page');
  });
});
