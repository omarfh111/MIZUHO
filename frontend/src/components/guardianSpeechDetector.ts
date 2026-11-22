// The capture worklet emits 20 ms blocks. Analyse at 8 kHz regardless of the
// device rate; the original full-rate samples are kept for transcription.
const analysisSize = 160;
const firstBin = 4; // 200 Hz, above mains hum and most handling rumble.
const bandCount = 67; // 50 Hz bins up to 3.5 kHz.
// Convert squared RMS to one-sided spectral energy for a Hann window.
const powerScale = analysisSize ** 2 * 3 / 16;
const window = Float32Array.from({ length: analysisSize }, (_, i) =>
  0.5 - 0.5 * Math.cos(2 * Math.PI * i / analysisSize));
const coefficients = Float32Array.from({ length: bandCount }, (_, i) =>
  2 * Math.cos(2 * Math.PI * (i + firstBin) / analysisSize));

/** Distinguish a voiced onset from a louder fan, a click or a single tone. */
export class GuardianSpeechDetector {
  private samples = new Float32Array(analysisSize);
  private detail = new Float32Array(analysisSize);
  private power = new Float32Array(bandCount);
  private ambient = new Float32Array(bandCount);
  private previousShape = new Float32Array(bandCount);
  private stationaryFrames = 0;

  voiced(frame: Float32Array, minimumLevel: number, capturing: boolean) {
    let last = 0;
    for (let i = 0; i < analysisSize; i++) {
      const start = Math.floor(i * frame.length / analysisSize);
      const end = Math.max(start + 1, Math.floor((i + 1) * frame.length / analysisSize));
      let sum = 0;
      for (let j = start; j < end; j++) sum += frame[j];
      const sample = sum / (end - start);
      this.samples[i] = window[i] * sample;
      this.detail[i] = i ? sample - 0.85 * last : 0;
      last = sample;
    }

    // Goertzel power estimates avoid allocating an FFT for each device frame.
    // Subtract the learned background in each band so that a steady low fan
    // cannot set the volume threshold for a quiet voice in a different band.
    let total = 0, rawTotal = 0, strongest = 0, peak = 0;
    for (let bin = 0; bin < bandCount; bin++) {
      let previous = 0, older = 0;
      const coefficient = coefficients[bin];
      for (let i = 0; i < analysisSize; i++) {
        const next = this.samples[i] + coefficient * previous - older;
        older = previous;
        previous = next;
      }
      const power = Math.max(0, older * older + previous * previous - coefficient * previous * older);
      this.power[bin] = power;
      rawTotal += power;
      const excess = Math.max(0, power - 2 * this.ambient[bin]);
      total += excess;
      if (excess > strongest) { strongest = excess; peak = bin; }
    }

    // Vowels concentrate energy around several resolved harmonics. Broad hiss
    // has no dominant peak; a beep has no second one beyond its window skirt.
    let second = 0, shapeChange = 0;
    for (let i = 0; i < bandCount; i++) {
      if (Math.abs(i - peak) >= 3) second = Math.max(second, this.power[i] - 2 * this.ambient[i]);
      const share = rawTotal > 0 ? this.power[i] / rawTotal : 0;
      shapeChange += Math.abs(share - this.previousShape[i]);
      this.previousShape[i] = share;
    }
    // A motor or two-note chime can also have a pitch and several harmonics.
    // If their relative strengths stay fixed for 60 ms, learn it as background.
    this.stationaryFrames = shapeChange < 0.06 ? this.stationaryFrames + 1 : 0;
    const voiced = this.stationaryFrames < 3 && total >= minimumLevel ** 2 * powerScale
      && strongest > 0.09 * total && second > 0.018 * total && this.hasPitch();
    if (!capturing || !voiced) {
      const weight = voiced ? 0.004 : 0.09;
      for (let i = 0; i < bandCount; i++) this.ambient[i] += weight * (this.power[i] - this.ambient[i]);
    }
    return voiced;
  }

  private hasPitch() {
    // Look for a repeating glottal cycle (about 75–500 Hz) in the actual mic
    // signal. Random peaks left over after noise subtraction are not a voice.
    for (let lag = 16; lag <= 106; lag += 2) {
      let dot = 0, recent = 0, earlier = 0;
      for (let i = lag; i < analysisSize; i++) {
        const a = this.detail[i], b = this.detail[i - lag];
        dot += a * b;
        recent += a * a;
        earlier += b * b;
      }
      if (dot > 0 && dot * dot > 0.24 * recent * earlier) return true;
    }
    return false;
  }
}
