const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/api');
const { ROLES } = require('../../backend/domain/constants');
const { matchesManual } = require('../../backend/domain/savings');

let env;
let owner;
before(async () => { env = await startApp(); owner = await env.as('owner'); });
after(() => env.close());

async function expectDeniedForOthers(allowed, method, url) {
  for (const role of Object.keys(ROLES).filter((r) => !allowed.includes(r))) {
    const client = await env.as(role);
    const before = env.repos.audit.list({ role, event: 'permission_denied', limit: 1000 }).length;
    const res = await client.call(method, url);
    assert.equal(res.status, 403, `${role} ${url}`);
    assert.match(res.body.error, /no tiene permiso/);
    const rows = env.repos.audit.list({ role, event: 'permission_denied', limit: 1000 });
    assert.equal(rows.length, before + 1, `${role} ${url} audited`);
    assert.equal(rows[0].result, 'rejected');
  }
}

test('savings and ROI: cumulative kWh and COP, investment used, payback range, weekly and cumulative series', async () => {
  const finance = await env.as('finance');
  const res = await finance.get('/api/savings');
  assert.equal(res.status, 200);
  const s = res.body;
  assert.ok(s.period.days >= 14);
  assert.ok(s.cumulativeSavingsKwh > 0 && s.cumulativeSavingsCop > 0);
  assert.equal(s.investmentCop, env.repos.settings.get(env.app.siteId).investment_cop);
  assert.equal(s.payback.status, 'estimated');
  assert.ok(s.payback.investmentCop === s.investmentCop && s.payback.minMonths <= s.payback.months);

  const manualMonthly = (s.cumulativeSavingsCop / s.period.days) * 30;
  assert.ok(matchesManual(s.payback.months, s.investmentCop / manualMonthly), 'payback agrees with the manual calculation within 2 %');
  const weeklyKwh = s.weekly.reduce((sum, w) => sum + (w.baselineKwh - w.actualKwh), 0);
  assert.ok(Math.abs(weeklyKwh - s.cumulativeSavingsKwh) < 0.1, 'weekly series adds up to the cumulative savings');
  assert.equal(s.weekly.reduce((sum, w) => sum + w.days, 0), s.period.days);
  assert.equal(s.cumulative.length, s.period.days);
  assert.ok(Math.abs(s.cumulative[s.cumulative.length - 1].savingsCop - s.cumulativeSavingsCop) <= 1);
  assert.ok(s.cumulative.every((p) => p.investmentCop === s.investmentCop));
  assert.match(s.note, /estimación/);
  await expectDeniedForOthers(['owner', 'finance'], 'GET', '/api/savings');
});

test('payback is not estimable when there is no positive saving', async () => {
  const empty = await startApp({ seed: false });
  try {
    const client = await empty.as('owner');
    const s = (await client.get('/api/savings')).body;
    assert.equal(s.payback.status, 'not_estimable');
    assert.equal(s.payback.label, 'Retorno no estimable');
    assert.equal(s.payback.months, undefined);
    assert.ok(s.payback.investmentCop > 0, 'the investment used is still reported');
    assert.equal(s.cumulativeSavingsCop, 0);
  } finally { empty.close(); }
});

test('attributable savings: conclusive, "No concluyente" and "En medición (día N de 7)", always with the estimate disclaimer', async () => {
  const { items, disclaimer } = (await owner.get('/api/savings/attributable')).body;
  assert.match(disclaimer, /estimación/);
  const byStatus = (status) => items.filter((i) => i.status === status);
  assert.ok(byStatus('conclusive').length >= 1, 'coffee standby recommendation is conclusive');
  assert.ok(byStatus('inconclusive').length >= 1, 'sign timer recommendation is not conclusive');
  assert.equal(byStatus('conclusive')[0].label, 'Conclusivo');
  assert.ok(byStatus('conclusive')[0].savingsKwh > 0 && byStatus('conclusive')[0].savingsCop > 0);
  assert.equal(byStatus('inconclusive')[0].label, 'No concluyente');
  assert.ok(items.every((i) => i.disclaimer === disclaimer));

  await owner.get('/api/recommendations');
  const recommendation = env.repos.recommendations.list({ siteId: env.app.siteId, status: 'pending' })[0];
  assert.equal((await owner.post(`/api/recommendations/${recommendation.id}/decision`, { action: 'accept' })).status, 200);
  const fresh = (await owner.get('/api/savings/attributable')).body.items.find((i) => i.recommendationId === recommendation.id);
  assert.equal(fresh.status, 'measuring');
  assert.match(fresh.label, /^En medición \(día \d de 7\)$/);
});

test('multisite: normalized per operating day, largest reduction highlighted, editable sector benchmark', async () => {
  const chain = await env.as('chain_owner');
  const res = await chain.get('/api/multisite');
  assert.equal(res.status, 200);
  const { rows, highlightedSiteId } = res.body;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(Math.abs(row.kwhPerOperatingDay - row.consumptionKwh / row.operatingDays) < 0.02, `${row.siteId} per operating day`);
  }
  assert.ok(rows.some((r) => r.operatingDays !== rows[0].operatingDays), 'sites with different schedules');
  const best = rows.reduce((a, b) => (b.reductionPct > a.reductionPct ? b : a));
  assert.equal(highlightedSiteId, best.siteId);
  assert.equal(rows.filter((r) => r.highlighted).length, 1);
  assert.ok(rows.every((r) => r.vsSectorPct === null));

  assert.equal((await owner.put('/api/settings', { sectorReferenceKwhPerDay: 50 })).status, 200);
  const withReference = (await chain.get('/api/multisite?days=14')).body;
  assert.equal(withReference.sectorReferenceKwhPerDay, 50);
  assert.ok(withReference.rows.every((r) => r.vsSectorPct !== null));
  assert.equal((await chain.get('/api/multisite?days=3')).status, 400);
  await expectDeniedForOthers(['owner', 'chain_owner'], 'GET', '/api/multisite');
});
