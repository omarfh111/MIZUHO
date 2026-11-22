import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Use Chrome's synthetic microphone and a local WebSocket double; no recording or
// speech request leaves the browser test. The live Guardian API has separate coverage.
const base = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
base.searchParams.set('lang', 'en');
base.searchParams.set('intro', '0');
base.searchParams.set('site', 'jendouba-pilote');
base.hash = 'map';
const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', permissions: ['microphone'] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.guardianTracks = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await capture(constraints);
      window.guardianTracks.push(...stream.getTracks());
      if (window.guardianPermission) await window.guardianPermission;
      return stream;
    };
  });
  let connections = 0;
  const clips = [];
  const approvals = [];
  const translations = [];
  let reads = 0;
  let protectedPlan = false;
  let connection;
  let pendingTextReceived;
  const pendingText = new Promise(resolve => { pendingTextReceived = resolve; });
  await page.routeWebSocket('**/api/guardian/call', route => {
    connection = route;
    connections++;
    route.onMessage(raw => {
      const data = JSON.parse(raw);
      const send = response => route.send(JSON.stringify(response));
      if (data.type === 'start') {
        assert.equal(data.language, 'en');
        send({ type: 'ready', text: 'Welcome.', requires_manager_code: protectedPlan, voice: { stt: true, tts: true, llm: true } });
      } else if (data.type === 'language') {
        send({ type: 'language', language: data.language, voice: { stt: true, tts: true, llm: true } });
      } else if (data.type === 'speak') {
        reads++;
      } else if (data.type === 'message' && data.mode === 'translate') {
        translations.push(data);
        send({ type: 'reply', text: 'مرحبا بيكم', language: 'aeb', speech_available: false });
      } else if (data.type === 'audio') {
        clips.push(data);
        send({ type: 'transcript', text: 'Check the flow.' });
        send({ type: 'reply', text: 'Check the flow meter.', citations: [] });
      } else if (data.type === 'observation') {
        send({ type: 'recorded', text: 'Observation saved.' });
      } else if (data.type === 'message') {
        send({ type: 'error', code: 'voice_unavailable', request_type: 'speak', text: 'Spoken reply unavailable.' });
        pendingTextReceived();
      } else if (data.type === 'propose') {
        send({ type: 'reply', text: 'Proposal calculated.', proposal: { id: 'preview', previous_quota_m3: 10, quota_m3: data.quota_m3, delivered_on_time_m3: 5 } });
      } else if (data.type === 'confirm') {
        approvals.push(data);
        send({ type: 'error', code: 'manager_code', request_type: 'confirm', text: 'Invalid code.' });
      }
    });
  });
  await page.goto(base.href);
  const launcher = page.getByRole('button', { name: 'Voice assistant' });
  await launcher.waitFor();
  assert.equal(connections, 0);
  await launcher.click();
  const dialog = page.getByRole('dialog', { name: 'Voice Guardian' });
  const record = dialog.getByRole('button', { name: 'Record message' });
  await record.waitFor();
  assert.equal(await page.evaluate(() => window.guardianTracks.length), 0);
  await record.click();
  const stop = dialog.getByRole('button', { name: 'Stop recording' });
  await stop.waitFor();
  await dialog.getByRole('button', { name: 'Discard recording' }).click();
  assert.equal(await page.evaluate(() => window.guardianTracks.every(track => track.readyState === 'ended')), true);
  assert.equal(clips.length, 0);
  await dialog.getByRole('button', { name: 'Sources', exact: true }).click();
  await record.click();
  await stop.waitFor();
  // MediaRecorder emits non-empty encoded audio after its 500 ms timeslice.
  await page.waitForTimeout(750);
  await stop.click();
  await dialog.getByText('Send this recording to Vultr for transcription.').waitFor();
  assert.equal(clips.length, 0);
  await dialog.getByRole('button', { name: 'Send recording' }).click();
  await dialog.getByText('Check the flow.', { exact: true }).waitFor();
  assert.equal(clips.length, 1);
  assert.equal(clips[0].mode, 'evidence');
  assert.ok(clips[0].mime.startsWith('audio/') && Buffer.from(clips[0].data, 'base64').length > 0);
  await dialog.getByRole('button', { name: 'Chat', exact: true }).click();
  await dialog.getByRole('button', { name: 'Record observation' }).click();
  await dialog.getByRole('button', { name: 'Use my last message' }).click();
  assert.equal(await dialog.getByLabel('Field observation').inputValue(), 'Check the flow.');
  await dialog.getByRole('button', { name: 'Save observation' }).click();
  await dialog.getByText('Observation saved.').waitFor();
  await dialog.getByRole('textbox', { name: 'Message', exact: true }).fill('What flow?');
  await dialog.getByRole('button', { name: 'Send message' }).click();
  await pendingText;
  await dialog.getByText('Spoken reply unavailable.').waitFor();
  await dialog.getByRole('textbox', { name: 'Message', exact: true }).fill('Another question');
  assert.ok(await dialog.getByRole('button', { name: 'Send message' }).isDisabled());
  connection.send(JSON.stringify({ type: 'reply', text: 'The reading is missing.', citations: [] }));
  await dialog.getByText('The reading is missing.').waitFor();
  const sameSession = connections;
  await dialog.getByLabel('Speaking language').selectOption('ja');
  await dialog.getByRole('button', { name: 'Translate', exact: true }).click();
  await dialog.getByLabel('Translate into').selectOption('aeb');
  const readsBeforeTranslation = reads;
  await dialog.getByLabel('Text to translate').fill('ようこそ。');
  await dialog.getByRole('button', { name: 'Translate text' }).click();
  const translation = dialog.getByText('مرحبا بيكم', { exact: true });
  await translation.waitFor();
  assert.equal(await translation.getAttribute('lang'), 'aeb-TN');
  assert.equal(reads, readsBeforeTranslation);
  assert.deepEqual(translations, [{ type: 'message', text: 'ようこそ。', mode: 'translate', target_language: 'aeb' }]);
  assert.equal(connections, sameSession);
  await dialog.getByText('The reading is missing.').waitFor();
  await dialog.getByRole('button', { name: 'Chat', exact: true }).click();
  await record.click();
  await stop.waitFor();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await launcher.waitFor();
  assert.equal(await page.evaluate(() => window.guardianTracks.every(track => track.readyState === 'ended')), true);
  await page.evaluate(() => { window.guardianPermission = new Promise(resolve => { window.finishPermission = resolve; }); });
  await launcher.click();
  await record.click();
  await dialog.getByText('Waiting for microphone permission…').waitFor();
  await page.waitForFunction(() => window.guardianTracks.some(track => track.readyState === 'live'));
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.evaluate(() => window.finishPermission());
  await page.waitForFunction(() => window.guardianTracks.every(track => track.readyState === 'ended'));
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; });
  await launcher.click();
  await record.click();
  await dialog.getByText('Microphone unavailable. Check browser permissions or type your message.').waitFor();
  await dialog.getByRole('textbox', { name: 'Message', exact: true }).fill('Typed question');
  assert.equal(await dialog.getByRole('button', { name: 'Send message' }).isEnabled(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await dialog.getByRole('button', { name: 'Done' }).click();

  protectedPlan = true;
  base.searchParams.set('site', 'jendouba-pilote');
  base.hash = 'simulation';
  await page.goto(base.href);
  await page.getByRole('button', { name: 'Calculate schedules' }).click();
  await page.getByRole('region', { name: 'Operational digital twin' }).waitFor();
  if (await page.getByRole('button', { name: 'Dismiss', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  }
  await launcher.click();
  await dialog.getByText('Review a new quota', { exact: true }).click();
  await dialog.getByLabel(/Proposed withdrawal limit/).fill('1');
  await dialog.getByRole('button', { name: 'Calculate proposal' }).click();
  const code = dialog.getByLabel('Manager approval code');
  const confirm = dialog.getByRole('button', { name: 'Confirm simulated plan' });
  assert.equal(await code.getAttribute('type'), 'password');
  await confirm.click();
  assert.equal(approvals.length, 0);
  await code.fill('ui-test');
  await confirm.click();
  await dialog.getByText('Invalid code.').waitFor();
  assert.deepEqual(approvals, [{ type: 'confirm', id: 'preview', manager_code: 'ui-test' }]);
  assert.equal(await code.inputValue(), '');
  assert.equal(await dialog.getByRole('log').getByText('ui-test').count(), 0);
  await dialog.getByRole('button', { name: 'Record observation' }).click();
  await dialog.getByLabel('Field observation').fill('Checking the meter.');
  await dialog.getByRole('button', { name: 'Save observation' }).click();
  await dialog.getByText('Observation saved.').waitFor();
  assert.equal(await confirm.count(), 0);
  await dialog.getByRole('button', { name: 'Done' }).click();
  assert.deepEqual(errors, []);
  console.log('Chrome passed opt-in recording and upload, transcription, TTS failure, microphone denial and cleanup, mobile layout, protected approval and proposal invalidation.');
} finally { await browser.close(); }
