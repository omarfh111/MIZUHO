import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
url.searchParams.set('intro', '0');
url.hash = 'tunisia';
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

function cityResponse(page, id) {
  return page.waitForResponse(response => new URL(response.url()).pathname === `/api/tunisia/cities/${id}`);
}

function shiftDay(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const map = page => page.getByRole('group', { name: 'Interactive map of Tunisia' });
const directory = page => page.getByRole('complementary', { name: 'City directory' });
const analysis = (page, name) => page.getByRole('region', { name: `${name} analysis` });
const relief = (page, name) => analysis(page, name).getByRole('figure', { name: `Elevation around ${name}` });

async function checkClimate(page, name, profile) {
  const section = analysis(page, name).getByRole('region', { name: 'Climate summary' });
  assert.ok(profile.climate, `${name} has a climate archive`);
  await section.getByText(`${number.format(profile.climate.temperature_mean_c)} °C`, { exact: true }).waitFor();
  await section.getByText(`${number.format(profile.climate.precipitation_mm)} mm`, { exact: true }).waitFor();
  const citation = section.getByRole('link', { name: profile.climate.source.name, exact: true });
  assert.equal(await citation.getAttribute('href'), profile.climate.source.url);
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1360, height: 900 }, reducedMotion: 'no-preference' });
  const errors = [];
  desktop.on('pageerror', error => errors.push(error.message));
  let nationalRequests = 0;
  desktop.on('request', request => {
    if (new URL(request.url()).pathname === '/api/tunisia') nationalRequests++;
  });
  // Obtain the expected catalogue independently of any in-flight request the dashboard may cancel.
  const source = await desktop.request.get(new URL('/api/tunisia', url).href);
  assert.equal(source.status(), 200);
  const catalogue = await source.json();
  await desktop.goto(url.href);
  await desktop.getByRole('heading', { name: 'Explore Tunisia', level: 1 }).waitFor();
  await directory(desktop).waitFor();
  assert.ok(nationalRequests > 0, 'The dashboard requested the national catalogue');
  assert.ok(catalogue.cities.length >= 24);
  assert.equal(await directory(desktop).getByRole('button', { name: /^View / }).count(), catalogue.cities.length);
  assert.equal(await map(desktop).getAttribute('data-view'), 'country');
  const tunis = catalogue.cities.find(city => city.name === 'Tunis');
  const jendouba = catalogue.cities.find(city => city.name === 'Jendouba');
  assert.ok(tunis && jendouba);

  const marker = map(desktop).getByRole('button', { name: 'Explore Tunis', exact: true });
  const beforeZoom = await marker.boundingBox();
  const response = cityResponse(desktop, tunis.id);
  await marker.click();
  await desktop.locator('.tn-map[data-zooming="true"]').waitFor();
  await desktop.locator('.tn-map[data-zooming="true"]').waitFor({ state: 'detached' });
  assert.equal(await map(desktop).getAttribute('data-view'), 'city');
  const afterZoom = await marker.boundingBox();
  const atlas = await map(desktop).boundingBox();
  assert.ok(beforeZoom && afterZoom && atlas);
  assert.ok(Math.hypot(beforeZoom.x - afterZoom.x, beforeZoom.y - afterZoom.y) > 40);
  assert.ok(Math.abs(afterZoom.y + afterZoom.height / 2 - atlas.y - atlas.height / 2) < 3);
  const tunisProfile = await (await response).json();
  await checkClimate(desktop, tunis.name, tunisProfile);

  const visual = relief(desktop, tunis.name);
  await visual.locator('canvas').waitFor();
  assert.equal(await visual.getAttribute('data-relief-mode'), '3d');
  const terrainProof = analysis(desktop, tunis.name).getByRole('region', { name: 'Terrain' });
  await terrainProof.getByText('Original data and checksum', { exact: true }).click();
  assert.equal(await terrainProof.getByRole('link', { name: 'Original terrain tile 1' }).getAttribute('href'), tunisProfile.relief.source.assets[0]);
  const surface = await visual.locator('canvas').elementHandle();
  const tunisRange = [await visual.getByTestId('relief-low').textContent(), await visual.getByTestId('relief-high').textContent()];
  await visual.getByRole('button', { name: 'Rotate left' }).click();
  await visual.getByRole('button', { name: 'Reset relief view' }).click();

  const start = tunisProfile.climate.start;
  const end = shiftDay(start, 29);
  assert.ok(end < tunisProfile.climate.end);
  const tunisAnalysis = analysis(desktop, tunis.name);
  await tunisAnalysis.getByLabel('End date', { exact: true }).fill(end);
  const filteredResponse = cityResponse(desktop, tunis.id);
  await tunisAnalysis.getByRole('button', { name: 'Apply dates' }).click();
  const filtered = await filteredResponse;
  assert.equal(filtered.status(), 200);
  const applied = new URL(filtered.url()).searchParams;
  assert.equal(applied.get('start'), start);
  assert.equal(applied.get('end'), end);
  const seasonal = await filtered.json();
  assert.ok(seasonal.climate && seasonal.climate.days <= 30);
  assert.notEqual(seasonal.climate.temperature_mean_c, tunisProfile.climate.temperature_mean_c);
  await checkClimate(desktop, tunis.name, seasonal);
  assert.equal(await visual.locator('canvas').evaluate((element, original) => element === original, surface), true);
  await tunisAnalysis.getByRole('button', { name: 'Full archive' }).click();
  await checkClimate(desktop, tunis.name, tunisProfile);

  await desktop.route(`**/api/tunisia/cities/${jendouba.id}`, route => route.fulfill({ status: 503 }), { times: 1 });
  const search = directory(desktop).getByRole('searchbox', { name: 'Search cities' });
  await search.fill('jendouba');
  assert.equal(await directory(desktop).getByRole('button', { name: /^View / }).count(), 1);
  await directory(desktop).getByRole('button', { name: 'View Jendouba' }).press('Enter');
  const north = analysis(desktop, jendouba.name);
  await north.getByRole('alert').waitFor();
  assert.equal(await tunisAnalysis.count(), 0);
  const recovered = cityResponse(desktop, jendouba.id);
  await north.getByRole('button', { name: 'Retry city data' }).click();
  const jendoubaProfile = await (await recovered).json();
  await checkClimate(desktop, jendouba.name, jendoubaProfile);
  const northRelief = relief(desktop, jendouba.name);
  await northRelief.locator('canvas').waitFor();
  const northRange = [await northRelief.getByTestId('relief-low').textContent(), await northRelief.getByTestId('relief-high').textContent()];
  assert.notDeepEqual(tunisRange, northRange);
  assert.notDeepEqual(tunisProfile.relief.elevations, jendoubaProfile.relief.elevations);
  await north.getByRole('button', { name: 'Open simulated Jendouba pilot' }).click();
  const beforeReturning = nationalRequests;
  await desktop.waitForURL(current => current.hash === '#map');
  assert.equal(new URL(desktop.url()).searchParams.get('city'), jendouba.id);
  assert.equal(await desktop.getByRole('combobox', { name: 'Agricultural site' }).inputValue(), 'jendouba-pilote');
  await desktop.getByRole('link', { name: 'Tunisia', exact: true }).click();
  await analysis(desktop, jendouba.name).waitFor();
  assert.equal(nationalRequests, beforeReturning, 'Returning to the map reuses its decoded boundaries');
  await desktop.reload();
  await checkClimate(desktop, jendouba.name, jendoubaProfile);
  assert.ok(nationalRequests > beforeReturning, 'A full reload obtains fresh cartography');
  await desktop.getByRole('button', { name: 'Back to Tunisia' }).click();
  assert.equal(await map(desktop).getAttribute('data-view'), 'country');
  assert.equal(new URL(desktop.url()).searchParams.has('city'), false);
  assert.deepEqual(errors, []);
  await desktop.close();

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
  });
  await mobile.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type.startsWith('webgl') ? null : original.call(this, type, ...args);
    };
  });
  await mobile.route('**/api/tunisia', route => route.fulfill({ status: 503 }), { times: 1 });
  await mobile.goto(url.href);
  await mobile.getByRole('button', { name: 'Retry map' }).tap();
  const markerSouth = map(mobile).getByRole('button', { name: 'Explore Tataouine', exact: true });
  await markerSouth.tap();
  assert.equal(await map(mobile).getAttribute('data-view'), 'city');
  assert.equal(await map(mobile).getAttribute('data-zooming'), null);
  await relief(mobile, 'Tataouine').getByRole('img', { name: 'North-up elevation grid for Tataouine' }).waitFor();
  assert.equal(await relief(mobile, 'Tataouine').getAttribute('data-relief-mode'), 'raster');
  assert.equal(await mobile.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth), true);
  await mobile.getByRole('button', { name: 'Back to Tunisia' }).tap();
  assert.equal(await map(mobile).getAttribute('data-view'), 'country');
  await mobile.close();

  console.log('Desktop and mobile passed the national city catalogue, map flights, climate dates, distinct terrain, retries, and linked pilot.');
} finally {
  await browser.close();
}
