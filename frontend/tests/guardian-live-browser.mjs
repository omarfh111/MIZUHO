import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

// Opt-in, billable. Run against the local app with the backend Python environment
// active (or set MIZHUO_TEST_PYTHON). No audio or transcript is written to disk.
assert.ok(process.argv.includes('--live'), 'Run explicitly with --live to use Vultr inference.');
const url = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a local application origin.');
url.searchParams.set('lang', 'en');
url.searchParams.set('intro', '0');
url.searchParams.set('site', 'jendouba-pilote');
url.hash = 'simulation';

// The microphone receives only these two synthetic questions; no personal speech is recorded.
const synthesizeQuestion = [
  'import asyncio, base64, json',
  'from dotenv import load_dotenv',
  'from backend.guardian_provider import GuardianProvider',
  'load_dotenv(".env")',
  'async def synthesize():',
  '    provider = GuardianProvider.from_env()',
  '    questions = ("Please explain the water balance alert on the tank meter.", "Which official source describes photovoltaic potential in northwest Tunisia?")',
  '    return [base64.b64encode((await provider.speak(question, "en", seed=42))[0]).decode() for question in questions]',
  'print(json.dumps(asyncio.run(synthesize())))',
].join('\n');
const fixture = spawnSync(process.env.MIZHUO_TEST_PYTHON || 'python', ['-X', 'utf8', '-c', synthesizeQuestion], {
  cwd: new URL('../../', import.meta.url), timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
});
assert.ok(fixture.status === 0 && fixture.stdout?.length, 'Unable to synthesize the two test questions.');

