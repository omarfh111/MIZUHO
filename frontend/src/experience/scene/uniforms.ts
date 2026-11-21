import * as THREE from 'three';

/**
 * Uniform objects shared by every custom material. Materials spread these
 * references into their own uniforms, so a single write per frame updates
 * fog, time and lighting everywhere.
 */
export const FOG_COLOR = new THREE.Color('#10292f');

export const shared = {
  uTime: { value: 0 },
  uFogColor: { value: FOG_COLOR.clone() },
  uFogDensity: { value: 0.004 },
  uSunDir: { value: new THREE.Vector3(0.62, 0.36, 0.7).normalize() },
  uSunColor: { value: new THREE.Color('#ffd2a0') },
  uAccent: { value: new THREE.Color('#62e3f0') },
  uSkyColor: { value: new THREE.Color('#5d8f98') },
};

export const PALETTE = {
  water: new THREE.Color('#6fe7ff'),
  leaf: new THREE.Color('#c9ef86'),
  sun: new THREE.Color('#f7ce76'),
  mote: new THREE.Color('#ffe2b0'),
};
