export type GuardianVoicePhase = 'off' | 'permission' | 'listening' | 'hearing' | 'thinking' | 'speaking';
export type GuardianVoiceError = 'microphone' | 'unsupported' | 'playback' | 'interrupted' | 'utterance_limit';

interface VoiceEvents {
  onPhase: (phase: GuardianVoicePhase) => void;
  onLevel: (level: number) => void;
  onTurn: (mime: 'audio/wav', base64: string) => void;
  onInterrupt: () => void;
  onError: (reason: GuardianVoiceError) => void;
}

function rms(samples: Float32Array) {
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / samples.length);
}

const pauseMs = 820;
const maxTurnMs = 45_000;

/** Retains the first syllable and only releases a phrase once the speaker pauses. */
export class VoiceTurnDetector {
  private noise = 0.003;
  private preRoll: Float32Array[] = [];
  private phrase: Float32Array[] = [];
  private onset = 0;
  private quiet = 0;
  private duration = 0;
  private waitForPause = false;

  consume(frame: Float32Array, rate: number, level: number, echo: boolean, speaking: boolean) {
    const ms = frame.length * 1000 / rate;
    const threshold = Math.max(speaking ? 0.018 : 0.009, this.noise * 3);
    const voiced = !echo && level >= threshold * (this.phrase.length ? 0.7 : 1);
    if (this.waitForPause) {
      this.quiet = voiced ? 0 : this.quiet + ms;
      if (this.quiet >= pauseMs) { this.waitForPause = false; this.quiet = 0; }
      return;
    }
    if (!this.phrase.length) {
      this.preRoll.push(echo ? new Float32Array(frame.length) : frame);
      if (this.preRoll.length > Math.ceil(320 / ms)) this.preRoll.shift();
      if (!voiced) {
        this.onset = 0;
        if (!echo && !speaking) this.noise += 0.04 * (level - this.noise);
        return;
      }
      this.onset += ms;
      if (this.onset < (speaking ? 180 : 140)) return;
      this.phrase = this.preRoll;
      this.preRoll = [];
      this.duration = this.phrase.length * ms;
      this.quiet = 0;
      return { type: 'start' } as const;
    }
    this.phrase.push(frame);
    this.duration += ms;
    this.quiet = voiced ? 0 : this.quiet + ms;
    if (this.quiet >= pauseMs) {
      const frames = this.phrase.slice(0, Math.max(1, this.phrase.length - Math.floor((this.quiet - 160) / ms)));
      this.reset();
      return { type: 'turn', frames } as const;
    }
    if (this.duration >= maxTurnMs) {
      this.reset();
      this.waitForPause = true;
      return { type: 'limit' } as const;
    }
  }

  reset() {
    this.preRoll = [];
    this.phrase = [];
    this.duration = this.onset = this.quiet = 0;
    this.waitForPause = false;
  }
}

// Compare the actual speaker and mic waveforms as a second line of defence
// after browser echo cancellation. Searching for a delayed, scaled copy lets
// a different voice interrupt even when it is quieter than the speakers.
export class PlaybackEchoGuard {
  private mic = new Float32Array(160);
  private reference = new Float32Array(800);
  private activeUntil = 0;
  private time = 0;

