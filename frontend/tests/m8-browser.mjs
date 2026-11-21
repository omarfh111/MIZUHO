import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
base.searchParams.set('intro', '0');
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const visible = (locator, timeout = 15000) => locator.waitFor({ state: 'visible', timeout });
const errors = [];

function waitForChat(page) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === '/api/assistant/chat', { timeout: 55000 });
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base.href);
  await visible(page.getByText('API · simulated site'));
  await visible(page.locator('.terrain-surface canvas'));

  await page.getByRole('button', { name: 'Source · Solar potential' }).click();
  await visible(page.getByText('1,450 kWh per kilowatt-peak', { exact: false }));
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Simulation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Scenario' }).selectOption('mini');
  await page.getByRole('button', { name: 'Calculate schedules' }).click();
  await visible(page.getByText('Group minimum · 50 %'));
  await page.getByRole('button', { name: 'Approve simulated plan' }).click();
  await visible(page.getByText(/Simulated plan approved/));

  await page.route('**/api/assistant/health', (route) => route.fulfill({ status: 503 }), { times: 1 });
  await page.getByRole('button', { name: 'Ask Mizhuo' }).click();
  const panel = page.getByRole('dialog', { name: 'Mizhuo assistant' });
  const unavailable = panel.getByText(/The assistant needs a connected evidence service/);
  await visible(unavailable);
  await panel.getByRole('button', { name: 'Retry evidence connection' }).click();
  await unavailable.waitFor({ state: 'hidden' });
  await visible(panel.getByText('Current comparison available'));
  const allocationPending = waitForChat(page);
  await panel.getByRole('button', { name: /Why did grower A receive/ }).click();
  const allocation = await allocationPending;
  assert.equal(allocation.status(), 200);
  assert.ok((await allocation.json()).tools_used.includes('explain_decision'));
  assert.equal(allocation.request().postDataJSON().comparison.scenario_id, 'mini');
  const session = allocation.request().postDataJSON().session_id;
  assert.match(session, /^[a-f\d-]{36}$/);
  await visible(panel.getByText(/Plot A \(EXP-01\): 5 m³ by its deadline/).first());

  await panel.getByRole('textbox', { name: 'Your question' }).fill(
    'What does ANME say about photovoltaic potential in northwest Tunisia?',
  );
  const solarPending = waitForChat(page);
  await panel.getByRole('button', { name: 'Send question' }).click();
  const solar = await solarPending;
  assert.equal(solar.status(), 200);
  assert.equal(solar.request().postDataJSON().session_id, session);
  const citation = panel.locator('details').filter({ hasText: /ANME · Solar PV potential in Tunisia/ }).first();
  await citation.locator('summary').click({ timeout: 50000 });
  const link = citation.getByRole('link', { name: 'Read the source' });
  assert.equal(await link.getAttribute('href'), 'https://anme.tn/en/content/solar-photovoltaic');
  await visible(citation.getByText('1,450 kWh per kilowatt-peak', { exact: false }));

  await page.route('**/api/assistant/chat', (route) => route.fulfill({ status: 503 }), { times: 1 });
  await panel.getByRole('textbox', { name: 'Your question' }).fill('This turn has a temporary provider failure.');
  await panel.getByRole('button', { name: 'Send question' }).click();
  await visible(panel.getByRole('alert').filter({ hasText: /could not answer/ }));
  await visible(citation);

  await panel.getByRole('textbox', { name: 'Your question' }).fill(
    'Which official source did you just cite? Please cite that same passage again.',
  );
  const followUpPending = waitForChat(page);
  await panel.getByRole('button', { name: 'Send question' }).click();
  const followUp = await followUpPending;
  assert.equal(followUp.status(), 200);
  assert.equal(followUp.request().postDataJSON().session_id, session);
  assert.ok((await followUp.json()).citations.some((source) => source.source_id === 'solar'));

  await page.keyboard.press('Escape');
  await visible(page.getByText(/Simulated plan approved/));
  await page.getByRole('button', { name: 'Replay the intro' }).click();
  await page.getByRole('button', { name: 'Skip intro' }).click();
  await visible(page.getByText(/Simulated plan approved/));
  await page.getByRole('button', { name: 'Ask Mizhuo' }).click();
  await visible(panel.getByText(/ANME · Solar PV potential in Tunisia/).first());
  await page.keyboard.press('Escape');
  await page.getByLabel(/Measured water stock/).fill('9');
  await visible(page.getByText(/Result out of date/));
  await page.getByRole('button', { name: 'Ask Mizhuo' }).click();
  await visible(page.getByRole('dialog').getByText('Site and evidence'));
  await visible(panel.getByText('Historical result · earlier inputs').first());
  await visible(panel.getByText(/ANME · Solar PV potential in Tunisia/).first());

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (error) => errors.push(error.message));
  const offline = new URL(base);
  offline.searchParams.set('mode', 'demo');
  await mobile.goto(offline.href);
  await visible(mobile.locator('.terrain-surface canvas'));
  await mobile.getByRole('button', { name: 'Ask Mizhuo' }).click();
  await visible(mobile.getByText('The assistant needs a connected evidence service.', { exact: false }));
  assert.deepEqual(errors, []);
  console.log('Chrome passed live allocation, ANME citation, session continuity, stale history, approval, and mobile offline fallback.');
} finally {
  await browser.close();
}
