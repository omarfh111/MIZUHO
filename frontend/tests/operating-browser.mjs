import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
url.searchParams.set('intro', '0');
url.hash = 'simulation';
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  for (const width of [1360, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const calculate = async (button) => {
      const pending = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/compare');
      await page.getByRole('button', { name: button, exact: true }).click();
      const response = await pending;
      assert.equal(response.status(), 200);
      return { request: response.request().postDataJSON(), result: await response.json() };
    };
    await page.goto(url.href);
    await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('mini');
    const initial = await calculate('Calculate schedules');
    await page.getByRole('button', { name: 'Approve simulated plan' }).click();
    await page.getByText(/Simulated plan approved/).waitFor();
    await page.getByText('Operating constraints and incidents', { exact: true }).click();
    await page.getByText(/24 reported hours · Peak irradiance 1133 W\/m²/).waitFor();
    await page.getByLabel('Bouhertma station archive').fill('2000-01-01');
    await page.getByText(/No observations on this date/).waitFor();
    await page.getByLabel('Unexpected incident').selectOption('pump_shutdown');
    await page.getByLabel('Incident starts').selectOption('2');
    await page.getByText(/Result out of date/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Approve simulated plan' }).isDisabled(), true);
    const recovery = await calculate('Recalculate');
    assert.deepEqual(recovery.request.incident.previous_actions,
      initial.result.optimized.actions.map(({ slot, deliveries, pump_m3 }) => ({ slot, deliveries, pump_m3 })));
    assert.equal(recovery.result.incident_checkpoint.tank_stock_m3, 5);
    await page.getByRole('heading', { name: 'Recovery from pump shutdown' }).waitFor();
    await page.getByLabel('Unexpected incident').selectOption('none');
    await page.getByLabel('Pump power ceiling (W)').fill('0');
    await page.getByLabel('Gravity-fed distribution').selectOption('false');
    await page.getByLabel('Plot A demand (m³)').fill('15');
    const closed = await calculate('Recalculate');
    assert.deepEqual(closed.request.overrides, { pump_power_cap_w: 0, gravity_available: false, demand_by_plot_m3: { A: 15 } });
    for (const plan of [closed.result.baseline, closed.result.optimized]) {
      assert.equal(plan.metrics.delivered_on_time_m3, 0);
      assert.equal(plan.metrics.tank_stock_m3, 10);
    }
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Unserved demand' }) }).getByText('25 m³', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Desktop and mobile passed station archive, approved-plan invalidation, immutable incident replay, pump power, gravity and demand edits.');
} finally {
  await browser.close();
}
