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

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  const opened = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', ws => { if (new URL(ws.url()).pathname === '/api/guardian/call') opened.push(ws); });
  await page.addInitScript(() => {
    window.micRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.micRequests++;
      throw new DOMException('Test microphone permission denied', 'NotAllowedError');
    };
  });
  await page.goto(url.href);
  const quota = page.locator('#remaining-quota');
  const previous = Number(await quota.inputValue());
  assert.ok(previous > 1);
  const replayResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/telemetry/replay');
  await page.getByRole('button', { name: 'Calculate schedules' }).click();
  assert.equal((await replayResponse).status(), 200);
  const twin = page.getByRole('region', { name: 'Operational digital twin' });
  await twin.getByText('Virtual sensors and event injection', { exact: true }).click();
  await twin.getByLabel('Missing flow reading').check();
  const incoming = page.getByRole('region', { name: 'Guardian alert' });
  await incoming.getByText('Field clarification').waitFor();
  await incoming.getByRole('button', { name: 'Dismiss' }).click();
  assert.equal(opened.length, 0);
  assert.equal(await page.evaluate(() => window.micRequests), 0);

  await twin.getByLabel('Water-balance discrepancy').check();
  await incoming.getByText('Urgent replay alert').waitFor();
  await incoming.getByRole('button', { name: 'Explain alert' }).click();
  const call = page.getByRole('dialog', { name: 'Voice Guardian' });
  const log = call.getByRole('log', { name: 'Conversation' });
  await log.getByText(/13 m³.*meter/i).waitFor();
  assert.equal(await page.evaluate(() => window.micRequests), 0);
  await call.getByRole('button', { name: 'Record observation' }).click();
  await call.getByLabel('Field observation').fill('The meter inspection is underway.');
  await call.getByRole('button', { name: 'Save observation' }).click();
  await log.getByText(/Reported observation.*meter inspection/).waitFor();
  await call.getByText('Review a new quota', { exact: true }).click();
  const amount = previous - 1;
  await call.getByLabel(/Proposed withdrawal limit/).fill(String(amount));
  await call.getByRole('button', { name: 'Calculate proposal' }).click();
  const review = call.getByRole('region', { name: 'Proposed simulated plan' });
  await review.waitFor();
  assert.equal(Number(await quota.inputValue()), previous);
  await review.getByRole('button', { name: 'Confirm simulated plan' }).click();
  await call.waitFor({ state: 'detached' });
  assert.equal(Number(await quota.inputValue()), amount);
  await page.getByText(/Simulated plan approved/i).first().waitFor();
  await page.getByRole('button', { name: 'Voice assistant' }).click();
  await call.getByLabel('Message', { exact: true }).fill('Explain the plan.');
  await call.getByRole('button', { name: 'Send message' }).click();
  await log.getByText(/on.time deliver/i).waitFor();
  assert.equal(await log.getByText(/meter inspection/).count(), 0);
  await call.getByRole('button', { name: 'Done' }).click();
  const sites = page.getByRole('combobox', { name: 'Agricultural site' });
  await sites.selectOption('TN-32-BALTABOUAWENE-ASSILA');
  await incoming.getByRole('button', { name: 'Explain alert' }).click();
  await log.getByText(/Assila.*authori/i).waitFor();
  assert.equal(await call.getByText('Review a new quota').count(), 0);
  await call.getByRole('button', { name: 'Done' }).click();

  await sites.selectOption('korba-cap-bon');
  await page.getByRole('button', { name: 'Compare regional plans' }).click();
  await incoming.getByText('Field clarification').waitFor();
  await incoming.getByRole('button', { name: 'Dismiss' }).click();
  await page.getByRole('button', { name: 'Load example assumptions' }).click();
  const regionalQuota = page.getByRole('spinbutton', { name: 'Withdrawal limit (m³)', exact: true });
  const beforeRegional = Number(await regionalQuota.inputValue());
  await page.getByRole('button', { name: 'Compare regional plans' }).click();
  await page.getByRole('region', { name: 'Regional hourly replay' }).waitFor();
  await page.getByRole('button', { name: 'Voice assistant' }).click();
  await call.getByText('Review a new quota', { exact: true }).click();
  await call.getByLabel(/Proposed withdrawal limit/).fill(String(beforeRegional - 1));
  await call.getByRole('button', { name: 'Calculate proposal' }).click();
  await review.waitFor();
  assert.equal(Number(await regionalQuota.inputValue()), beforeRegional);
  await review.getByRole('button', { name: 'Confirm simulated plan' }).click();
  await call.waitFor({ state: 'detached' });
  assert.equal(Number(await regionalQuota.inputValue()), beforeRegional - 1);

  await page.getByRole('link', { name: 'Land & agriculture', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search cities' }).fill('Tozeur');
  const atlas = await (await page.request.get(new URL('/api/tunisia', url).href)).json();
  const city = atlas.cities.find(row => /tozeur/i.test(row.name));
  await page.getByRole('button', { name: 'View ' + city.name, exact: true }).click();
  const analysis = page.getByRole('region', { name: city.name + ' analysis' });
  await analysis.getByLabel('Start date').fill('2025-07-01');
  await analysis.getByLabel('End date').fill('2025-07-07');
  const series = page.waitForResponse(r => r.url().includes('/api/tunisia/cities/' + city.id + '?start=2025-07-01'));
  await analysis.getByRole('button', { name: 'Apply dates' }).click();
  const climate = (await (await series).json()).climate;
  await page.getByRole('button', { name: 'Voice assistant' }).click();
  await call.getByLabel('Message', { exact: true }).fill('Explain the rain chart.');
  await call.getByRole('button', { name: 'Send message' }).click();
  const answer = log.getByText(/2025-07-01.*2025-07-07/);
  await answer.waitFor();
  assert.ok((await answer.textContent()).includes(String(climate.precipitation_mm) + ' mm'));
  assert.equal(await log.getByRole('link').first().getAttribute('href'), climate.source.url);
  await call.getByRole('button', { name: 'Done' }).click();

  // Each dashboard locale opens its matching assistant without ringing or requesting a microphone.
  for (const scenario of [
    { language: 'ja', locale: 'ja', open: '音声アシスタント', speak: '話す言語', present: '発表を準備', generate: '発表原稿を作る', done: '終了', script: /[ぁ-んァ-ン]/ },
    { language: 'aeb', locale: 'aeb-TN', open: 'المعاون الصوتي', speak: 'اللغة اللي باش تحكي بيها', present: 'حضّر العرض', generate: 'حضّرلي كلام للعرض', done: 'كمّلت', script: /[ء-ي]/ },
  ]) {
    const localized = new URL(url);
    localized.searchParams.set('lang', scenario.language);
    localized.hash = 'map';
    await page.goto(localized.href);
    await page.getByRole('button', { name: scenario.open, exact: true }).click();
    const assistant = page.getByRole('dialog');
    assert.equal(await assistant.getByLabel(scenario.speak).inputValue(), scenario.language);
    await assistant.getByRole('button', { name: scenario.present, exact: true }).click();
    const prior = await assistant.getByRole('log').locator('p').count();
    await assistant.getByRole('button', { name: scenario.generate }).click();
    const pitch = assistant.getByRole('log').locator('p').nth(prior);
    await pitch.waitFor();
    assert.equal(await pitch.getAttribute('lang'), scenario.locale);
    assert.match(await pitch.textContent(), scenario.script);
    assert.equal(await page.evaluate(() => window.micRequests), 0);
    await assistant.getByRole('button', { name: scenario.done, exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.log('Guardian verified on the Jendouba replay, Assila survey, Korba planning and dated Tozeur climate with real WebSockets and explicit M5 approvals.');
} finally {
  await browser.close();
}
