import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
url.searchParams.set('intro', '0');
url.hash = 'map';
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

async function useWeatherEstimate(page, sector, id, day) {
  await page.getByText('Estimate sector demand from weather', { exact: true }).click();
  const form = page.getByRole('form', { name: 'Weather-based demand estimator' });
  await form.getByRole('combobox', { name: 'Target sector' }).selectOption(sector);
  const assumptions = { area_m2: 1050, crop_coefficient: 1.12, effective_rain_fraction: 0.4, application_efficiency: 0.78 };
  for (const [label, key] of [['Irrigated area', 'area_m2'], ['Crop coefficient', 'crop_coefficient'],
    ['Effective share', 'effective_rain_fraction'], ['Application efficiency', 'application_efficiency']]) {
    await form.getByRole('spinbutton', { name: new RegExp(label) }).fill(String(assumptions[key]));
  }
  const responsePromise = page.waitForResponse(r => r.url().endsWith(`/api/sites/${id}/demand-estimate`) && r.request().method() === 'POST');
  await form.getByRole('button', { name: 'Estimate daily demand' }).click();
  const response = await responsePromise;
  assert.equal(response.ok(), true);
  const estimate = await response.json();
  assert.equal(estimate.date, day);
  assert.equal(estimate.demand_m3, Math.ceil(estimate.gross_demand_m3));
  assert.ok(Math.abs(estimate.effective_rain_mm - estimate.precipitation_mm * assumptions.effective_rain_fraction) < .001);
  await form.getByRole('button', { name: `Use for ${sector} sector` }).click();
  return { amount: estimate.demand_m3, basis: { date: day, ...assumptions } };
}

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url.href);
  const picker = page.getByRole('combobox', { name: 'Agricultural site' });
  await picker.waitFor();
  const ids = ['korba-cap-bon', 'kairouan-chebika', 'gafsa-oasis', 'bizerte-mateur', 'sidi-bouzid-plain', 'sfax-el-hajeb'];
  const heatmaps = new Set();
  const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
  for (const id of ids) {
    if (id === 'korba-cap-bon') {
      await page.route(`**/api/sites/${id}/field-zone`, route => route.fulfill({ status: 503 }), { times: 1 });
    }
    const endpoint = new URL(`/api/sites/${id}/field-zone`, url);
    const expected = await (await page.request.get(endpoint.href)).json();
    await picker.selectOption(id);
    if (id === 'korba-cap-bon') await page.getByRole('button', { name: 'Retry zone' }).click();

    const map = page.getByRole('region', { name: 'Agricultural zone map' });
    const relief = map.locator('figure[data-relief-mode="3d"]');
    await relief.locator('canvas').waitFor();
    assert.equal(await relief.getAttribute('data-surface'), 'satellite');
    await relief.getByText('Proposed station', { exact: true }).waitFor();
    const composite = await map.getByRole('link', { name: 'Sentinel-2 · 2021 composite' }).getAttribute('href');
    const source = new URL(composite);
    assert.equal(source.searchParams.get('LAYERS'), 'esa-worldcover-s2rgbnir-10m-2021-v2_tcc');
    const [w, s, e, n] = expected.relief.bounds;
    assert.deepEqual(source.searchParams.get('BBOX').split(',').map(Number), [s, w, n, e]);
    const canvas = await relief.locator('canvas').elementHandle();
    await relief.getByRole('button', { name: 'Inspect station' }).click();
    assert.equal(await relief.getAttribute('data-model-view'), 'station');
    await relief.getByRole('group', { name: 'Station inspection' }).waitFor();
    assert.equal(await relief.locator('[data-marker="station"]').isVisible(), false);
    await relief.getByRole('button', { name: 'Show entire site' }).click();
    assert.equal(await relief.getAttribute('data-model-view'), 'area');
    await map.getByRole('button', { name: 'Elevation', exact: true }).click();
    assert.equal(await relief.getAttribute('data-surface'), 'elevation');
    assert.equal(await canvas.evaluate(element => element.isConnected), true);
    await map.getByRole('button', { name: 'Land cover', exact: true }).click();
    assert.equal(await relief.getAttribute('data-surface'), 'land-cover');
    await relief.getByRole('button', { name: 'North-up view' }).click();
    const surface = relief.locator('canvas');
    const size = await surface.boundingBox();
    assert.ok(size);
    await surface.click({ position: { x: size.width / 2, y: size.height / 2 } });
    await relief.locator('[data-marker="sample"]').waitFor();
    const total = Object.values(expected.land_cover.pixel_counts).reduce((sum, count) => sum + count);
    const expectedShare = `${number.format(expected.land_cover.pixel_counts['40'] * 100 / total)}%`;
    const crop = page.getByRole('list', { name: 'Land-cover class shares' }).getByRole('listitem').filter({ hasText: /Cropland/ });
    assert.equal(await crop.locator('strong').textContent(), expectedShare);
    heatmaps.add(JSON.stringify(expected.land_cover.classes));
    const climate = page.getByRole('region', { name: 'Climate archive' });
    await climate.getByText(`${number.format(expected.climate.precipitation_mm)} mm`, { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'ESA WorldCover 2021 v200' }).getAttribute('href'), expected.land_cover.source.url);
    await page.getByRole('button', { name: 'Study reference' }).click();
    const evidence = page.getByRole('dialog', { name: 'Data source' });
    await evidence.getByText(expected.evidence.title, { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('region', { name: 'Water management context' }).getByText(expected.missing_inputs[0]).waitFor();
    const inspector = page.getByRole('region', { name: 'Geographic sample' });
    await inspector.getByRole('combobox').selectOption('40');
    await inspector.getByText(/^Cropland · [\d,.]+ m$/).waitFor();
    await map.locator('[data-marker="sample"]').waitFor();
    await page.getByRole('button', { name: 'Model an irrigation plan' }).click();
    const model = page.getByRole('region', { name: 'Regional simulation terrain' });
    await model.getByText('West sector', { exact: true }).waitFor();
    const quota = page.getByRole('spinbutton', { name: 'Withdrawal limit' });
    const stockOnly = page.getByRole('button', { name: 'Use stored water only' });
    assert.equal(await quota.inputValue(), '');
    await stockOnly.click();
    assert.equal(await quota.inputValue(), '0');
    assert.equal(await page.getByRole('spinbutton', { name: 'Initial tank stock' }).inputValue(), '');
    assert.equal(await page.getByRole('spinbutton', { name: /West sector demand/ }).inputValue(), '');
    await page.getByRole('button', { name: 'Load example assumptions' }).click();
    if (id === 'gafsa-oasis') await page.getByRole('button', { name: 'Clear outage hours' }).click();
    const day = id === 'kairouan-chebika' ? '2025-01-15' : '2025-07-15';
    const dateControl = page.getByRole('combobox', { name: 'Irradiation day' });
    await dateControl.selectOption(day);
    if (id === 'korba-cap-bon') {
      const west = page.getByRole('spinbutton', { name: /West sector demand/ });
      const east = page.getByRole('spinbutton', { name: /East sector demand/ });
      const first = await useWeatherEstimate(page, 'west', id, day);
      assert.equal(await west.inputValue(), String(first.amount));
      await dateControl.selectOption('2025-01-15');
      assert.equal(await west.inputValue(), '');
      assert.equal(await east.inputValue(), '24');
      await west.fill('24');
      await dateControl.selectOption(day);
    }
    const derived = await useWeatherEstimate(page, 'east', id, day);
    assert.equal(await page.getByRole('spinbutton', { name: /East sector demand/ }).inputValue(), String(derived.amount));
    const endpointUrl = new URL(`/api/sites/${id}/planning`, url);
    const responsePromise = page.waitForResponse(r => r.url() === endpointUrl.href && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Compare regional plans' }).click();
    const response = await responsePromise;
    assert.equal(response.ok(), true);
    let previousInputs = response.request().postDataJSON();
    if (id === 'gafsa-oasis') assert.deepEqual(previousInputs.outage_hours, []);
    assert.deepEqual(previousInputs.demand_basis, { east: derived.basis });
    assert.equal(previousInputs.demand_east_m3, derived.amount);
    const result = await response.json();
    assert.equal(result.site_id, id);
    assert.equal(result.date, day);
    assert.equal(await page.getByRole('link', { name: 'NASA POWER hourly estimate' }).getAttribute('href'), result.source.url);
    const table = page.getByRole('region', { name: 'Regional plan comparison' });
    const register = page.getByRole('region', { name: 'Daily delivery commitments', exact: true });
    await table.waitFor();
    if (id === 'korba-cap-bon') {
      await table.getByRole('button', { name: 'Approve simulated plan' }).click();
      await table.getByText('Simulated plan approved').waitFor();
      assert.ok(Number.isFinite(Date.parse(await table.locator('time').getAttribute('datetime'))));
      // Isolate the caller contract from live model availability and billing in CI.
      await page.route('**/api/assistant/health', r => r.fulfill({ json: { status: 'available' } }));
      await page.route('**/api/assistant/chat', r => r.fulfill({ status: 503 }));
      await page.getByRole('button', { name: 'Ask Mizhuo', exact: true }).click();
      const assistant = page.getByRole('dialog', { name: 'Mizhuo assistant' });
      const request = page.waitForRequest(r => r.url().endsWith('/api/assistant/chat'));
      await assistant.getByRole('button', { name: 'Why did the two sectors receive these volumes?' }).click();
      const context = (await request).postDataJSON().zone_plan;
      assert.equal(context.comparison_id, result.comparison_id);
      assert.deepEqual(context.inputs.demand_basis, { east: derived.basis });
      await page.keyboard.press('Escape');
    }
    const delivered = table.getByRole('row').filter({ hasText: 'Delivered on time' }).getByRole('cell');
    assert.deepEqual(await delivered.allTextContents(), ['baseline', 'optimized'].map(p =>
      number.format(result.comparison[p].metrics.delivered_on_time_m3)));
    const slider = model.getByRole('slider', { name: 'Regional simulation hour' });
    await slider.press('ArrowRight');
    const slot = Number(await slider.inputValue());
    const regionalRenderer = await model.locator('canvas').elementHandle();
    for (const [p, title] of [['optimized', 'Optimized plan'], ['baseline', 'Fixed turn']]) {
      await model.getByRole('button', { name: title }).click();
      assert.equal(await register.getByRole('combobox', { name: 'Schedule to inspect' }).inputValue(), p);
      for (const plot of result.comparison[p].plot_results) {
        const name = plot.plot_id === 'west' ? 'West sector' : 'East sector';
        const row = register.getByRole('row', { name: new RegExp(`^${name} `) });
        assert.equal(await row.getByRole('cell').nth(2).textContent(), `${number.format(plot.delivered_on_time_m3)} m³`);
      }
      const frame = result.comparison[p].actions[slot];
      const physicalScene = model.locator('figure');
      assert.equal(await physicalScene.getAttribute('data-stock-m3'), String(frame.tank_stock_m3));
      assert.equal(await physicalScene.getAttribute('data-pump-m3'), String(frame.pump_m3));
      assert.equal(await model.locator('canvas').evaluate((canvas, original) => canvas === original, regionalRenderer), true);
      for (const sector of ['west', 'east']) {
        const volume = frame.deliveries.find(d => d.plot_id === sector)?.delivered_m3 ?? 0;
        const label = model.getByText(`${sector === 'west' ? 'West' : 'East'} · ${number.format(volume)} m³`, { exact: true });
        await label.waitFor();
        assert.equal(await label.getAttribute('data-marker'), sector);
      }
    }
    if (id === 'korba-cap-bon') {
      const estimator = page.getByRole('form', { name: 'Weather-based demand estimator' });
      await estimator.getByRole('spinbutton', { name: /Irrigated area/ }).fill('1100');
      assert.equal(await page.getByRole('spinbutton', { name: /East sector demand/ }).inputValue(), '');
      assert.equal(await page.getByRole('spinbutton', { name: /West sector demand/ }).inputValue(), '24');
      assert.equal(await table.count(), 0);
      assert.equal(await page.getByText('Simulated plan approved').count(), 0);
      await estimator.getByRole('button', { name: 'Estimate daily demand' }).click();
      await estimator.getByRole('button', { name: 'Use for east sector' }).click();
      await page.getByRole('button', { name: 'Use manual east demand' }).click();
      await page.getByRole('spinbutton', { name: /East sector demand/ }).fill('12');
      const manualCall = page.waitForResponse(r => r.url() === endpointUrl.href && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Compare regional plans' }).click();
      const manual = await manualCall;
      assert.equal(manual.ok(), true);
      previousInputs = manual.request().postDataJSON();
      assert.equal(previousInputs.demand_basis, undefined);
      assert.equal(previousInputs.demand_east_m3, 12);
      await table.getByRole('button', { name: 'Approve simulated plan' }).waitFor();
    }
    await stockOnly.click();
    assert.equal(await table.count(), 0);
    assert.equal(await register.count(), 0);
    assert.equal(await model.getByRole('slider').count(), 0);
    const [stored] = await Promise.all([
      page.waitForResponse(r => r.url() === endpointUrl.href && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Compare regional plans' }).click(),
    ]);
    assert.equal(stored.status(), 200);
    assert.deepEqual(stored.request().postDataJSON(), { ...previousInputs, withdrawal_limit_m3: 0, outage_hours: [] });
    const storedCase = await stored.json();
    assert.equal(storedCase.site_id, id);
    await register.getByRole('table').waitFor();
    for (const plan of [storedCase.comparison.baseline, storedCase.comparison.optimized]) {
      assert.equal(plan.metrics.withdrawn_m3, 0);
      assert.equal(plan.metrics.grid_wh, 0);
      assert.ok(plan.metrics.delivered_on_time_m3 > 0 && plan.metrics.delivered_on_time_m3 <= previousInputs.initial_stock_m3);
    }
    await page.getByRole('button', { name: 'Back to map', exact: true }).click();
  }
  assert.equal(heatmaps.size, ids.length);
  await picker.selectOption('jendouba-pilote');
  await page.getByRole('button', { name: 'Open simulation' }).click();
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).waitFor();
  assert.deepEqual(errors, []);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type.startsWith('webgl') ? null : original.call(this, type, ...args);
    };
  });
  await mobile.goto(url.href);
  await mobile.getByRole('combobox', { name: 'Agricultural site' }).selectOption(ids[0]);
  await mobile.getByRole('img', { name: /North-up satellite composite/ }).waitFor();
  await mobile.getByRole('button', { name: 'Land cover', exact: true }).click();
  await mobile.getByRole('img', { name: /North-up land-cover map/ }).waitFor();
  await mobile.getByRole('button', { name: 'Elevation', exact: true }).click();
  await mobile.getByRole('img', { name: /North-up elevation grid/ }).waitFor();
  await mobile.getByRole('img', { name: /North-up elevation grid/ }).tap();
  await mobile.locator('[data-marker="sample"]').waitFor();
  await mobile.getByRole('combobox', { name: 'Inspect mapped land cover' }).selectOption('80');
  await mobile.getByText(/^Permanent water · [\d,.]+ m$/).waitFor();
  await mobile.route(`**/api/sites/${ids[0]}/planning`, async route => {
    const upstream = await route.fetch();
    const context = await upstream.json();
    context.days.forEach(day => { day.weather = null; });
    await route.fulfill({ response: upstream, json: context });
  }, { times: 1 });
  await mobile.getByRole('button', { name: 'Model an irrigation plan' }).click();
  await mobile.getByRole('img', { name: /North-up satellite composite/ }).waitFor();
  await mobile.locator('[data-marker="east"]').waitFor();
  await mobile.getByText('A verified daily reference ET₀ and rainfall pair is unavailable.', { exact: false }).waitFor();
  assert.equal(await mobile.getByText('Estimate sector demand from weather', { exact: true }).count(), 0);
  assert.ok(await mobile.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth));
  console.log('Desktop and mobile passed regional layers, source inspection, hourly planning, map deliveries and invalidation.');
} finally {
  await browser.close();
}