const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream'],
});
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(45_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(fixtures => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const sink = ctx.createMediaStreamDestination();
      const questions = await Promise.all(fixtures.map(fixture =>
        ctx.decodeAudioData(Uint8Array.from(atob(fixture), char => char.charCodeAt(0)).buffer)));
      await ctx.resume();
      window.testGuardianTrack = sink.stream.getAudioTracks()[0];
      window.sayTestQuestion = index => {
        const source = ctx.createBufferSource();
        source.buffer = questions[index];
        source.connect(sink);
        source.onended = () => {
          source.disconnect();
          window.questionEndedAt = performance.now();
          window.guardianQuestionTimes ??= [];
          window.guardianQuestionTimes[index] = Date.now();
        };
        source.start();
        return performance.now();
      };
      window.closeTestAudio = () => ctx.close();
      return sink.stream;
    };
  }, JSON.parse(fixture.stdout.toString('utf8')));

  await page.goto(url.href);
  const replay = page.waitForResponse(r => new URL(r.url()).pathname === '/api/telemetry/replay');
  await page.getByRole('button', { name: 'Calculate schedules' }).click();
  assert.equal((await replay).status(), 200);
  const twin = page.getByRole('region', { name: 'Operational digital twin' });
  await twin.getByText('Virtual sensors and event injection', { exact: true }).click();
  await twin.getByLabel('Water-balance discrepancy').check();
  await page.getByRole('region', { name: 'Guardian alert' }).waitFor();
  const connection = page.waitForEvent('websocket', { predicate: ws => new URL(ws.url()).pathname === '/api/guardian/call' });
  await page.getByRole('button', { name: 'Start live voice', exact: true }).click();
  const ws = await connection;
  const timings = new Map();
  ws.on('framesent', ({ payload }) => {
    const { type, turn_id } = JSON.parse(payload);
    if (turn_id) console.log(`Browser → ${type}, turn ${turn_id}`);
  });
  ws.on('close', () => console.log('Voice socket closed.'));
  ws.on('framereceived', ({ payload }) => {
    const { type, turn_id, code } = JSON.parse(payload);
    if (turn_id && ['transcript', 'progress', 'reply', 'audio_end', 'error'].includes(type)) {
      console.log(`Server → ${type}, turn ${turn_id}${code ? ' (' + code + ')' : ''}`);
    }
    if (!turn_id || !['transcript', 'progress', 'reply', 'audio_chunk'].includes(type)) return;
    if (!timings.has(turn_id)) timings.set(turn_id, {});
    timings.get(turn_id)[type] ??= Date.now();
  });
  const dialog = page.getByRole('dialog', { name: 'Voice Guardian' });
  const log = dialog.getByRole('log', { name: 'Conversation' });
  const orb = state => dialog.locator(`.guardian-orb[data-state="${state}"]`);
  const frame = (type, turn) => ws.waitForEvent('framereceived', {
    predicate: ({ payload }) => { const msg = JSON.parse(payload); return msg.type === type && msg.turn_id === turn; },
    timeout: 90_000,
  }).then(({ payload }) => JSON.parse(payload));
  await orb('listening').waitFor();
  const playbackDelay = async () => {
    await orb('speaking').waitFor({ timeout: 90_000 });
    return page.evaluate(() => Math.round(performance.now() - window.questionEndedAt));
  };
  const firstTranscript = frame('transcript', 1), firstAnswer = frame('reply', 1);
  await page.evaluate(() => window.sayTestQuestion(0));
  assert.match((await firstTranscript).text, /water.balance.*tank meter/i);
  const [answer, firstReplyMs] = await Promise.all([firstAnswer, playbackDelay()]);
  assert.equal(answer.mode, 'langgraph');
  assert.ok(answer.tools_used.includes('get_sensor_anomalies'));
  assert.match(answer.text, /13 m³/);
  await orb('speaking').waitFor({ timeout: 90_000 });

  // Interrupt audible output with a documentary question on the same live mic.
  const evidenceReply = frame('reply', 2);
  const interruptedAt = await page.evaluate(() => window.sayTestQuestion(1));
  await orb('hearing').waitFor();
  const interruptionMs = await page.evaluate(start => Math.round(performance.now() - start), interruptedAt);
  const [evidence, evidenceReplyMs] = await Promise.all([evidenceReply, playbackDelay()]);
  assert.equal(evidence.mode, 'langgraph');
  assert.ok(evidence.tools_used.includes('search_evidence'));
  assert.ok(evidence.citations.some(item => item.organization === 'ANME' && item.excerpt && item.url.startsWith('https://')));
  await log.locator('.assistant-citation').filter({ hasText: /ANME/ }).first().waitFor();
  await orb('speaking').waitFor({ timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Pause microphone' }).click();
  assert.equal(await page.evaluate(() => window.testGuardianTrack.readyState), 'ended');
  await page.evaluate(() => window.closeTestAudio());
  const speaking = dialog.getByLabel('Speaking language');
  await speaking.selectOption('ja');
  await dialog.getByRole('button', { name: 'Present', exact: true }).click();
  await dialog.getByRole('button', { name: 'Prepare my presentation' }).click();
  await log.locator('p[lang="ja"]').filter({ hasText: /[ぁ-んァ-ン]/ }).waitFor();
  await dialog.getByRole('button', { name: 'Translate', exact: true }).click();
  await dialog.getByLabel('Translate into').selectOption('aeb');
  await dialog.getByLabel('Text to translate').fill('一緒に水を大切にしましょう。');
  await dialog.getByRole('button', { name: 'Translate text' }).click();
  await log.locator('p[lang="aeb-TN"]').filter({ hasText: /[ء-ي]/ }).waitFor();
  await speaking.selectOption('aeb');
  await dialog.getByRole('button', { name: 'Present', exact: true }).click();
  await dialog.getByRole('button', { name: 'Prepare my presentation' }).click();
  await log.locator('p[lang="aeb-TN"]').filter({ hasText: /[ء-ي]/ }).nth(1).waitFor();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  const ends = await page.evaluate(() => window.guardianQuestionTimes);
  for (const [i, end] of ends.entries()) {
    const t = timings.get(i + 1);
    assert.ok(t.transcript && t.reply && t.audio_chunk, 'Expected a real transcription, M8 answer and streamed provider audio');
    console.log(`Turn ${i + 1}: transcript at ${t.transcript-end} ms, first PCM at ${t.audio_chunk-end} ms, full M8 answer at ${t.reply-end} ms.`);
  }
  console.log(`End of synthetic speech to first playback: replay ${firstReplyMs} ms, official evidence ${evidenceReplyMs} ms. Spoken interruption registered in ${interruptionMs} ms.`);
  console.log('Chrome verified one-click hands-free speech, interruption, M8 retrieval with an ANME citation, a spoken M3 result, Japanese and Tunisian presentations and a real Japanese-to-Derja translation.');
} finally {
  await browser.close();
}
