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
    const page = await browser.newPage({ viewport: { width, height: 880 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const twin = page.getByRole('region', { name: 'Operational digital twin' });
    async function replayAfter(action) {
      const pending = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/telemetry/replay');
      await action();
      const response = await pending;
      assert.equal(response.status(), 200);
      const replay = await response.json();
      await twin.getByLabel('Simulation timeline').waitFor();
      return replay;
    }
    await page.goto(url.href);
    await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('mini');
    const optimized = await replayAfter(() => page.getByRole('button', { name: 'Calculate schedules' }).click());
    assert.deepEqual(optimized.frames.at(-1).parcels.map((p) => p.delivered_on_time_m3), [5,5]);
    const inspect = twin.getByLabel('Inspect equipment or parcel');
    await twin.locator('canvas').waitFor();
    const terrain = await twin.locator('canvas').elementHandle();
    await inspect.selectOption('A');
    assert.equal(await twin.getByTestId('equipment-reading').textContent(), optimized.frames[0].parcels[0].delivered_m3 + ' m³');
    await twin.getByRole('button', { name: 'Play timeline' }).click();
    await page.waitForFunction(() => Number(document.querySelector('input[aria-label="Simulation timeline"]').value) > 0);
    await twin.getByRole('button', { name: 'Restart timeline' }).click();
    const fixed = await replayAfter(() => twin.getByRole('button', { name: 'Fixed schedule' }).click());
    assert.deepEqual(fixed.frames.at(-1).parcels.map((p) => p.delivered_on_time_m3), [10,0]);
    await twin.getByText('Virtual sensors and event injection', { exact: true }).click();
    const missing = await replayAfter(() => twin.getByLabel('Missing flow reading').check());
    assert.deepEqual(missing.frames, fixed.frames);
    await twin.getByRole('row').filter({ hasText: 'pumped_flow' }).getByRole('cell', { name: 'Missing', exact: true }).first().waitFor();
    const imbalance = await replayAfter(() => twin.getByLabel('Water-balance discrepancy').check());
    assert.deepEqual(imbalance.frames, fixed.frames);
    assert.equal(await terrain.evaluate((canvas) => canvas.isConnected), true);
    assert.ok(imbalance.alerts.some((a) => a.type === 'unexplained_water'));
    await twin.getByText(/Unexplained water balance/).waitFor();
    await twin.getByText('Day-ahead load forecast', { exact: true }).click();
    await twin.getByText(/Held-out mean absolute error/).waitFor();
    await page.getByLabel(/Measured water stock/).fill('9');
    await twin.waitFor({ state: 'detached' });
    await page.getByText(/Result out of date/).waitFor();
    if (width > 700) {
      await page.getByRole('link', { name: 'Site map', exact: true }).click();
      await page.getByRole('button', { name: 'Compare solar options' }).click();
      const solar = page.getByRole('dialog', { name: 'Compare solar options' });
      const archiveResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/solar/compare-archive');
      await solar.getByLabel('Production source').selectOption('archive');
      assert.equal((await archiveResponse).status(), 200);
      await solar.getByRole('button', { name: 'Use in simulation' }).click();
      const calculate = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/compare');
      await page.getByRole('button', { name: 'Recalculate' }).click();
      const result = await calculate;
      assert.equal(result.status(), 200);
      assert.equal(result.request().postDataJSON().overrides.pvgis_option_id, 'toiture');
      assert.equal(result.request().postDataJSON().solar_option_id, null);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Desktop and mobile passed M4 replay, fixed and optimized allocation, playback, missing readings, sensor anomaly, load forecast and stale-result invalidation.');
} finally {
  await browser.close();
}
