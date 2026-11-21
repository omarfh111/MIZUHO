import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
url.searchParams.set('intro', '0');
url.hash = 'map';
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url.href);
  const picker = page.getByRole('combobox', { name: 'Pilot site' });
  await picker.waitFor();
  const ids = ['korba-cap-bon', 'kairouan-chebika', 'gafsa-oasis'];
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
    assert.equal(await relief.getAttribute('data-surface'), 'land-cover');
    const canvas = await relief.locator('canvas').elementHandle();
    await map.getByRole('button', { name: 'Elevation', exact: true }).click();
    assert.equal(await relief.getAttribute('data-surface'), 'elevation');
    assert.equal(await canvas.evaluate(element => element.isConnected), true);
    await map.getByRole('button', { name: 'Land cover', exact: true }).click();
    await relief.getByRole('button', { name: 'North-up view' }).click();
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
    assert.equal(await page.getByRole('button', { name: 'Open simulation' }).count(), 0);
  }
  assert.equal(heatmaps.size, ids.length);
  await picker.selectOption('jendouba-pilote');
  await page.getByRole('button', { name: 'Open simulation' }).click();
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).waitFor();
  assert.deepEqual(errors, []);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await mobile.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type.startsWith('webgl') ? null : original.call(this, type, ...args);
    };
  });
  await mobile.goto(url.href);
  await mobile.getByRole('combobox', { name: 'Pilot site' }).selectOption(ids[0]);
  await mobile.getByRole('img', { name: /North-up land-cover map/ }).waitFor();
  await mobile.getByRole('button', { name: 'Elevation', exact: true }).click();
  await mobile.getByRole('img', { name: /North-up elevation grid/ }).waitFor();
  assert.ok(await mobile.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth));
  console.log('Desktop and mobile passed all three researched zone layers, local provenance, recovery, and the planning pilot.');
} finally {
  await browser.close();
}
