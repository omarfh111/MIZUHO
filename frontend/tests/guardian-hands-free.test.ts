import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import vm from 'node:vm';
import { GuardianHandsFree, PlaybackEchoGuard, VoiceTurnDetector, encodeVoiceWav,
  type GuardianVoicePhase, type GuardianVoiceError } from '../src/components/guardianHandsFree.ts';

const rate = 16_000;
const quiet = new Float32Array(320);
// A voiced vowel has several pitch harmonics, resonances and a changing syllabic envelope.
const speech = Float32Array.from({ length: rate }, (_, i) => {
  const t = i / rate;
  const phase = 2 * Math.PI * 158 * t + 1.8 * Math.sin(2 * Math.PI * 2 * t);
  const syllable = 0.65 + 0.35 * Math.cos(2 * Math.PI * 3 * t);
  return syllable * (0.07 * Math.sin(phase) + 0.06 * Math.sin(phase * 3) +
    0.045 * Math.sin(phase * 4) + 0.038 * Math.sin(phase * 9) + 0.02 * Math.sin(phase * 15));
});
function block(signal: Float32Array, number: number, size = quiet.length) {
  const offset = number * size % signal.length;
  return signal.subarray(offset, offset + size);
}
function rms(frame: Float32Array) {
  return Math.sqrt(frame.reduce((sum, x) => sum + x * x, 0) / frame.length);
}
function feed(detector: VoiceTurnDetector, count: number, signal: Float32Array, speaking = false) {
  return Array.from({ length: count }, (_, i) => {
    const frame = block(signal, i);
    return detector.consume(frame, rate, rms(frame), false, speaking);
  }).filter(e => e !== undefined);
}

test('turn detection retains the first syllable and accommodates short pauses without uploading silence', () => {
  const detector = new VoiceTurnDetector();
  assert.deepEqual(feed(detector, 90, quiet), []);
  assert.deepEqual(feed(detector, 2, speech), []);
  assert.deepEqual(feed(detector, 30, quiet), []);
  const firstSyllable = block(speech, 0);
  detector.consume(firstSyllable, rate, rms(firstSyllable), false, false);
  assert.deepEqual(feed(detector, 25, speech), [{ type: 'start' }]);
  assert.deepEqual(feed(detector, 20, quiet), []);
  assert.deepEqual(feed(detector, 15, speech), []);
  const turn = feed(detector, 50, quiet);
  assert.equal(turn.length, 1);
  assert.equal(turn[0].type, 'turn');
  if (turn[0].type === 'turn') assert.ok(turn[0].frames.includes(firstSyllable));
  assert.deepEqual(feed(detector, 40, quiet), []);
});

test('overlong audio needs a pause before it can start another turn', () => {
  const detector = new VoiceTurnDetector();
  assert.deepEqual(feed(detector, 2400, speech).map(e => e.type), ['start', 'limit']);
  assert.deepEqual(feed(detector, 120, speech), []);
  assert.deepEqual(feed(detector, 50, quiet), []);
  assert.deepEqual(feed(detector, 30, speech), [{ type: 'start' }]);
});

test('room noise, a running fan and isolated knocks neither start a turn nor interrupt playback', () => {
  let random = 123456, previous = 0;
  const hiss = new Float32Array(rate * 2);
  const fan = Float32Array.from({ length: rate * 2 }, (_, i) => {
    random = (Math.imul(1664525, random) + 1013904223) >>> 0;
    const noise = random / 0x80000000 - 1;
    hiss[i] = 0.052 * noise;
    previous = previous * 0.9 + noise * 0.1;
    return 0.034 * Math.sin(2 * Math.PI * 97 * i / rate) + 0.055 * previous + 0.007 * noise;
  });
  const taps = Float32Array.from(fan, (x, i) =>
    x + 0.45 * Math.exp(-((i % (rate / 4)) / (rate * .008))) * Math.sin(i * .84));
  for (const playing of [false, true]) {
    const detector = new VoiceTurnDetector();
    assert.deepEqual(feed(detector, 100, fan, playing), []);
    assert.deepEqual(feed(detector, 100, taps, playing), []);
    assert.deepEqual(feed(detector, 100, hiss, playing), []);
    assert.deepEqual(feed(detector, 50, quiet, playing), []);
  }
});

test('a quiet first phrase starts promptly, releases a single turn and can follow steady background noise', () => {
  const soft = Float32Array.from(speech, x => x * 0.38);
  const room = Float32Array.from({ length: rate }, (_, i) => 0.009 * Math.sin(2 * Math.PI * 104 * i / rate));
  for (const withRoom of [false, true]) {
    const detector = new VoiceTurnDetector();
    if (withRoom) assert.deepEqual(feed(detector, 75, room), []);
    const mic = withRoom ? Float32Array.from(soft, (sample, i) => sample + room[i]) : soft;
    assert.deepEqual(feed(detector, 25, mic), [{ type: 'start' }]);
    assert.deepEqual(feed(detector, 60, withRoom ? room : quiet).map(e => e.type), ['turn']);
  }
});

