import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import vm from 'node:vm';
import { GuardianHandsFree, PlaybackEchoGuard, VoiceTurnDetector, encodeVoiceWav,
  type GuardianVoicePhase, type GuardianVoiceError } from '../src/components/guardianHandsFree.ts';

const rate = 16_000;
const quiet = new Float32Array(320);
const speech = Float32Array.from(quiet, (_, i) => 0.1 * Math.sin(i * 0.06));

test('turn detection retains the first syllable and accommodates short pauses without uploading silence', () => {
  const detector = new VoiceTurnDetector();
  const feed = (count: number, frame: Float32Array, level: number) =>
    Array.from({ length: count }, () => detector.consume(frame, rate, level, false, false)).filter(e => e !== undefined);
  assert.deepEqual(feed(90, quiet, 0), []);
  assert.deepEqual(feed(2, speech, 0.08), []);
  assert.deepEqual(feed(30, quiet, 0), []);
  const firstSyllable = new Float32Array(speech);
  detector.consume(firstSyllable, rate, 0.08, false, false);
  assert.deepEqual(feed(25, speech, 0.08), [{ type: 'start' }]);
  assert.deepEqual(feed(20, quiet, 0), []);
  assert.deepEqual(feed(15, speech, 0.08), []);
  const turn = feed(50, quiet, 0);
  assert.equal(turn.length, 1);
  assert.equal(turn[0].type, 'turn');
  if (turn[0].type === 'turn') assert.ok(turn[0].frames.includes(firstSyllable));
  assert.deepEqual(feed(40, quiet, 0), []);
});

test('overlong audio needs a pause before it can start another turn', () => {
  const detector = new VoiceTurnDetector();
  const feed = (count: number, level: number) => Array.from({ length: count }, () =>
    detector.consume(level ? speech : quiet, rate, level, false, false)?.type).filter(Boolean);
  assert.deepEqual(feed(2400, 0.08), ['start', 'limit']);
  assert.deepEqual(feed(120, 0.08), []);
  assert.deepEqual(feed(50, 0), []);
  assert.deepEqual(feed(30, 0.08), ['start']);
});

test('speaker reference distinguishes delayed microphone echo from a different speaker', () => {
  const guard = new PlaybackEchoGuard();
  let seed = 41287;
  const signal = Float32Array.from({ length: rate }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return 0.3 * (seed / 0x100000000 - 0.5);
  });
  const delay = 1280;
  let echo = false, ownSpeech = false;
  for (let i = 0; i + 320 <= signal.length; i += 320) {
    const reference = signal.subarray(i, i + 320);
    const mic = i < delay ? quiet : Float32Array.from(signal.subarray(i - delay, i + 320 - delay), v => 0.4 * v);
    if (i < 8000) {
      echo = guard.matches(mic, reference, rate, true);
    } else {
      ownSpeech = guard.matches(Float32Array.from(mic, (value, j) => value + speech[j]), reference, rate, true);
    }
  }
  assert.equal(echo, true);
  assert.equal(ownSpeech, false);
});

test('WAV encoding resamples all frames into a coherent little-endian mono utterance', () => {
  const wav = encodeVoiceWav([new Float32Array(480).fill(1.2), new Float32Array(480).fill(-1.5)], 48_000);
  const view = new DataView(wav.buffer);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 640);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(44 + 320, true), -32768);
  assert.equal(view.getUint32(4, true), wav.length - 8);
});

