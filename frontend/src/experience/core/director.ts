/**
 * The film's direction as a pure function of scene time.
 *
 * Whole numbers are chapter anchors (0 cloud · 1 rain · 2 river · 3 dams ·
 * 4 canals · 5 sun · 6 MIZUHO). Nothing here reads a clock or accumulates, so
 * scrubbing backwards is exact and every frame is reproducible.
 */
export const SCENE_END = 6;

export interface Director {
  /** Scene time, 0 → SCENE_END. */
  time: number;
  mapReveal: number;
  mapLabels: number;
  clouds: number;
  /** Full-frame mist while the camera plunges through the cloud deck. */
  veil: number;
  drop: number;
  rain: number;
  river: number;
  dams: number;
  valley: number;
  reservoir: number;
  canals: number;
  solar: number;
  plots: number;
  labels: number;
  twin: number;
  exit: number;
  /** Black dip used for hard cuts in reduced-motion mode. */
  dip: number;
  /** Pointer in normalised device coordinates (-1 → 1). */
  pointer: { x: number; y: number; active: boolean };
}

export const createDirector = (): Director => ({
  time: 0, mapReveal: 0, mapLabels: 0, clouds: 1, veil: 0, drop: 0, rain: 0, river: 0, dams: 0, valley: 0, reservoir: 0,
  canals: 0, solar: 0, plots: 0, labels: 0, twin: 0, exit: 0, dip: 0, pointer: { x: 0, y: 0, active: false },
});

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
/** 0 before a, 1 after b. */
export const ramp = (s: number, a: number, b: number) => smooth((s - a) / (b - a));
/** Rises over a→b, holds, falls over c→d. */
export const bell = (s: number, a: number, b: number, c: number, d: number) => ramp(s, a, b) * (1 - ramp(s, c, d));

/** Writes every reveal for scene time `s` into the director. */
export function direct(director: Director, s: number) {
  director.time = s;
  director.mapReveal = ramp(s, -0.15, 0.75);
  director.clouds = 1 - ramp(s, 0.55, 1.05);
  director.veil = bell(s, 0.16, 0.3, 0.36, 0.56);
  director.drop = s;
  director.rain = bell(s, 0.45, 0.9, 1.55, 2.05);
  director.mapLabels = bell(s, 1.65, 2.05, 3.35, 3.75);
  director.river = bell(s, 1.4, 1.85, 3.6, 4.2);
  director.dams = bell(s, 2.5, 2.9, 3.7, 4.1);
  director.valley = ramp(s, 3.15, 3.95);
  director.reservoir = ramp(s, 2.9, 3.6);
  director.canals = ramp(s, 3.85, 4.75);
  director.plots = ramp(s, 4.1, 5.0);
  director.solar = ramp(s, 4.65, 5.3);
  director.labels = bell(s, 4.15, 4.45, 5.55, 5.85);
  director.twin = ramp(s, 5.55, 6.0);
}

/** Index of the chapter whose copy owns scene time `s`. */
export const chapterAt = (s: number) => Math.max(0, Math.min(SCENE_END, Math.floor(s + 0.38)));

/** Autoplay pace, seconds of wall time per chapter. */
export const SECONDS_PER_CHAPTER = 3.1;

/**
 * Critically damped spring towards `target`, exact at any frame rate, so the
 * scene glides after each wheel notch instead of stepping.
 */
export function springStep(state: { value: number; velocity: number }, target: number, dt: number, omega = 5.2) {
  const x = state.value - target;
  const temp = (state.velocity + omega * x) * dt;
  const decay = Math.exp(-omega * dt);
  state.velocity = (state.velocity - omega * temp) * decay;
  state.value = target + (x + temp) * decay;
}