  matches(mic: Float32Array, playback: Float32Array, rate: number, playing: boolean) {
    this.time += mic.length / rate;
    if (playing) this.activeUntil = this.time + 0.32;
    if (!playing && this.time > this.activeUntil) return false;
    // The worklet supplies 20 ms blocks. Average into 2 kHz mono fingerprints.
    const n = Math.min(this.mic.length, Math.max(1, Math.round(mic.length * 2000 / rate)));
    this.mic.copyWithin(0, n);
    this.reference.copyWithin(0, n);
    for (let i = 0; i < n; i++) {
      const start = Math.floor(i * mic.length / n);
      const end = Math.max(start + 1, Math.floor((i + 1) * mic.length / n));
      let input = 0, output = 0;
      for (let j = start; j < end; j++) { input += mic[j]; output += playback[j]; }
      this.mic[this.mic.length - n + i] = input / (end - start);
      this.reference[this.reference.length - n + i] = output / (end - start);
    }
    let inputEnergy = 0;
    for (const sample of this.mic) inputEnergy += sample * sample;
    if (inputEnergy < 0.00001) return false;
    for (let offset = this.reference.length - this.mic.length; offset >= 0; offset--) {
      let dot = 0, outputEnergy = 0;
      for (let i = 0; i < this.mic.length; i++) {
        const ref = this.reference[offset + i];
        dot += ref * this.mic[i];
        outputEnergy += ref * ref;
      }
      if (outputEnergy > 0.00001 && dot * dot > 0.64 * inputEnergy * outputEnergy) return true;
    }
    return false;
  }

  reset() {
    this.mic.fill(0);
    this.reference.fill(0);
    this.activeUntil = this.time = 0;
  }
}

/** Encode locally, at a bounded size: a 45 s turn is under 1.45 MB. */
export function encodeVoiceWav(frames: Float32Array[], sourceRate: number) {
  const size = frames.reduce((length, frame) => length + frame.length, 0);
  const pcm = new Float32Array(size);
  let offset = 0;
  for (const frame of frames) { pcm.set(frame, offset); offset += frame.length; }
  const rate = Math.min(sourceRate, 16_000);
  const length = Math.floor(size * rate / sourceRate);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  function tag(position: number, text: string) {
    for (let i = 0; i < text.length; i++) view.setUint8(position + i, text.charCodeAt(i));
  }
  tag(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * sourceRate / rate), end = Math.floor((i + 1) * sourceRate / rate);
    let value = 0;
    for (let j = start; j < end; j++) value += pcm[j];
    value = Math.max(-1, Math.min(1, value / (end - start)));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Uint8Array(buffer);
}

function base64(bytes: Uint8Array) {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return btoa(parts.join(''));
}

interface PcmPlayback {
  sources: Set<AudioBufferSourceNode>;
  nextTime: number;
  sampleRate: number;
  trailingByte: number | null;
  ended: boolean;
  done: Promise<void>;
  resolve: () => void;
  deadline?: ReturnType<typeof setTimeout>;
}

function stopSource(source: AudioBufferSourceNode) {
  source.onended = null;
  try { source.stop(); } catch { /* Audio device failure before playback started. */ }
  source.disconnect();
}

/** One explicit user gesture owns one duplex audio session. */
export class GuardianHandsFree {
  private events: VoiceEvents;
  private phase: GuardianVoicePhase = 'off';
  private closed = false;
  private audio: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private mic: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private output: AudioBufferSourceNode | null = null;
  private pcm: PcmPlayback | null = null;
  private playbackVersion = 0;
  private finishPlayback: (() => void) | null = null;
  private detector = new VoiceTurnDetector();
  private echo = new PlaybackEchoGuard();

  constructor(events: VoiceEvents) { this.events = events; }

  private setPhase(phase: GuardianVoicePhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.events.onPhase(phase);
  }

  private lostCapture = () => {
    if (this.closed) return;
    this.events.onError('interrupted');
    this.stop();
  };
  private checkVisibility = () => { if (document.hidden) this.lostCapture(); };

