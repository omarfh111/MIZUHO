import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
url.searchParams.set('intro', '0');
url.searchParams.set('site', 'jendouba-pilote');
url.hash = 'simulation';
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const responseFor = (page, path) => page.waitForResponse(reply =>
  reply.request().method() === 'POST' && new URL(reply.url()).pathname === path);

async function stockOnly(page) {
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('normal');
  const outage = page.getByRole('button', { name: 'H11 · outage', exact: true });
  await outage.click();
  assert.equal(await outage.getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Use stored water only' }).click();
  assert.equal(await outage.getAttribute('aria-pressed'), 'false');
  const [reply] = await Promise.all([responseFor(page, '/api/compare'), page.getByRole('button', { name: /^(Calculate schedules|Recalculate)$/ }).click()]);
  assert.equal(reply.status(), 200);
  const input = reply.request().postDataJSON();
  assert.equal(input.state.tank_stock_m3, 12);
  assert.equal(input.state.quota_remaining_m3, 0);
  assert.deepEqual(input.outage_slots, []);
  assert.equal(input.incident ?? null, null);
  const { baseline, optimized } = await reply.json();
  assert.equal(baseline.metrics.worst_coverage_bp, 0);
  assert.equal(optimized.metrics.worst_coverage_bp, 2000);
  assert.equal(optimized.metrics.delivered_on_time_m3, 12);
  assert.equal(optimized.metrics.withdrawn_m3, 0);
  assert.equal(optimized.metrics.grid_wh, 0);
  const register = page.getByRole('region', { name: 'Daily delivery commitments', exact: true });
  await register.getByRole('table').waitFor();
  for (const parcel of optimized.plot_results) {
    const row = register.getByRole('row').filter({ has: page.getByRole('rowheader', { name: `Plot ${parcel.plot_id}`, exact: true }) });
    const cells = await row.getByRole('cell').allTextContents();
    assert.deepEqual(cells.slice(1, 4), [parcel.minimum_m3, parcel.delivered_on_time_m3,
      Math.max(0, parcel.minimum_m3 - parcel.delivered_on_time_m3)].map(n => `${n} m³`));
  }
}

async function rotation(page) {
  await page.getByText('Compare your own rotation', { exact: true }).click();
  await page.getByLabel('Hour 1', { exact: true }).selectOption('9');
  await page.getByLabel('Pump requested (m³) 1', { exact: true }).fill('8');
  await page.getByLabel('Parcel 1', { exact: true }).selectOption('A');
  await page.getByLabel('Delivery requested (m³) 1', { exact: true }).fill('20');
  const [reply] = await Promise.all([responseFor(page, '/api/sites/jendouba-pilote/operator-rotation'),
    page.getByRole('button', { name: 'Replay rotation' }).click()]);
  assert.equal(reply.status(), 200);
  const request = reply.request().postDataJSON();
  assert.equal(request.plan.state.quota_remaining_m3, 0);
  assert.deepEqual(request.hours, [{ hour: 9, pump_m3: 8, plot_id: 'A', delivery_m3: 20 }]);
  const data = await reply.json();
  const hour = data.hours[0];
  assert.equal(hour.feasible_pump_m3, 0);
  assert.ok(hour.feasible_delivery_m3 > 0 && hour.feasible_delivery_m3 <= 12);
  const replay = page.getByRole('region', { name: 'Rotation replay results' });
  await replay.getByRole('heading', { name: 'Simulated daily service' }).waitFor();
  const row = replay.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '09:00 · A' }) });
  assert.deepEqual(await row.getByRole('cell').allTextContents(), [`8 → ${hour.feasible_pump_m3}`, `20 → ${hour.feasible_delivery_m3}`]);
  const totals = replay.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Delivered on time' }) });
  assert.deepEqual(await totals.getByRole('cell').allTextContents(), [data.operator, data.optimized].map(p => `${p.metrics.delivered_on_time_m3} m³`));
  await page.getByLabel('Delivery requested (m³) 1', { exact: true }).fill('10');
  await replay.waitFor({ state: 'detached' });
}

const header = 'date,parcel_id,last_slot,minimum_m3,by_deadline_m3,by_day_end_m3';
const marker = 'audit-private-a94x';
const csv = (rows) => ({ name: 'test-deliveries.csv', mimeType: 'text/csv', buffer: Buffer.from([header, ...rows].join('\n')) });

