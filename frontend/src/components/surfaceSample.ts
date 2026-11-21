import type { LandCoverGrid } from '../types.ts';
import type { ReliefGrid } from './cityReliefGeometry.ts';

export interface SurfacePoint {
  /** Texture coordinates run west to east and south to north. */
  u: number;
  v: number;
}

export function sampleSurface(relief: ReliefGrid, cover: LandCoverGrid, point: SurfacePoint) {
  const u = Math.max(0, Math.min(1, point.u));
  const v = Math.max(0, Math.min(1, point.v));
  const col = Math.min(cover.cols - 1, Math.floor(u * cover.cols));
  const row = Math.min(cover.rows - 1, Math.floor((1 - v) * cover.rows));
  const [west, south, east, north] = relief.bounds;
  return { u, v, longitude: west + u * (east - west), latitude: south + v * (north - south),
    coverCode: cover.classes[row * cover.cols + col], elevation: surfaceElevation(relief, { u, v }) };
}

export function surfaceElevation(relief: ReliefGrid, point: SurfacePoint): number | null {
  const u = Math.max(0, Math.min(1, point.u));
  const v = Math.max(0, Math.min(1, point.v));
  const x = u * (relief.cols - 1);
  const y = v * (relief.rows - 1);
  const left = Math.min(Math.floor(x), relief.cols - 2);
  const bottom = Math.min(Math.floor(y), relief.rows - 2);
  const dx = x - left;
  const dy = y - bottom;
  const index = bottom * relief.cols + left;
  // Use the same triangle and interpolation as the Three.js mesh.
  const indices = dx + dy <= 1 ? [index, index + 1, index + relief.cols]
    : [index + relief.cols + 1, index + relief.cols, index + 1];
  const weights = dx + dy <= 1 ? [1 - dx - dy, dx, dy] : [dx + dy - 1, 1 - dx, 1 - dy];
  return indices.some(i => relief.elevations[i] == null) ? null :
    indices.reduce((sum, i, corner) => sum + weights[corner] * relief.elevations[i]!, 0);
}

/** Find the closest mapped display cell of this class to the current inspection point. */
export function findCoverSample(cover: LandCoverGrid, code: number, point: SurfacePoint): SurfacePoint | null {
  let nearest: SurfacePoint | null = null;
  let best = Infinity;
  cover.classes.forEach((classCode, index) => {
    if (classCode !== code) return;
    const u = ((index % cover.cols) + .5) / cover.cols;
    const v = 1 - (Math.floor(index / cover.cols) + .5) / cover.rows;
    const distance = (u - point.u) ** 2 + (v - point.v) ** 2;
    if (distance < best) {
      nearest = { u, v };
      best = distance;
    }
  });
  return nearest;
}
