import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = new URL(process.env.MIZHUO_TEST_URL || 'http://127.0.0.1:5173/');
url.searchParams.set('intro', '0');
const surveyId = 'TN-32-BALTABOUAWENE-ASSILA';
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  for (const viewport of [{ width: 1370, height: 900 }, { width: 390, height: 840 }]) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url.href);
    const selector = page.getByRole('combobox', { name: 'Pilot site' });
    if (viewport.width > 1000) {
      await page.route(`**/api/layers/${surveyId}/wapor`, route => route.fulfill({ status: 503 }));
    }
    await selector.selectOption(surveyId);
    const panel = page.getByRole('region', { name: 'Agricultural survey' });
    await panel.getByRole('link', { name: 'P-05' }).waitFor();
    assert.equal(await panel.locator('tbody tr').count(), 5);
    const dataset = await (await page.request.get(new URL(`/api/sites/${surveyId}/agriculture`, url).href)).json();
    const selected = dataset.parcels.find(p => p.plot_id === 'P-01');
    if (viewport.width > 1000) {
      const retry = page.getByRole('button', { name: 'Retry WaPOR water use' });
      await retry.waitFor();
      await page.unroute(`**/api/layers/${surveyId}/wapor`);
      await retry.click();
    }
    const toggle = page.getByRole('switch', { name: 'WaPOR water use' });
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    await page.getByText('AETI · 0–6 mm/day').waitFor();
    await page.getByRole('combobox', { name: 'Inspect an area' }).selectOption({ label: 'Parcel P-01' });
    const cell = panel.getByRole('cell', { name: `${selected.eta_mm_day} mm/day`, exact: true });
    await cell.waitFor();
    assert.equal(await panel.locator('tbody tr').count(), 1);
    assert.equal(await panel.getByRole('link', { name: 'P-01' }).getAttribute('href'),
      `https://www.openstreetmap.org/way/${selected.osm_way_id}`);
    assert.equal(await page.getByRole('button', { name: 'Open simulation' }).isDisabled(), true);
    await panel.getByRole('button', { name: 'WaPOR source' }).click();
    const source = page.getByRole('dialog', { name: 'Data source' });
    await source.getByText('FAO WaPOR v3 L2-AETI-D 2026-07-D2').waitFor();
    await source.getByRole('button', { name: 'Close' }).click();
    await selector.selectOption('jendouba-pilote');
    await page.getByRole('button', { name: 'Open simulation' }).click();
    await page.getByRole('combobox', { name: 'Scenario' }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Agricultural survey, raster controls, provenance and site isolation passed on desktop and mobile.');
} finally {
  await browser.close();
}