async function fieldDay(page) {
  const summary = page.getByText('Check a recorded delivery day', { exact: true });
  await summary.click();
  const chooser = page.getByLabel('Recorded delivery CSV');
  const results = page.getByRole('region', { name: 'Recorded delivery results' });
  const valid = csv([`2025-07-15,${marker},11,10,0,12`, '2025-07-15,sector-b,12,5,,5']);
  await chooser.setInputFiles(valid);
  await results.getByText('0 of 1 assessed commitments met on time.').waitFor();
  assert.match(await results.innerText(), /Deadline readings cover 1 of 2 parcels/);
  const row = id => results.getByRole('row').filter({ has: page.getByRole('rowheader', { name: id, exact: true }) }).getByRole('cell');
  assert.deepEqual(await row(marker).allTextContents(), ['11:00', '10 m³', '0 m³', '12 m³', '10 m³']);
  assert.deepEqual(await row('sector-b').allTextContents(), ['12:00', '5 m³', 'Unknown', '5 m³', 'Unknown']);
  await chooser.setInputFiles(csv([`2025-07-15,${marker},11,10,5,1`]));
  await page.getByRole('alert').filter({ hasText: /day-end delivery cannot be less/ }).waitFor();
  assert.equal(await results.count(), 0);
  await chooser.setInputFiles(valid);
  await results.waitFor();
  await page.getByRole('button', { name: 'Clear recorded day' }).click();
  await results.waitFor({ state: 'detached' });
  await chooser.setInputFiles(valid);
  await results.waitFor();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('link', { name: 'Water & energy' }).click();
  await summary.waitFor({ state: 'detached' });
  await nav.getByRole('link', { name: 'Irrigation planning' }).click();
  await summary.click();
  assert.equal(await results.count(), 0);
  assert.equal(await page.evaluate(token => [localStorage, sessionStorage].some(storage =>
    Object.keys(storage).some(key => `${key} ${storage.getItem(key)}`.includes(token))), marker), false);
}

async function simulatedSiteDownload(page) {
  const picker = page.getByRole('combobox', { name: 'Agricultural site' });
  await picker.selectOption('gafsa-oasis');
  const summary = page.getByText('Check a recorded delivery day', { exact: true });
  await summary.click();
  const [file] = await Promise.all([page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download simulated site CSV' }).click()]);
  assert.equal(file.suggestedFilename(), 'gafsa-oasis-simulated.csv');
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  const renamed = { name: 'renamed.csv', mimeType: 'text/csv', buffer: Buffer.concat(chunks) };
  const chooser = page.getByLabel('Recorded delivery CSV');
  await chooser.setInputFiles(renamed);
  const simulated = page.getByRole('region', { name: 'Simulated delivery results' });
  await simulated.getByText('Volumes calculated by the physical simulator').waitFor();
  assert.equal(await simulated.getByRole('rowheader').count(), 2);
  assert.equal(await page.getByRole('region', { name: 'Recorded delivery results' }).count(), 0);
  await picker.selectOption('korba-cap-bon');
  await summary.click();
  await chooser.setInputFiles(renamed);
  await page.getByRole('alert').filter({ hasText: 'This simulated example belongs to a different site.' }).waitFor();
  await picker.selectOption('TN-32-BALTABOUAWENE-ASSILA');
  await summary.click();
  await page.getByRole('link', { name: 'Download mapped parcel template' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Download simulated site CSV' }).count(), 0);
}

try {
  for (const width of [1360, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 860 }, reducedMotion: 'reduce' });
    const errors = [];
    let recordSent = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().includes(marker) || request.postData()?.includes(marker)) recordSent = true;
    });
    await page.goto(url.href);
    await stockOnly(page);
    if (width > 400) {
      await rotation(page);
    } else {
      await page.getByRole('combobox', { name: 'Agricultural site' }).selectOption('TN-32-BALTABOUAWENE-ASSILA');
      await page.getByRole('heading', { name: 'Planning inputs unavailable' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Calculate schedules' }).count(), 0);
    }
    await fieldDay(page);
    if (width > 400) await simulatedSiteDownload(page);
    assert.equal(recordSent, false, 'An anonymous field record was sent over the network');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Chrome passed no-outage commitments, constrained operator replay and private field-day audit at Jendouba and survey-only Assila.');
} finally { await browser.close(); }
