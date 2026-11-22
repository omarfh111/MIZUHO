import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
url.searchParams.set('intro', '0');
url.hash = 'simulation';
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const response = (page, endpoint) => page.waitForResponse(r =>
  r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/resilience/${endpoint}`), { timeout: 90000 });
const waiting = async ([reply]) => { assert.equal(reply.status(), 200); return reply.json(); };
const amount = n => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(n);

async function checkOperatorRotation(page, site, regional) {
  if (regional) await page.getByRole('button', { name: 'Load example assumptions' }).click();
  else await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('normal');
  await page.getByRole('button', { name: regional ? 'Compare regional plans' : 'Calculate schedules' }).click();
  await page.getByText('Compare your own rotation', { exact: true }).click();
  const submit = page.getByRole('button', { name: 'Replay rotation', exact: true });
  const delivery = page.getByLabel('Delivery requested (m³) 1', { exact: true });
  await delivery.fill('4000');
  assert.ok(await submit.isDisabled());
  await page.getByLabel('Parcel 1', { exact: true }).selectOption(regional ? 'west' : 'A');
  const waitRotation = () => page.waitForResponse(r => new URL(r.url()).pathname === `/api/sites/${site}/operator-rotation`);
  const reply = await waiting(await Promise.all([waitRotation(), submit.click()]));
  const panel = page.getByRole('region', { name: 'Rotation replay results' });
  await panel.getByText(`4,000 → ${amount(reply.hours[0].feasible_delivery_m3)}`, { exact: true }).waitFor();
  const timely = panel.getByRole('row', { name: /^Delivered on time/ }).getByRole('cell');
  assert.deepEqual(await timely.allTextContents(), [reply.operator, reply.optimized].map(p => `${amount(p.metrics.delivered_on_time_m3)} m³`));
  await delivery.fill('2');
  assert.equal(await panel.count(), 0);

  // Hold one response while the operator changes an entry again.
  let release;
  const delay = new Promise(resolve => { release = resolve; });
  let seen;
  const intercepted = new Promise(resolve => { seen = resolve; });
  await page.route('**/operator-rotation', async route => {
    seen();
    await delay;
    await route.fulfill({ json: reply }).catch(() => {});
  }, { times: 1 });
  await submit.click();
  await intercepted;
  await delivery.fill('1');
  release();
  assert.equal(await panel.count(), 0);
  await page.reload();
}

async function checkLateComparison(page, site, regional) {
  await page.evaluate(path => {
    const originalFetch = window.fetch.bind(window);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    window.testComparison = { waiting: false, release };
    window.fetch = async (resource, options) => {
      const reply = await originalFetch(resource, options);
      if (new URL(resource, location.href).pathname !== path || options?.method !== 'POST') return reply;
      const content = await reply.arrayBuffer();
      window.fetch = originalFetch;
      window.testComparison.waiting = true;
      window.testComparison.signal = options.signal;
      await gate;
      return new Response(content, { status: reply.status, headers: reply.headers });
    };
  }, regional ? `/api/sites/${site}/planning` : '/api/compare');
  const calculate = page.getByRole('button', { name: regional ? 'Compare regional plans' : 'Calculate schedules' });
  await calculate.click();
  await page.waitForFunction(() => window.testComparison.waiting);
  await page.getByRole('button', { name: 'Test outage resilience' }).click();
  assert.equal(await page.evaluate(() => {
    window.testComparison.release();
    return window.testComparison.signal.aborted;
  }), true);
  await page.getByRole('button', { name: 'Ask Mizuho' }).click();
  const panel = page.getByRole('dialog', { name: 'Mizuho assistant' });
  await panel.getByText('Site and evidence', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to planning inputs' }).click();
  await calculate.waitFor();
  assert.equal(await calculate.isEnabled(), true);
  assert.equal(await page.getByRole('region', { name: 'Regional plan comparison' }).count(), 0);
  if (!regional) assert.equal(await page.getByRole('button', { name: 'Approve simulated plan' }).count(), 0);
}

try {
  for (const [site,width] of [['jendouba-pilote', 1380], ['korba-cap-bon', 390],
    ['kairouan-chebika', 1280], ['gafsa-oasis', 390], ['bizerte-mateur', 1280],
    ['sidi-bouzid-plain', 390], ['sfax-el-hajeb', 1280]]) {
    url.searchParams.set('site', site);
    const page = await browser.newPage({ viewport: { width, height: 860 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url.href);
    const regional = site !== 'jendouba-pilote';
    await checkOperatorRotation(page, site, regional);
    if (regional) {
      await page.getByRole('button', { name: 'Test outage resilience' }).click();
      await page.getByRole('heading', { name: 'Set the station and parcel assumptions first' }).waitFor();
      await page.getByRole('button', { name: 'Edit planning inputs' }).click();
      await page.getByRole('button', { name: 'Load example assumptions' }).click();
    }
    await checkLateComparison(page, site, regional);
    await page.getByRole('button', { name: regional ? 'Test outage resilience' : 'Test the limited-pump example' }).click();
    if (regional) {
      await page.getByText('Choose test hours and durations', { exact: true }).click();
      const starts = page.getByRole('textbox', { name: 'Start hours' });
      await starts.fill('11,11');
      assert.equal(await page.getByRole('button', { name: 'Run outage grid' }).isDisabled(), true);
      await starts.fill('11,14');
      await page.getByRole('textbox', { name: 'Durations' }).fill('2,4');
    } else {
      await page.route('**/resilience/grid', route => route.fulfill({ status: 503 }), { times: 1 });
      await page.getByRole('button', { name: 'Run outage grid' }).click();
      await page.getByRole('alert').filter({ hasText: 'Service unavailable' }).waitFor();
    }
    const grid = await waiting(await Promise.all([response(page,'grid'),
      page.getByRole('button', { name: regional ? 'Run outage grid' : 'Retry calculation' }).click()]));
    const gridView = page.getByRole('region', { name: 'Outage coverage grid' });
    assert.equal(grid.site_id, site);
    assert.equal(grid.cells.length, regional ? 4 : 16);
    if (!regional) {
      const hour11 = grid.cells.filter(cell => cell.start === 11);
      assert.equal(hour11.find(cell => cell.duration === 4).coverage_bp, 9000);
      assert.equal(hour11.find(cell => cell.duration === 8).reserve_status, 'unreachable');
    }
    await gridView.getByRole('heading', { name: /Longest tested cut/ }).waitFor();
    assert.equal(await gridView.locator('.outage-cell').count(), grid.cells.length);
    const cell = gridView.getByRole('button', { name: /^11:00, 4 h,/ });
    const detail = await waiting(await Promise.all([response(page,'case'), cell.click()]));
    assert.equal(detail.site_id, site);
    const selectedCell = grid.cells.find(item => item.start === detail.start && item.duration === detail.duration);
    assert.ok(selectedCell);
    if (detail.rules.fair.status === 'OPTIMAL' && selectedCell.status === 'OPTIMAL') {
      assert.equal(detail.rules.fair.metrics.worst_coverage_bp, selectedCell.coverage_bp);
    }
    const review = page.getByRole('region', { name: 'Selected outage case' });
    const comparison = review.getByRole('table', { name: 'Daily results by sharing rule' });
    await comparison.waitFor();
    const rules = ['fixed', 'fair', 'urgent'].map(id => detail.rules[id].metrics);
    const kWh = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 });
    for (const [label, expected] of [
      ['Delivered on time', rules.map(m => `${amount(m.delivered_on_time_m3)} m³`)],
      ['Water withdrawn', rules.map(m => `${amount(m.withdrawn_m3)} m³`)],
      ['Grid electricity', rules.map(m => `${kWh.format(m.grid_wh / 1000)} kWh`)],
    ]) {
      const row = comparison.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) });
      assert.deepEqual(await row.getByRole('cell').allTextContents(), expected);
    }
    const replay = review.getByRole('region', { name: 'Selected outage replay' });
    const tab = name => review.getByRole('group', { name: 'Explore this interruption' }).getByRole('button', { name, exact: true });
    await replay.locator('canvas').waitFor();
    if (regional) assert.equal(await replay.locator('[data-site-scene]').getAttribute('data-site-scene'), site);
    const raw = detail.rules.fair.actions.find(a => a.slot === detail.start);
    const readings = replay.locator('dl[aria-label="Physical results for this hour"]');
    const read = (name, n) => readings.getByText(name, { exact: true }).locator('..').getByText(`${amount(n)} m³`, { exact: true }).waitFor();
    await read('End stock', raw.tank_stock_m3);
    await replay.getByRole('button', { name: 'Play outage replay' }).click();
    await replay.getByText('Grid outage · 12:00', { exact: true }).waitFor();
    await replay.getByRole('button', { name: 'Pause outage replay' }).click();
    await review.getByRole('button', { name: 'Urgent parcel first' }).click();
    await replay.getByRole('heading', { name: 'Urgent parcel first' }).waitFor();
    await replay.getByText('Grid outage · 12:00', { exact: true }).waitFor();
    await replay.getByRole('slider', { name: 'Outage replay hour' }).press('ArrowLeft');
    await tab('Leak or sensor?').click();
    const physical = detail.incidents.find(i => i.kind === 'physical_loss').readings.find(r => r.slot === detail.start);
    await read('Water lost', physical.physical_loss_m3);
    await review.getByRole('button', { name: 'Stock meter fault' }).click();
    const faulty = detail.incidents.find(i => i.kind === 'meter_error').readings.find(r => r.slot === detail.start);
    await read('Tank sensor', faulty.reported_stock_m3);
    await read('End stock', faulty.physical_stock_m3);
    await read('Water lost', 0);
    await tab('Tank or backup?').click();
    await review.getByRole('button', { name: 'Islandable pump backup' }).click();
    await replay.getByRole('heading', { name: 'Islandable pump backup' }).waitFor();
    await tab('Three-day heat').click();
    await review.getByRole('button', { name: 'Pace withdrawals over three days' }).click();
    await review.getByRole('button', { name: 'Day 3' }).click();
    await replay.getByRole('heading', { name: 'Heat day 3 · Paced withdrawals' }).waitFor();
    await tab('Community electricity').click();
    await page.getByText('Household electricity during the outage', { exact: true }).click();
    await page.getByRole('button', { name: 'Load example circuit' }).click();
    const homes = page.getByRole('spinbutton', { name: 'Homes on this circuit' });
    await homes.fill('11');
    await page.getByRole('button', { name: 'Calculate household continuity' }).click();
    await page.getByRole('region', { name: 'Simulated household continuity' }).waitFor();
    const nextCell = gridView.getByRole('button', { name: regional ? /^14:00, 2 h,/ : /^09:00, 2 h,/ });
    await waiting(await Promise.all([response(page,'case'), nextCell.click()]));
    await homes.waitFor();
    assert.equal(await homes.inputValue(), '11');
    assert.equal(await page.getByRole('region', { name: 'Simulated household continuity' }).count(), 0);
    await page.getByText('Case assumptions', { exact: true }).click();
    const urgent = page.getByRole('combobox', { name: 'Urgent parcel' });
    const urgentId = regional ? 'east' : 'B';
    await urgent.selectOption(urgentId);
    assert.equal(await review.count(), 0);
    await page.getByRole('spinbutton', { name: 'Islandable pump backup (W)' }).fill('0');
    const revised = await waiting(await Promise.all([response(page, 'case'),
      page.getByRole('button', { name: 'Recalculate selected case' }).click()]));
    assert.equal(revised.urgent_plot_id, urgentId);
    assert.equal(revised.upgrades.find(option => option.id === 'backup').backup_wh, 0);
    await review.getByRole('button', { name: 'Back to outage grid' }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-pressed')), 'true');
    await page.getByRole('spinbutton', { name: 'Coverage target' }).fill('55');
    assert.equal(await review.count(), 0);
    assert.equal(await gridView.locator('.outage-cell').count(), 0);
    if (!regional) {
      await page.getByRole('button', { name: 'Back to planning inputs' }).click();
      await page.getByRole('button', { name: 'Restore previous inputs' }).click();
      await page.getByRole('button', { name: 'Test the limited-pump example' }).waitFor();
      for (const scenario of ['mini', 'jplus1']) {
        await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption(scenario);
        await page.getByRole('button', { name: 'Test outage resilience' }).click();
        await waiting(await Promise.all([response(page,'grid'), page.getByRole('button', { name: 'Run outage grid' }).click()]));
        await waiting(await Promise.all([response(page,'case'), gridView.locator('.outage-cell').first().click()]));
        await replay.getByRole('button', { name: 'Plot C', exact: true }).click();
        await replay.getByText('Plot C · Outside this scenario', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Back to planning inputs' }).click();
      }
    } else {
      await page.getByRole('button', { name: 'Back to planning inputs' }).click();
      await page.getByRole('button', { name: 'Compare regional plans' }).click();
      await page.getByRole('region', { name: 'Regional plan comparison' }).waitFor();
      await page.getByRole('button', { name: 'Test outage resilience' }).click();
      await page.getByRole('button', { name: 'Back to planning inputs' }).click();
      await page.getByRole('button', { name: 'Ask Mizuho' }).click();
      await page.getByRole('dialog', { name: 'Mizuho assistant' }).getByText('Regional comparison available').waitFor();
      await page.keyboard.press('Escape');
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${site} passed operator rotation, outage grid, sector deliveries, matched incidents, heat, backup and household replay.`);
  }
} finally { await browser.close(); }
