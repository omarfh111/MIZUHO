import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Exercise the real audio worklet and Web Audio playback without a physical
// microphone or provider credentials. Only the speech server is substituted.
const url = new URL(process.env.MIZHUO_TEST_URL ?? 'http://127.0.0.1:5173/');
url.searchParams.set('intro', '0');
url.searchParams.set('lang', 'en');
url.searchParams.set('site', 'jendouba-pilote');
url.hash = 'map';

function replyTone(seconds) {
  const rate = 16_000;
  const samples = Math.round(rate * seconds);
  const wav = Buffer.alloc(44 + 2 * samples);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(2 * samples, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(5000 * Math.sin(i * 2 * Math.PI * 521 / rate)), 44 + i * 2);
  return wav.toString('base64');
}

const browser = await chromium.launch(process.env.MIZHUO_CHROME_PATH
  ? { executablePath: process.env.MIZHUO_CHROME_PATH } : { channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const NativeAudio = window.AudioContext;
    window.voiceContexts = [];
    window.voiceTracks = [];
    window.captureConstraints = [];
    window.AudioContext = class extends NativeAudio {
      constructor(...args) { super(...args); window.voiceContexts.push(this); }
    };
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.captureConstraints.push(constraints);
      if (window.denyCapture) throw new DOMException('Denied by user', 'NotAllowedError');
      const input = new NativeAudio();
      const oscillator = input.createOscillator();
      const gain = input.createGain();
      gain.gain.value = 0;
      const destination = input.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await input.resume();
      window.emitVoice = hz => {
        if (hz) oscillator.frequency.setValueAtTime(hz, input.currentTime);
        gain.gain.setValueAtTime(hz ? 0.22 : 0, input.currentTime);
      };
      window.closeFixtureMic = () => { oscillator.stop(); return input.close(); };
      window.voiceTracks.push(...destination.stream.getTracks());
      return destination.stream;
    };
  });
  const turns = [];
  const reads = [];
  const cancelled = [];
  let starts = 0;
  let send;
  const longReply = replyTone(3.5);
  const shortReply = replyTone(.55);
  await page.routeWebSocket('**/api/guardian/call', route => {
    send = frame => route.send(JSON.stringify(frame));
    route.onMessage(raw => {
      const frame = JSON.parse(raw);
      if (frame.type === 'start') {
        starts++;
        send({ type: 'ready', text: 'Ready.', voice: { stt: true, llm: true, tts: true }, rag_available: true });
      } else if (frame.type === 'audio') {
        turns.push(frame);
        send({ type: 'transcript', turn_id: frame.turn_id, text: 'Test utterance ' + turns.length });
      } else if (frame.type === 'speak') {
        reads.push(frame.turn_id);
        send({ type: 'audio', turn_id: frame.turn_id, mime: 'audio/wav', data: reads.length === 1 ? longReply : shortReply });
      } else if (frame.type === 'cancel') cancelled.push(frame.turn_id);
    });
  });
  await page.goto(url.href);
  const start = page.getByRole('button', { name: 'Start live voice', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Voice Guardian' });
  const state = value => dialog.locator('.guardian-orb[data-state="' + value + '"]').waitFor();
  const sound = hz => page.evaluate(frequency => window.emitVoice(frequency), hz);
  await start.waitFor();
  assert.equal(starts, 0);
  assert.equal(await page.evaluate(() => window.captureConstraints.length), 0);
  await start.click();
  await state('listening');
  assert.equal(starts, 1);
  assert.equal(await page.evaluate(() => window.captureConstraints[0].audio.echoCancellation), true);
  assert.equal(await dialog.getByRole('button', { name: 'Send recording' }).count(), 0);
  // More than the detector's end-of-utterance interval.
  await page.waitForTimeout(1100);
  assert.equal(turns.length, 0, 'continuous silence must send no audio');

  await sound(261);
  await state('hearing');
  await sound(0);
  await state('thinking');
  await dialog.getByText('Test utterance 1', { exact: true }).waitFor();
  const first = turns[0].turn_id;
  send({ type: 'reply', turn_id: first, text: 'First reply.', speech_available: true });
  await state('speaking');
  await sound(347);
  await state('hearing');
  await sound(0);
  await state('thinking');
  await dialog.getByText('Test utterance 2', { exact: true }).waitFor();
  const second = turns[1].turn_id;
  assert.ok(Number.isInteger(first) && Number.isInteger(second) && second > first);
  assert.deepEqual(cancelled, [first]);
  for (const turn of turns) {
    assert.equal(turn.mode, 'ask');
    assert.equal(turn.mime, 'audio/wav');
    const bytes = Buffer.from(turn.data, 'base64');
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(bytes.readUInt32LE(24), 16_000);
    assert.ok(bytes.length > 44 && bytes.length < 1_450_000);
    assert.ok(bytes.subarray(44).some(value => value !== 0));
  }
  send({ type: 'transcript', turn_id: first, text: 'Outdated transcript.' });
  send({ type: 'reply', turn_id: first, text: 'Outdated response.', speech_available: true });
  send({ type: 'audio', turn_id: first, mime: 'audio/wav', data: longReply });
  send({ type: 'reply', turn_id: second, text: 'The test plan shares the remaining water.', speech_available: true,
    citations: [{ id: 'test-source', source_id: 'test', title: 'Fixture source', organization: 'Test publisher', date: null,
      page: 2, url: 'https://example.org/evidence', section: 'Fixture section', excerpt: 'A documentary excerpt from the fixture.',
      limitation: 'This is a browser fixture.' }],
    facts: [{ id: 'f1', text: 'Test plot allocation: 5 m³', provenance: 'simulated' }],
    missing_information: ['Test field measurements unavailable.'] });
  await state('speaking');
  await state('listening');
  assert.deepEqual(reads, [first, second]);
  assert.equal(await dialog.getByText(/Outdated (transcript|response)/).count(), 0);
  await dialog.getByText('A documentary excerpt from the fixture.', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('link', { name: 'Read the source' }).getAttribute('href'), 'https://example.org/evidence');
  await dialog.getByText('Supporting data', { exact: true }).click();
  await dialog.getByText('Test plot allocation: 5 m³', { exact: true }).waitFor();
  await dialog.getByText('Missing information', { exact: true }).click();
  await dialog.getByText('Test field measurements unavailable.', { exact: true }).waitFor();
  assert.equal(turns.length, 2);
  assert.equal(await page.evaluate(() => window.captureConstraints.length), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForFunction(() =>
    window.voiceTracks.every(track => track.readyState === 'ended') && window.voiceContexts.every(audio => audio.state === 'closed'));
  await page.evaluate(async () => { await window.closeFixtureMic(); window.denyCapture = true; });
  await start.click();
  await dialog.getByText('Microphone unavailable. Check browser permissions or type your message.').waitFor();
  await dialog.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForFunction(() => window.voiceContexts.every(audio => audio.state === 'closed'));
  assert.equal(turns.length, 2);
  assert.deepEqual(errors, []);
  console.log('One-click live voice passed automatic turn detection, silence privacy, interruption, stale frame filtering, grounded transcript, permission denial and cleanup in Chrome.');
} finally {
  await browser.close();
}