class Track extends EventTarget {
  readyState = 'live';
  stop() { this.readyState = 'ended'; }
}
class Port {
  onmessage: ((event: { data: { microphone: Float32Array; playback: Float32Array } }) => void) | null = null;
  closed = false;
  close() { this.closed = true; }
}
class Worklet {
  static latest: Worklet;
  port = new Port();
  constructor() { Worklet.latest = this; }
  connect() {}
  disconnect() {}
}
class Source {
  onended: (() => void) | null = null;
  buffer: unknown;
  stopped = false;
  start() {}
  stop() { this.stopped = true; }
  connect() {}
  disconnect() {}
}
class Context {
  static latest: Context;
  sampleRate = rate;
  state = 'suspended';
  output = new Source();
  audioWorklet = { addModule: async () => undefined };
  constructor() { Context.latest = this; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createMediaStreamSource() { return new Source(); }
  createBufferSource() { this.output = new Source(); return this.output; }
  async decodeAudioData() { return {}; }
}
function browser(t: TestContext, permissionMode: 'grant' | 'defer' | 'deny' = 'grant') {
  const track = new Track();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let requests = 0;
  let permission!: () => void;
  const events = new EventTarget();
  const localDocument = Object.assign(events, { hidden: false, baseURI: 'https://example.test/app/' });
  function replace(name: string, value: unknown) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  replace('navigator', { mediaDevices: { getUserMedia: async (constraints: MediaStreamConstraints) => {
    assert.deepEqual(constraints.audio, { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });
    requests++;
    if (permissionMode === 'deny') throw new DOMException('Permission denied', 'NotAllowedError');
    if (permissionMode === 'defer') await new Promise<void>(resolve => { permission = resolve; });
    return stream;
  } } });
  replace('window', new EventTarget());
  replace('document', localDocument);
  replace('AudioContext', Context);
  replace('AudioWorkletNode', Worklet);
  const phases: GuardianVoicePhase[] = [], errors: GuardianVoiceError[] = [], turns: string[] = [];
  const phasesAtError: (GuardianVoicePhase | undefined)[] = [];
  let interrupts = 0, level = 0;
  const live = new GuardianHandsFree({
    onPhase: phase => phases.push(phase), onLevel: value => { level = value; },
    onTurn: (mime, data) => { assert.equal(mime, 'audio/wav'); turns.push(data); },
    onInterrupt: () => { interrupts++; },
    onError: error => { errors.push(error); phasesAtError.push(phases.at(-1)); },
  });
  const frames = (n: number, microphone: Float32Array, playback = quiet) => {
    for (let i = 0; i < n; i++) Worklet.latest.port.onmessage?.({ data: { microphone, playback } });
  };
  return { live, phases, errors, phasesAtError, turns, track, frames, events, localDocument, grant: () => permission(),
    requests: () => requests, interrupts: () => interrupts, level: () => level };
}

test('one gesture supports automatic turns, barge-in during reasoning and playback, then listening again', async t => {
  const b = browser(t);
  await b.live.start();
  b.frames(15, speech); b.frames(45, quiet);
  assert.deepEqual(b.phases, ['permission', 'listening', 'hearing', 'thinking']);
  b.frames(16, speech);
  assert.equal(b.interrupts(), 1);
  b.live.listen(); // Late recovery from the cancelled response.
  assert.equal(b.phases.at(-1), 'hearing');
  b.frames(45, quiet);
  assert.equal(b.turns.length, 2);
  const firstPlayback = b.live.play('audio/wav', 'AA==');
  await Promise.resolve();
  assert.equal(b.phases.at(-1), 'speaking');
  b.frames(2, quiet, speech);
  assert.ok(b.level() > 0);
  b.frames(18, speech);
  await firstPlayback;
  assert.equal(b.interrupts(), 2);
  assert.equal(Context.latest.output.stopped, true);
  b.frames(45, quiet);
  assert.equal(b.turns.length, 3);
  const finalPlayback = b.live.play('audio/mpeg', 'AA==');
  await Promise.resolve();
  Context.latest.output.onended?.();
  await finalPlayback;
  assert.equal(b.phases.at(-1), 'listening');
  assert.equal(b.requests(), 1);
  assert.deepEqual(b.errors, []);
  b.live.stop();
  assert.equal(b.track.readyState, 'ended');
  assert.equal(Worklet.latest.port.closed, true);
  assert.equal(Context.latest.state, 'closed');
  assert.equal(b.level(), 0);
});

test('denied playback rearms and a hidden page discards an unfinished utterance and releases the mic', async t => {
  const b = browser(t);
  await b.live.start();
  await assert.rejects(b.live.play('text/html', 'AA=='));
  assert.equal(b.phases.at(-1), 'listening');
  b.frames(15, speech);
  b.localDocument.hidden = true;
  b.events.dispatchEvent(new Event('visibilitychange'));
  b.frames(50, quiet);
  assert.deepEqual(b.errors, ['playback', 'interrupted']);
  assert.equal(b.phasesAtError.at(-1), 'hearing');
  assert.equal(b.phases.at(-1), 'off');
  assert.equal(b.track.readyState, 'ended');
  assert.equal(b.turns.length, 0);
});

test('closing while the permission dialog is open immediately releases any late microphone grant', async t => {
  const b = browser(t, 'defer');
  const starting = b.live.start();
  assert.equal(Context.latest.state, 'running');
  b.live.stop();
  b.grant();
  await starting;
  assert.equal(b.track.readyState, 'ended');
  assert.equal(b.phases.at(-1), 'off');
  assert.deepEqual(b.errors, []);
});

test('permission denial reaches the owner before it releases the session and prevents transmission', async t => {
  const b = browser(t, 'deny');
  await b.live.start();
  assert.deepEqual(b.phases, ['permission', 'off']);
  assert.deepEqual(b.errors, ['microphone']);
  assert.deepEqual(b.phasesAtError, ['permission']);
  assert.equal(Context.latest.state, 'closed');
  assert.equal(b.turns.length, 0);
});

test('audio worklet keeps continuous 20 ms microphone frames and an independent speaker reference', () => {
  const result: { microphone: Float32Array; playback: Float32Array }[] = [];
  class Processor {
    port = { postMessage: (frame: typeof result[number]) => result.push(frame) };
  }
  let processor!: { process: (inputs: Float32Array[][]) => boolean };
  vm.runInNewContext(readFileSync(new URL('../public/guardian-capture-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: Processor, sampleRate: rate, Float32Array,
    registerProcessor: (_name: string, Constructor: new () => typeof processor) => { processor = new Constructor(); },
  });
  for (let step = 0; step < 5; step++) {
    processor.process([[new Float32Array(128).fill(step)], step === 0 ? [new Float32Array(128).fill(-1)] : []]);
  }
  assert.equal(result.length, 2);
  assert.deepEqual([result[0].microphone[0], result[0].microphone[128], result[1].microphone[319]], [0, 1, 4]);
  assert.deepEqual([result[0].playback[0], result[0].playback[128], result[1].playback[0]], [-1, 0, 0]);
});