test('a motor with several harmonics and a ringing chime do not start a conversation', () => {
  const motor = Float32Array.from({ length: rate * 2 }, (_, i) => {
    const phase = 2 * Math.PI * 175 * i / rate;
    return 0.05 * Math.sin(phase) + 0.038 * Math.sin(3 * phase) + 0.026 * Math.sin(5 * phase) +
      0.018 * Math.sin(8 * phase);
  });
  const chime = Float32Array.from({ length: rate * 2 }, (_, i) => {
    const t = i / rate;
    return Math.exp(-2.2 * t) * (0.11 * Math.sin(2 * Math.PI * 660 * t) +
      0.08 * Math.sin(2 * Math.PI * 1031 * t) + 0.05 * Math.sin(2 * Math.PI * 1797 * t));
  });
  for (const signal of [motor, chime]) {
    const detector = new VoiceTurnDetector();
    assert.deepEqual(feed(detector, 100, signal), []);
    assert.deepEqual(feed(detector, 50, quiet), []);
  }
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
  buffer?: { getChannelData: (channel: number) => Float32Array; duration: number };
  startTime = 0;
  stopped = false;
  start(time = 0) { this.startTime = time; }
  stop() { this.stopped = true; }
  connect() {}
  disconnect() {}
}
class Context {
  static latest: Context;
  sampleRate = rate;
  currentTime = 1;
  state = 'suspended';
  output = new Source();
  audioWorklet = { addModule: async () => undefined };
  constructor() { Context.latest = this; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createMediaStreamSource() { return new Source(); }
  createBufferSource() { this.output = new Source(); return this.output; }
  createBuffer(_: number, length: number, sampleRate: number) {
    const samples = new Float32Array(length);
    return { getChannelData: () => samples, duration: length / sampleRate };
  }
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
    assert.deepEqual(constraints.audio, { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 });
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
    for (let i = 0; i < n; i++) Worklet.latest.port.onmessage?.({ data: { microphone: block(microphone, i), playback: block(playback, i) } });
  };
  return { live, phases, errors, phasesAtError, turns, track, frames, events, localDocument, grant: () => permission(),
    requests: () => requests, interrupts: () => interrupts, level: () => level };
}

test('one gesture supports automatic turns, barge-in during reasoning and playback, then listening again', async t => {
  const b = browser(t);
  await b.live.start();
  const hum = Float32Array.from({ length: rate }, (_, i) => 0.04 * Math.sin(2 * Math.PI * 120 * i / rate));
  b.frames(50, hum);
  assert.equal(b.phases.at(-1), 'listening');
  assert.equal(b.level(), 0, 'a room hum must not light up the speech meter');
  b.frames(15, speech); b.frames(45, quiet);
  assert.deepEqual(b.phases, ['permission', 'listening', 'hearing', 'thinking']);
  b.frames(50, hum);
  assert.equal(b.interrupts(), 0, 'background noise must not cancel a pending answer');
  assert.equal(b.level(), 0);
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

test('streaming speech schedules the first PCM sample immediately and joins split 16-bit samples in order', async t => {
  const b = browser(t);
  await b.live.start();
  b.live.waitForReply();
  assert.equal(b.phases.at(-1), 'thinking');
  // -32768, +32767, 0. The second sample spans two WebSocket messages.
  assert.equal(b.live.queuePcm(Buffer.from([0, 128, 255]).toString('base64')), true);
  const first = Context.latest.output;
  assert.deepEqual([...first.buffer!.getChannelData(0)], [-1]);
  assert.equal(b.phases.at(-1), 'speaking');
  assert.equal(b.live.queuePcm(Buffer.from([127, 0, 0]).toString('base64')), true);
  const second = Context.latest.output;
  assert.equal(first.startTime + 1 / 24_000, second.startTime);
  assert.deepEqual([...second.buffer!.getChannelData(0)], [32767 / 32768, 0]);
  let drained = false;
  const done = b.live.finishPcm().then(() => { drained = true; });
  first.onended?.();
  await Promise.resolve();
  assert.equal(drained, false);
  second.onended?.(); await done;
  assert.equal(b.phases.at(-1), 'listening');
  b.live.waitForReply();
  b.frames(14, speech);
  b.live.waitForReply();
  assert.equal(b.phases.at(-1), 'hearing');
  assert.equal(b.interrupts(), 1);
  b.live.stop();
});

test('barge-in stops all scheduled stream sources and ignores a stale audio chunk', async t => {
  const b = browser(t);
  await b.live.start();
  const data = Buffer.alloc(2400).toString('base64');
  b.live.queuePcm(data); const source = Context.latest.output;
  b.live.queuePcm(data); const following = Context.latest.output;
  const done = b.live.finishPcm();
  b.frames(16, speech);
  await done;
  assert.equal(b.interrupts(), 1);
  assert.equal(source.stopped, true);
  assert.equal(following.stopped, true);
  assert.equal(b.live.queuePcm(data), false);
  assert.equal(b.phases.at(-1), 'hearing');
  b.frames(45, quiet);
  assert.equal(b.turns.length, 1);
  b.live.stop();
});

test('a missing stream end closes the microphone and a malformed final sample reports a playback error', async t => {
  const b = browser(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await b.live.start();
  b.live.queuePcm('AA==');
  await b.live.finishPcm();
  assert.deepEqual(b.errors, ['playback']);
  assert.equal(b.phases.at(-1), 'thinking');
  b.live.queuePcm('AAA=');
  Context.latest.output.onended?.();
  assert.equal(b.phases.at(-1), 'thinking');
  t.mock.timers.tick(16_000);
  assert.equal(b.phases.at(-1), 'off');
  assert.equal(b.track.readyState, 'ended');
  assert.deepEqual(b.errors, ['playback', 'interrupted']);
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