  async start() {
    if (this.closed || this.phase !== 'off') return;
    this.setPhase('permission');
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') {
      this.events.onError('unsupported');
      this.stop();
      return;
    }
    try {
      // Both calls start in the user gesture, including on mobile autoplay policies.
      const audio = new AudioContext({ latencyHint: 'interactive' });
      this.audio = audio;
      const resumed = audio.resume();
      const input = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      }).then(stream => {
        if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream;
        for (const track of stream.getAudioTracks()) track.addEventListener('ended', this.lostCapture);
      });
      document.addEventListener('visibilitychange', this.checkVisibility);
      window.addEventListener('pagehide', this.lostCapture);
      await Promise.all([resumed, input,
        audio.audioWorklet.addModule(new URL('./guardian-capture-worklet.js', document.baseURI))]);
      if (this.closed || !this.stream) return;
      this.worklet = new AudioWorkletNode(audio, 'guardian-capture', { numberOfInputs: 2, numberOfOutputs: 1,
        channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
      this.worklet.onprocessorerror = this.lostCapture;
      this.worklet.port.onmessage = event => this.frame(event.data.microphone, event.data.playback);
      this.mic = audio.createMediaStreamSource(this.stream);
      this.mic.connect(this.worklet, 0, 0);
      this.worklet.connect(audio.destination);
      audio.onstatechange = () => { if (audio.state !== 'running') this.lostCapture(); };
      if (document.hidden || this.stream.getAudioTracks().every(track => track.readyState === 'ended')) this.lostCapture();
      else this.setPhase('listening');
    } catch {
      if (this.closed) return;
      this.events.onError('microphone');
      this.stop();
    }
  }

  private frame(microphone: Float32Array, playback: Float32Array) {
    if (this.closed || !this.audio) return;
    const speaking = this.phase === 'speaking';
    const inputLevel = rms(microphone);
    const rate = this.audio.sampleRate;
    const echo = this.echo.matches(microphone, playback, rate, speaking);
    this.events.onLevel(Math.min(1, 5 * (speaking ? rms(playback) : inputLevel)));
    const event = this.detector.consume(microphone, rate, inputLevel, echo, speaking);
    if (event?.type === 'start') {
      const interrupt = speaking || this.phase === 'thinking';
      this.cancelPlayback();
      this.setPhase('hearing');
      if (interrupt) this.events.onInterrupt();
    } else if (event?.type === 'turn') {
      this.setPhase('thinking');
      this.events.onTurn('audio/wav', base64(encodeVoiceWav(event.frames, rate)));
    } else if (event?.type === 'limit') {
      this.setPhase('listening');
      this.events.onError('utterance_limit');
    }
  }

  private cancelPlayback() {
    this.playbackVersion++;
    if (this.output) {
      stopSource(this.output);
      this.output = null;
    }
    this.finishPlayback?.();
    this.finishPlayback = null;
    if (this.pcm) {
      clearTimeout(this.pcm.deadline);
      for (const source of this.pcm.sources) stopSource(source);
      this.pcm.sources.clear();
      this.pcm.resolve();
      this.pcm = null;
    }
  }

  /** Schedule signed little-endian, mono samples as they arrive from the speech provider. */
  queuePcm(data: string, sampleRate = 24_000) {
    const audio = this.audio;
    if (this.closed || !audio || !this.worklet || this.phase === 'hearing') return false;
    try {
      if (sampleRate !== 24_000 || !data || data.length > 512_000) throw new Error('Invalid speech chunk');
      const raw = atob(data);
      if (!this.pcm) {
        this.cancelPlayback();
        let resolve!: () => void;
        const done = new Promise<void>(finish => { resolve = finish; });
        this.pcm = { sources: new Set(), nextTime: audio.currentTime, sampleRate, trailingByte: null,
          ended: false, done, resolve };
      }
      const pcm = this.pcm;
      if (pcm.ended || pcm.nextTime > audio.currentTime + 90) throw new Error('Speech queue exceeded its limit');
      const prefix = pcm.trailingByte === null ? 0 : 1;
      const bytes = new Uint8Array(prefix + raw.length);
      if (pcm.trailingByte !== null) bytes[0] = pcm.trailingByte;
      for (let i = 0; i < raw.length; i++) bytes[prefix + i] = raw.charCodeAt(i);
      pcm.trailingByte = bytes.length % 2 ? bytes[bytes.length - 1] : null;
      const count = Math.floor(bytes.length / 2);
      if (count) {
        const buffer = audio.createBuffer(1, count, pcm.sampleRate);
        const samples = buffer.getChannelData(0), view = new DataView(bytes.buffer);
        for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        const source = audio.createBufferSource();
        source.buffer = buffer;
        pcm.sources.add(source);
        source.connect(audio.destination);
        source.connect(this.worklet, 0, 1);
        source.onended = () => {
          if (this.pcm !== pcm) return;
          source.disconnect();
          pcm.sources.delete(source);
          if (!pcm.sources.size) {
            if (pcm.ended) this.endPcm(pcm);
            else this.setPhase('thinking'); // The next chunk is still arriving.
          }
        };
        const when = Math.max(pcm.nextTime, audio.currentTime + 0.015);
        source.start(when);
        pcm.nextTime = when + buffer.duration;
        this.setPhase('speaking');
      }
      clearTimeout(pcm.deadline);
      // A stalled connection can otherwise leave an open microphone after its last sound.
      pcm.deadline = setTimeout(() => {
        if (this.pcm === pcm) this.lostCapture();
      }, 15_000 + Math.max(0, pcm.nextTime - audio.currentTime) * 1000);
      return true;
    } catch {
      this.waitForReply();
      this.events.onError('playback');
      return false;
    }
  }

  private endPcm(pcm: PcmPlayback) {
    clearTimeout(pcm.deadline);
    this.pcm = null;
    this.setPhase('listening');
    pcm.resolve();
  }

  /** Resolves only after the final sample, or after the user interrupts/stops. */
  finishPcm(): Promise<void> {
    const pcm = this.pcm;
    if (!pcm) return Promise.resolve();
    if (pcm.trailingByte !== null) {
      this.waitForReply();
      this.events.onError('playback');
      return pcm.done;
    }
    pcm.ended = true;
    if (!pcm.sources.size) this.endPcm(pcm);
    return pcm.done;
  }

  waitForReply() {
    if (this.closed || this.phase === 'hearing' || this.phase === 'permission') return;
    this.cancelPlayback();
    this.setPhase('thinking');
  }

  async play(mime: string, data: string) {
    if (this.closed || !this.audio || !this.worklet || this.phase === 'hearing') return;
    this.cancelPlayback();
    const version = this.playbackVersion;
    try {
      if (!mime.startsWith('audio/') || !data.length) throw new Error('Invalid audio');
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const decoded = await this.audio.decodeAudioData(bytes.buffer);
      if (this.closed || !this.audio || !this.worklet || version !== this.playbackVersion) return;
      const output = this.audio.createBufferSource();
      output.buffer = decoded;
      output.connect(this.audio.destination);
      output.connect(this.worklet, 0, 1);
      this.output = output;
      await new Promise<void>((resolve) => {
        this.finishPlayback = resolve;
        output.onended = () => {
          output.disconnect();
          this.output = null;
          this.finishPlayback = null;
          this.setPhase('listening');
          resolve();
        };
        output.start();
        this.setPhase('speaking');
      });
    } catch (error) {
      if (this.closed || version !== this.playbackVersion) return;
      this.listen();
      this.events.onError('playback');
      throw error;
    }
  }

  listen() {
    if (this.closed || this.phase === 'hearing' || this.phase === 'permission') return;
    this.cancelPlayback();
    this.setPhase('listening');
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.cancelPlayback();
    this.detector.reset();
    this.echo.reset();
    document.removeEventListener('visibilitychange', this.checkVisibility);
    window.removeEventListener('pagehide', this.lostCapture);
    for (const track of this.stream?.getTracks() ?? []) {
      track.removeEventListener('ended', this.lostCapture);
      track.stop();
    }
    if (this.worklet) {
      this.worklet.port.onmessage = this.worklet.onprocessorerror = null;
      this.worklet.port.close();
      this.worklet.disconnect();
    }
    this.mic?.disconnect();
    this.mic = this.worklet = this.stream = null;
    if (this.audio) {
      this.audio.onstatechange = null;
      if (this.audio.state !== 'closed') void this.audio.close().catch(() => {});
    }
    this.audio = null;
    this.events.onLevel(0);
    this.setPhase('off');
  }
}
