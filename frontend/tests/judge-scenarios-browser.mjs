import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
url.searchParams.set('intro', '0');
url.hash = 'simulation';
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const hits = (response, path) => new URL(response.url()).pathname === path;

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url.href);

  const scenario = page.getByRole('combobox', { name: 'Scenario', exact: true });
  const calculate = page.getByRole('button', { name: /^(Calculate schedules|Recalculate)$/ });
  const twin = page.getByRole('region', { name: 'Operational digital twin' });
  const stock = page.getByLabel('Measured water stock (simulated input)', { exact: false });
  const quota = page.getByLabel('Remaining quota', { exact: false }).first();
  const shown = (locator) => locator.waitFor({ state: 'visible' });

  async function solve() {
    const replayPending = page.waitForResponse(r => hits(r, '/api/telemetry/replay'));
    const comparisonPending = page.waitForResponse(r => hits(r, '/api/compare'));
    await calculate.click();
    const [comparison, replay] = await Promise.all([comparisonPending, replayPending]);
    assert.equal(comparison.status(), 200);
    assert.equal(replay.status(), 200);
    await shown(twin.getByRole('slider', { name: 'Simulation timeline' }));
    return { result: await comparison.json(), frames: (await replay.json()).frames };
  }

  const presetIds = ['normal', 'mini', 'announced', 'successive', 'jplus1', 'jplus1-stable'];
  await shown(scenario);
  assert.deepEqual((await scenario.locator('option').evaluateAll(options => options.map(option => option.value))).sort(), [...presetIds].sort());
  for (const id of presetIds) {
    await scenario.selectOption(id);
    const { result, frames } = await solve();
    const proposed = result.weather_comparison?.buffer_on_adverse ?? result.optimized;
    assert.equal(frames.length, proposed.actions.length, id);
    for (const [index, frame] of frames.entries()) {
      const action = proposed.actions[index];
      assert.equal(frame.slot, action.slot, id);
      assert.equal(frame.pump_m3, action.pump_m3, id);
      assert.equal(frame.tank_stock_m3, action.tank_stock_m3, id);
      assert.equal(frame.quota_remaining_m3, action.quota_remaining_m3, id);
      assert.ok(frame.tank_stock_m3 >= 0 && frame.tank_stock_m3 <= frame.tank_capacity_m3, id);
      assert.ok(frame.quota_remaining_m3 >= 0, id);
      if (!frame.grid_available) {
        assert.equal(frame.grid_wh, 0, id);
        assert.equal(frame.pump_m3, 0, id);
      }
    }
    if (id === 'jplus1' || id === 'jplus1-stable') {
      const { early_pump_m3, remaining_deficit_m3 } = result.weather_comparison;
      assert.equal(early_pump_m3, id === 'jplus1' ? 2 : 0);
      assert.equal(remaining_deficit_m3, 0);
      await shown(page.getByRole('heading', { name: id === 'jplus1' ? 'Pump 2 m³ before 11:00' : 'No early pumping needed', exact: true }));
    }
    console.log(`Preset ${id} passed comparison and physical replay.`);
  }

  await scenario.selectOption('mini');
  await stock.fill('-1');
  await calculate.click();
  await shown(page.getByRole('alert').getByText('Correct the highlighted inputs.'));
  assert.equal(await stock.getAttribute('aria-invalid'), 'true');
  await stock.fill('0');
  const empty = await solve();
  assert.equal(empty.result.optimized.metrics.delivered_on_time_m3, 0);
  assert.ok(empty.frames.every(frame => frame.tank_stock_m3 === 0 && frame.quota_remaining_m3 === 0));

  await page.route('**/api/compare', route => route.fulfill({ status: 503 }), { times: 1 });
  await calculate.click();
  await shown(page.getByRole('alert').getByText(/Service unavailable/));
  assert.equal(await page.getByRole('button', { name: 'Approve simulated plan' }).isDisabled(), true);
  await solve();
  assert.equal(await page.getByRole('alert').count(), 0);

  await page.route('**/api/telemetry/replay', route => route.fulfill({ status: 503 }), { times: 1 });
  await twin.getByRole('button', { name: 'Fixed schedule' }).click();
  const retry = twin.getByRole('button', { name: 'Retry replay' });
  await shown(retry);
  await retry.click();
  await shown(twin.getByRole('slider', { name: 'Simulation timeline' }));
  await retry.waitFor({ state: 'detached' });
  console.log('Invalid stock, empty reservoir, failed comparison and replay retry passed.');

  await scenario.selectOption('normal');
  const uninterrupted = await solve();
  await page.getByText('Operating constraints and incidents', { exact: true }).click();
  await page.getByLabel('Unexpected incident').selectOption('unexpected_outage');
  await page.getByLabel('Incident starts').selectOption('9');
  await page.getByLabel('Incident duration').selectOption('3');
  const recovery = await solve();
  assert.equal(recovery.result.incident_checkpoint.current_slot, 9);
  assert.deepEqual(recovery.frames.filter(frame => frame.slot < 9),
    uninterrupted.frames.filter(frame => frame.slot < 9));
  for (const frame of recovery.frames.filter(frame => frame.slot >= 9 && frame.slot < 12)) {
    assert.equal(frame.grid_available, false);
    assert.equal(frame.pump_m3, 0);
  }
  await shown(page.getByRole('heading', { name: 'Recovery from unexpected outage' }));
  console.log('Unexpected grid outage preserved completed actions and stopped pumping during the incident.');

  await scenario.selectOption('jplus1');
  await quota.fill('5');
  const limited = await solve();
  assert.equal(limited.result.weather_comparison.early_pump_m3, 0);
  assert.equal(limited.result.weather_comparison.remaining_deficit_m3, 2);
  await shown(page.getByText('Remaining shortfall 2 m³', { exact: true }));
  await shown(page.getByRole('heading', { name: 'No early pumping scheduled · shortfall remains', exact: true }));
  assert.deepEqual(errors, []);
  console.log('Quota-limited weather decision correctly exposes the unsatisfied target.');
} finally {
  await browser.close();
}
