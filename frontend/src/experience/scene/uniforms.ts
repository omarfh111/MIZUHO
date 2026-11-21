import * as THREE from 'three';

/**
 * Uniform objects shared by every custom material. Materials spread these
 * references into their own uniforms, so a single write per frame updates
 * fog, time and lighting everywhere.
 */
/**
 * Safety net: clamp every fragment to a finite, non-negative range before output.
 * A single NaN pixel (e.g. pow() of a value that drifts below zero) is otherwise
 * spread across the whole frame by the bloom's mip chain and reads as a black screen.
 * On ANGLE/D3D, clamp() also maps NaN to 0.
 */
const NAN_GUARD = 'gl_FragColor = clamp(gl_FragColor, vec4(0.), vec4(64000.));\n';
if (!THREE.ShaderChunk.colorspace_fragment.startsWith(NAN_GUARD)) {
  THREE.ShaderChunk.colorspace_fragment = NAN_GUARD + THREE.ShaderChunk.colorspace_fragment;
}

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
