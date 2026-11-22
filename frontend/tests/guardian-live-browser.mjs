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

// Only this short synthetic question enters the browser microphone track.
const synthesizeQuestion = [
  'import asyncio, sys',
  'from dotenv import load_dotenv',
  'from backend.guardian_provider import GuardianProvider',
  'load_dotenv(".env")',
  'audio, _ = asyncio.run(GuardianProvider.from_env().speak("Please explain the water balance alert on the tank meter.", "en"))',
  'sys.stdout.buffer.write(audio)',
].join('\n');
const fixture = spawnSync(process.env.MIZHUO_TEST_PYTHON || 'python', ['-X', 'utf8', '-c', synthesizeQuestion], {
  cwd: new URL('../../', import.meta.url), timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
});
assert.ok(fixture.status === 0 && fixture.stdout?.length, 'Unable to synthesize the English test question.');

const browser = await chromium.launch({
  ...(process.env.MIZHUO_CHROME_PATH ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream'],
});
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(45_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(base64 => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const buffer = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(buffer.buffer);
      const sink = ctx.createMediaStreamDestination();
      source.connect(sink);
      await ctx.resume();
      window.testGuardianTrack = sink.stream.getAudioTracks()[0];
      window.testQuestionEnded = new Promise(resolve => { source.onended = resolve; });
      window.closeTestAudio = () => ctx.close();
      source.start(ctx.currentTime + 0.35);
      return sink.stream;
    };
  }, fixture.stdout.toString('base64'));

  await page.goto(url.href);
  const replay = page.waitForResponse(r => new URL(r.url()).pathname === '/api/telemetry/replay');
  await page.getByRole('button', { name: 'Calculate schedules' }).click();
  assert.equal((await replay).status(), 200);
  const twin = page.getByRole('region', { name: 'Operational digital twin' });
  await twin.getByText('Virtual sensors and event injection', { exact: true }).click();
  await twin.getByLabel('Water-balance discrepancy').check();
  await page.getByRole('region', { name: 'Guardian alert' }).waitFor();
  const connection = page.waitForEvent('websocket', { predicate: ws => new URL(ws.url()).pathname === '/api/guardian/call' });
  await page.getByRole('button', { name: 'Voice assistant' }).click();
  const ws = await connection;
  const dialog = page.getByRole('dialog', { name: 'Voice Guardian' });
  const log = dialog.getByRole('log', { name: 'Conversation' });
  await log.getByText(/13 m³.*meter/i).waitFor();
  const player = dialog.locator('audio');
  assert.equal(await player.count(), 0);
  assert.equal(await page.evaluate(() => !!window.testGuardianTrack), false);

  await dialog.getByRole('button', { name: 'Record message' }).click();
  await dialog.getByRole('button', { name: 'Stop recording' }).waitFor();
  await page.evaluate(() => window.testQuestionEnded.then(() => true));
  await dialog.getByRole('button', { name: 'Stop recording' }).click();
  const replyFrames = [];
  const replyAudio = ws.waitForEvent('framereceived', {
    predicate: ({ payload }) => JSON.parse(payload).type === 'audio', timeout: 60_000,
  });
  ws.on('framereceived', ({ payload }) => {
    const msg = JSON.parse(payload);
    if (msg.type === 'transcript' || msg.type === 'reply') replyFrames.push(msg);
  });
  await dialog.getByRole('button', { name: 'Send recording' }).click();
  await log.getByText(/water.balance.*tank meter/i).waitFor({ timeout: 45_000 });
  // Both the initial alert and the answer must report the M3 discrepancy.
  await log.getByText(/13 m³.*meter/i).nth(1).waitFor({ timeout: 45_000 });
  assert.ok(['vultr_tools', 'nvidia_tools'].includes(replyFrames.find(message => message.type === 'reply')?.mode));
  assert.match(replyFrames.find(message => message.type === 'transcript')?.text ?? '', /water.balance.*tank meter/i);
  const { mime, data } = JSON.parse((await replyAudio).payload);
  assert.ok(mime === 'audio/mpeg' && data.length > 1000);
  await page.waitForFunction(expected => {
    const audio = document.querySelector('dialog[open] audio');
    return audio?.src === expected && audio.duration > 0;
  }, `data:${mime};base64,${data}`, { timeout: 45_000 });
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
  console.log('Chrome verified direct English microphone assistance, a spoken M3 answer, Japanese and Tunisian presentations and a real Japanese-to-Derja translation.');
} finally {
  await browser.close();
}
