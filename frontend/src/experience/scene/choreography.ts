import * as THREE from 'three';
import { toWorld } from '../core/geo.ts';
import type { World } from './world.ts';

/**
 * Camera keys and the hero drop's path, both pure functions of scene time.
 * Keys are authored per chapter; each chapter frames its subject on the side
 * opposite the copy (`shift`), so headlines never sit on top of the action.
 */

export interface Key {
  s: number;
  pos: THREE.Vector3;
  at: THREE.Vector3;
  fov: number;
  roll: number;
  /** Horizontal view offset as a fraction of the frame width. */
  shift: number;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** When the drop lands in the reservoir. */
export const DROP_LANDS = 1.55;

export function makeDropPath(world: World) {
  const res = world.valley.reservoir.center;
  const start = V(res.x + 9, 132, res.z + 34);
  const land = V(res.x + 0.05, res.y + 0.02, res.z + 0.05);
  const p = new THREE.Vector3();
  return (s: number, out = p) => {
    const u = THREE.MathUtils.clamp(s / DROP_LANDS, 0, 1);
    // Slight drift, then gravity: slow at first, accelerating towards the ground.
    const fall = u * u * (0.55 + 0.45 * u);
    out.lerpVectors(start, land, fall);
    out.x += Math.sin(u * Math.PI) * 3.5;
    out.z += Math.sin(u * Math.PI) * -2;
    return out;
  };
}

export function makeKeys(world: World): Key[] {
  const v = world.valley.center;
  const st = world.valley.station;
  const sc = world.valley.solarCenter;
  const drop = makeDropPath(world);
  const near = (s: number, dx: number, dy: number, dz: number) => drop(s, new THREE.Vector3()).add(V(dx, dy, dz));
  const medjez = toWorld([9.62, 36.66]);
  const upstream = toWorld([8.95, 36.56]);
  return [
    // 0 · Cloud: riding just behind and above the falling drop.
    { s: 0, pos: near(0, 2.2, 3.4, 6.5), at: near(0.02, 0, -2, 0), fov: 34, roll: 0.06, shift: 0.16 },
    { s: 0.5, pos: near(0.5, 3.6, 7, 10), at: near(0.56, 0, -6, 0), fov: 38, roll: -0.04, shift: 0.14 },
    // 1 · Rain: pull back to reveal the wet north from the north-east.
    { s: 1, pos: V(v.x + 46, 64, v.z - 34), at: V(v.x + 12, 0, v.z + 6), fov: 40, roll: 0.02, shift: -0.16 },
    { s: 1.5, pos: V(v.x + 30, 30, v.z - 26), at: V(v.x + 6, 0, v.z + 2), fov: 40, roll: 0, shift: -0.12 },
    // 2 · River: low over the Medjerda near Medjez el-Bab, looking upstream.
    { s: 2, pos: V(medjez.x + 4, 5.2, medjez.z + 5), at: V(upstream.x, 0, upstream.z), fov: 42, roll: -0.05, shift: 0.14 },
    { s: 2.5, pos: V(medjez.x - 7, 4.2, medjez.z + 4.5), at: V(upstream.x - 3, 0, upstream.z - 1), fov: 44, roll: 0.03, shift: 0.1 },
    // 3 · Dams: a wide, high look over the north-west reservoirs.
    { s: 3, pos: V(v.x + 12, 24, v.z + 22), at: V(v.x + 3, 0, v.z - 4), fov: 40, roll: 0, shift: -0.14 },
    { s: 3.5, pos: V(v.x + 6, 10, v.z + 11), at: V(v.x + 0.5, v.y, v.z - 1.5), fov: 42, roll: 0, shift: -0.08 },
    // 4 · Canals: down into the valley, skimming the fields.
    { s: 4, pos: V(v.x + 3.6, 2.6, v.z + 4.2), at: V(v.x + 0.1, v.y, v.z - 0.9), fov: 46, roll: -0.03, shift: 0.14 },
    { s: 4.5, pos: V(v.x + 1.7, 1.15, v.z + 1.7), at: V(v.x - 1.4, v.y + 0.1, v.z - 0.9), fov: 50, roll: -0.05, shift: 0.1 },
    // 5 · Energy: over the solar field, turbines turning on the ridge beyond.
    // Across the valley, looking down at the solar field with the ridge turbines beyond.
    { s: 5, pos: V(v.x - (sc.x - v.x) * 0.55 + 0.4, Math.max(sc.y, v.y) + 2.6, v.z - (sc.z - v.z) * 0.55 + 0.3), at: V(sc.x + (sc.x - v.x) * 0.2, sc.y + 0.1, sc.z + (sc.z - v.z) * 0.2), fov: 42, roll: 0.02, shift: -0.14 },
    { s: 5.5, pos: V(v.x + 1.2, Math.max(sc.y, v.y) + 3.2, v.z + 3.8), at: V(sc.x, sc.y + 0.1, sc.z), fov: 44, roll: -0.02, shift: -0.08 },
    // 6 · Renewables: rise to see Tunisia's operating wind and solar plants.
    { s: 6, pos: V(16, 150, 52), at: V(-2, 0, -38), fov: 40, roll: 0, shift: 0.14 },
    { s: 6.5, pos: V(4, 138, 46), at: V(-6, 0, -40), fov: 40, roll: 0.02, shift: 0.12 },
    // 7 · MIZUHO: dive back to the valley, centred under the wordmark.
    { s: 7, pos: V(v.x + 0.3, 7.6, v.z + 6.6), at: V(v.x - 0.2, v.y, v.z - 0.4), fov: 44, roll: 0, shift: 0 },
  ];
}

/** Uniform Catmull-Rom between four values. */
const cr = (a: number, b: number, c: number, d: number, t: number) => {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
};

export interface Shot {
  pos: THREE.Vector3;
  at: THREE.Vector3;
  fov: number;
  roll: number;
  shift: number;
}

export function sample(keys: Key[], s: number, out: Shot) {
  const t = THREE.MathUtils.clamp(s, keys[0].s, keys[keys.length - 1].s);
  let i = 0;
  while (i < keys.length - 2 && t >= keys[i + 1].s) i++;
  const k0 = keys[Math.max(0, i - 1)];
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const k3 = keys[Math.min(keys.length - 1, i + 2)];
  const u = (t - k1.s) / (k2.s - k1.s);
  for (const axis of ['x', 'y', 'z'] as const) {
    out.pos[axis] = cr(k0.pos[axis], k1.pos[axis], k2.pos[axis], k3.pos[axis], u);
    out.at[axis] = cr(k0.at[axis], k1.at[axis], k2.at[axis], k3.at[axis], u);
  }
  out.fov = cr(k0.fov, k1.fov, k2.fov, k3.fov, u);
  out.roll = cr(k0.roll, k1.roll, k2.roll, k3.roll, u);
  out.shift = cr(k0.shift, k1.shift, k2.shift, k3.shift, u);
  return out;
}
