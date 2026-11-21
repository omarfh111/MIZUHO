import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
const provider = process.env.MIZHUO_TEST_PROVIDER ?? 'openai';
assert.ok(['openai', 'nvidia'].includes(provider), 'Choose openai or nvidia for the live walkthrough.');
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
  if (provider === 'nvidia') await panel.getByLabel('Answer model').selectOption(provider);
  const allocationPending = waitForChat(page);
  await panel.getByRole('button', { name: /Why did grower A receive/ }).click();
  const allocation = await allocationPending;
  assert.equal(allocation.status(), 200);
  assert.equal(allocation.request().postDataJSON().provider, provider);
  assert.ok((await allocation.json()).tools_used.includes('explain_decision'));
  assert.equal(allocation.request().postDataJSON().comparison.scenario_id, 'mini');
  const session = allocation.request().postDataJSON().session_id;
  assert.match(session, /^[a-f\d-]{36}$/);
  await visible(panel.getByText(/Plot A \(EXP-01\): 5 m³ by its deadline/).first());
  await visible(panel.locator('.assistant-paragraph > p').filter({ hasText: /coverage|fairness/i }).first());
  await visible(panel.getByText('MIZUHO · Simulated', { exact: true }).first());

  await panel.getByRole('textbox', { name: 'Your question' }).fill(
    'What does ANME say about photovoltaic potential in northwest Tunisia?',
  );
  const solarPending = waitForChat(page);
  await panel.getByRole('button', { name: 'Send question' }).click();
  const solar = await solarPending;
  assert.equal(solar.status(), 200);
  assert.equal(solar.request().postDataJSON().provider, provider);
  assert.equal(solar.request().postDataJSON().session_id, session);
  const citation = panel.locator('details').filter({ hasText: /ANME · Solar PV potential in Tunisia/ }).first();
  await visible(panel.locator('.assistant-paragraph > p').filter({ hasText: /verified passage from ANME/ }));
  await visible(citation.getByText('Publisher excerpt', { exact: true }));
  await visible(citation.getByText('MIZUHO assessment:', { exact: true }));
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
  await visible(panel.getByRole('article').last().locator('.assistant-paragraph > p').filter({ hasText: /from ANME/ }));

  await page.keyboard.press('Escape');
  if (provider === 'nvidia') {
    const twin = page.getByRole('region', { name: 'Operational digital twin' });
    await twin.getByText('Virtual sensors and event injection', { exact: true }).click();
    await twin.getByLabel('Water-balance discrepancy').check();
    await twin.getByText(/Unexplained water balance/).waitFor();
    await page.getByRole('button', { name: 'Ask Mizhuo' }).click();
    await panel.getByRole('textbox', { name: 'Your question' }).fill('What water-balance anomaly do the virtual meters show at the selected replay hour?');
    const pending = waitForChat(page);
    await panel.getByRole('button', { name: 'Send question' }).click();
    const answer = await (await pending).json();
    assert.ok(answer.tools_used.includes('get_sensor_anomalies'));
    assert.ok(answer.facts.some((f) => f.provenance === 'simulated' && /13 m³/.test(f.text)));
    await page.keyboard.press('Escape');
  }
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

  if (provider === 'nvidia') {
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Site map', exact: true }).click();
    await page.getByRole('combobox', { name: 'Pilot site' }).selectOption('TN-32-BALTABOUAWENE-ASSILA');
    await page.getByRole('region', { name: 'Agricultural survey' }).waitFor();
    await page.getByRole('button', { name: 'Ask Mizhuo' }).click();
    await panel.getByLabel('Answer model').selectOption(provider);
    await panel.getByRole('textbox', { name: 'Your question' }).fill('What does WaPOR estimate for parcel P-01?');
    const pending = waitForChat(page);
    await panel.getByRole('button', { name: 'Send question' }).click();
    const answer = await (await pending).json();
    assert.ok(answer.tools_used.includes('get_agricultural_insights'));
    assert.ok(answer.facts.some((f) => f.provenance === 'estimated' && /P-01.*FAO WaPOR AETI/.test(f.text)));
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: 'Pilot site' }).selectOption('jendouba-pilote');
    await page.getByRole('button', { name: 'Compare solar options' }).click();
    const comparison = page.getByRole('dialog', { name: 'Compare solar options' });
    const archivePending = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/solar/compare-archive');
    await comparison.getByLabel('Production source').selectOption('archive');
    const archiveResponse = await archivePending;
    assert.equal(archiveResponse.status(), 200);
    const canopy = (await archiveResponse.json()).options.find(option => option.id === 'ombriere');
    await comparison.getByRole('button', { name: /Solar canopy/ }).click();
    await comparison.getByRole('button', { name: 'Use in simulation' }).click();
    await page.getByRole('button', { name: 'Ask Mizhuo' }).click();
    await panel.getByLabel('Answer model').selectOption(provider);
    await panel.getByRole('textbox', { name: 'Your question' }).fill(
      'How much does the selected archived PVGIS solar canopy generate on its reference day?',
    );
    const pvPending = waitForChat(page);
    await panel.getByRole('button', { name: 'Send question' }).click();
    const pvResponse = await pvPending;
    assert.equal(pvResponse.status(), 200);
    const pvRequest = pvResponse.request().postDataJSON();
    assert.equal(pvRequest.pvgis_option_id, 'ombriere');
    assert.equal(pvRequest.solar_option_id, undefined);
    assert.equal(pvRequest.comparison, undefined);
    const pvAnswer = await pvResponse.json();
    assert.ok(pvAnswer.tools_used.includes('get_site_data'));
    assert.ok(pvAnswer.facts.some(fact => fact.provenance === 'estimated' &&
      fact.text.includes('Solar canopy (selected in the interface)') &&
      fact.text.includes(`${canopy.production_kwh} kWh estimated production`)));
  }
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
  if (provider === 'nvidia') console.log('Chrome passed live Nemotron explanations for Assila WaPOR, the replay anomaly, and staged PVGIS.');
} finally {
  await browser.close();
}
