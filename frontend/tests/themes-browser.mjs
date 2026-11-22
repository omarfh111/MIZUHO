import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
url.searchParams.set('intro', '0');
url.hash = 'energy';
const browser = await chromium.launch(process.env.MIZHUO_CHROME_PATH
  ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' });

async function checkCityOnlyLinks(page) {
  const atlas = await page.request.get(new URL('/api/tunisia', url).href);
  assert.equal(atlas.status(), 200);
  const { cities } = await atlas.json();
  const picker = page.getByRole('combobox', { name: 'Agricultural site' });
  const link = new URL(url);
  link.searchParams.delete('site');
  link.hash = 'simulation';
  link.searchParams.set('city', cities.find(city => city.name === 'Tozeur').id);
  await page.route('**/api/tunisia', route => route.fulfill({ status: 503 }), { times: 1 });
  await page.goto(link.href);
  await page.getByRole('button', { name: 'Retry city lookup' }).click();
  await page.getByText(/leave the Tozeur city profile/).waitFor();
  assert.equal(await picker.inputValue(), '');
  assert.equal(await page.getByRole('combobox', { name: 'Scenario', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Ask Mizhuo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mizhuo assistant' });
  await dialog.getByText('Tozeur', { exact: true }).waitFor();
  await dialog.getByText('City archive and evidence').waitFor();
  await page.keyboard.press('Escape');

  for (const [cityName, site] of [['Nabeul', 'korba-cap-bon'], ['Kairouan', 'kairouan-chebika'], ['Gafsa', 'gafsa-oasis']]) {
    link.searchParams.set('city', cities.find(city => city.name === cityName).id);
    await page.goto(link.href);
    await page.getByRole('heading', { name: 'Set planning assumptions' }).waitFor();
    assert.equal(await picker.inputValue(), site);
    assert.equal(new URL(page.url()).searchParams.get('site'), site);
  }
}
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(url.href);
    const themes = page.getByRole('navigation', { name: 'Main navigation' });
    assert.deepEqual((await themes.getByRole('link').allTextContents()).map(text => text.trim()),
      ['Land & agriculture', 'Water & energy', 'Irrigation planning']);
    await page.getByText(/24 reported hours · Peak irradiance 1133/).waitFor();
    await page.getByRole('button', { name: 'Compare solar options' }).click();
    const modal = page.getByRole('dialog', { name: 'Compare solar options' });
    assert.equal(await modal.getByLabel('Production source').inputValue(), 'archive');
    await modal.getByRole('button', { name: /Solar canopy/ }).waitFor();
    await page.keyboard.press('Escape');
    const picker = page.getByRole('combobox', { name: 'Agricultural site' });
    await picker.selectOption('TN-32-BALTABOUAWENE-ASSILA');
    await page.getByRole('region', { name: 'Agricultural survey' }).waitFor();
    assert.equal(await page.getByLabel('Bouhertma station archive').count(), 0);
    await themes.getByRole('link', { name: 'Irrigation planning' }).click();
    await page.getByRole('heading', { name: 'Planning inputs unavailable' }).waitFor();
    await picker.selectOption('gafsa-oasis');
    await page.getByRole('link', { name: 'Water & energy' }).click();
    const profile = await (await page.request.get(new URL('/api/sites/gafsa-oasis/field-zone', url).href)).json();
    const expected = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(profile.climate.precipitation_mm);
    await page.getByText(`${expected} mm`, { exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Regional water and sunlight' }).waitFor();
    assert.equal(await picker.inputValue(), 'gafsa-oasis');
    const compare = page.locator('details.zone-comparison');
    await page.route('**/api/sites/korba-cap-bon/field-zone', route => route.fulfill({ status: 503 }), { times: 1 });
    await compare.locator('summary').click();
    await compare.getByText('Archive unavailable', { exact: true }).waitFor();
    await compare.getByRole('button', { name: 'Retry missing archives' }).click();
    await compare.getByText('Archive unavailable', { exact: true }).waitFor({ state: 'detached' });
    for (const key of ['rain', 'sun']) {
      await compare.getByLabel('Order study areas by').selectOption(key);
      const col = key === 'rain' ? 0 : 1;
      const values = await compare.locator('tbody tr').evaluateAll((rows, col) =>
        rows.map(row => parseFloat(row.querySelectorAll('td')[col].textContent.replaceAll(',', ''))), col);
      assert.equal(values.length, 6);
      assert.deepEqual(values, [...values].sort((a, b) => col === 0 ? a - b : b - a));
    }
    await themes.getByRole('link', { name: 'Land & agriculture' }).click();
    await page.getByRole('button', { name: 'View Tozeur', exact: true }).click();
    const civic = page.locator('.civic-continuity:visible');
    await civic.locator('summary').first().click();
    await civic.getByRole('button', { name: 'Load example circuit' }).click();
    const solve = civic.getByRole('button', { name: 'Calculate household continuity' });
    await page.route('**/api/resilience/households', route => route.fulfill({ status: 503 }), { times: 1 });
    await solve.click();
    await civic.getByRole('alert').waitFor();
    await solve.click();
    await civic.getByRole('heading', { name: 'First shortfall after 2 h 0 min' }).waitFor();
    await civic.getByLabel('Island-capable output limit (W)', { exact: true }).fill('0');
    assert.equal(await civic.getByRole('region', { name: 'Simulated household continuity' }).count(), 0);
    await solve.click();
    await civic.getByRole('heading', { name: 'First shortfall after 0 h 0 min' }).waitFor();
    await themes.getByRole('link', { name: 'Irrigation planning' }).click();
    await page.getByRole('heading', { name: 'Choose a field site' }).waitFor();
    assert.equal(await picker.inputValue(), '');
    await page.reload();
    await page.getByRole('heading', { name: 'Choose a field site' }).waitFor();
    if (width === 1440) await checkCityOnlyLinks(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Passed three-theme navigation, station and solar provenance, household backup, deep links, and site isolation on desktop and mobile.');
} finally {
  await browser.close();
}
