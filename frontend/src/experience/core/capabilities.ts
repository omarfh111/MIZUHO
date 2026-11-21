export type Tier = 'high' | 'low';

export interface Capabilities {
  webgl: boolean;
  reducedMotion: boolean;
  tier: Tier;
  touch: boolean;
}

let cachedWebgl: boolean | undefined;

export function supportsWebGL(): boolean {
  if (cachedWebgl !== undefined) return cachedWebgl;
  try {
    const canvas = document.createElement('canvas');
    // three r163+ renders with WebGL 2 only.
    const gl = canvas.getContext('webgl2');
    cachedWebgl = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    cachedWebgl = false;
  }
  return cachedWebgl;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function detectCapabilities(): Capabilities {
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 8;
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 600;
  const tier: Tier = touch || smallScreen || cores <= 4 || memory <= 4 ? 'low' : 'high';
  return { webgl: supportsWebGL(), reducedMotion: prefersReducedMotion(), tier, touch };
}

export interface Quality {
  dpr: [number, number];
  mapTexture: number;
  mapSegments: [number, number];
  valleySegments: number;
  particles: number;
  postprocessing: boolean;
}

export const QUALITY: Record<Tier, Quality> = {
  high: { dpr: [1, 1.75], mapTexture: 1536, mapSegments: [300, 345], valleySegments: 220, particles: 1400, postprocessing: true },
  low: { dpr: [1, 1.25], mapTexture: 1024, mapSegments: [170, 195], valleySegments: 140, particles: 600, postprocessing: false },
};
