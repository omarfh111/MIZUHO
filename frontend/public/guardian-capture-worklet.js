// Web Audio renders in small quanta. Ship 20 ms frames to the turn detector;
// the first input is the microphone, the second is our own playback reference.
class GuardianCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * 0.02);
    this.microphone = new Float32Array(this.size);
    this.playback = new Float32Array(this.size);
    this.offset = 0;
  }

  process(inputs) {
    const mic = inputs[0]?.[0];
    if (!mic) return true;
    const reference = inputs[1]?.[0];
    let read = 0;
    while (read < mic.length) {
      const count = Math.min(this.size - this.offset, mic.length - read);
      this.microphone.set(mic.subarray(read, read + count), this.offset);
      if (reference) this.playback.set(reference.subarray(read, read + count), this.offset);
      this.offset += count;
      read += count;
      if (this.offset === this.size) {
        this.port.postMessage({ microphone: this.microphone, playback: this.playback },
          [this.microphone.buffer, this.playback.buffer]);
        this.microphone = new Float32Array(this.size);
        this.playback = new Float32Array(this.size);
        this.offset = 0;
      }
    }
    // Output stays silent. The microphone is never routed to the speakers.
    return true;
  }
}

registerProcessor('guardian-capture', GuardianCapture);
