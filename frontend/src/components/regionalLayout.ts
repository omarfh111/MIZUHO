import type { FieldZone, LandCoverGrid, RegionSector } from '../types.ts';
import { surfaceElevation, type SurfacePoint } from './surfaceSample.ts';
import type { StationVariant } from './stationVariant.ts';

export interface RegionalFrame extends StationVariant {
  tank_stock_m3: number;
  tank_capacity_m3: number;
  pump_m3: number;
  grid_available: boolean;
  pv_capacity_kwp?: number;
  solar_potential_wh?: number;
  deliveries: { plot_id: string; delivered_m3: number }[];
}

export interface RegionalLayout {
  station: SurfacePoint;
  sectors: { id: RegionSector; point: SurfacePoint; path: SurfacePoint[] }[];
}

function cell(cover: LandCoverGrid, index: number): SurfacePoint {
  return { u: (index % cover.cols + .5) / cover.cols, v: 1 - (Math.floor(index / cover.cols) + .5) / cover.rows };
}

// A conceptual branch follows the shortest connected eight-neighbour path over dry mapped land.
// Cardinal side checks prevent clipping across water when a diagonal crosses two cell corners.
function pipeRoute(cover: LandCoverGrid, walkable: boolean[], start: number, end: number) {
  const parents = new Int32Array(walkable.length).fill(-1);
  const queue = [start];
  parents[start] = start;
  const targetX = end % cover.cols, targetY = Math.floor(end / cover.cols);
  for (let cursor = 0; cursor < queue.length && parents[end] === -1; cursor++) {
    const index = queue[cursor], x = index % cover.cols, y = Math.floor(index / cover.cols);
    const neighbours = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, step = ny * cover.cols + nx;
      if (nx < 0 || nx >= cover.cols || ny < 0 || ny >= cover.rows ||
          !walkable[step] || parents[step] !== -1 ||
          (dx && dy && (!walkable[y * cover.cols + nx] || !walkable[ny * cover.cols + x]))) continue;
      neighbours.push({ step, distance: (nx - targetX) ** 2 + (ny - targetY) ** 2 });
    }
    neighbours.sort((a, b) => a.distance - b.distance);
    for (const { step } of neighbours) { parents[step] = index; queue.push(step); }
  }
  if (parents[end] === -1) return [];
  const path = [cell(cover, end)];
  for (let i = end; i !== start;) { i = parents[i]; path.push(cell(cover, i)); }
  return path.reverse();
}

export function regionalLayout(profile: Pick<FieldZone, 'relief' | 'land_cover'>): RegionalLayout | null {
  const cover = profile.land_cover;
  const anchors = [-1, -1], bestDistance = [Infinity, Infinity];
  let station = -1, bestStation = -Infinity;
  const walkable = cover.classes.map((code, i) => {
    if (code === null || ![10, 20, 30, 40, 50, 60].includes(code)) return false;
    const point = cell(cover, i);
    const height = surfaceElevation(profile.relief, point);
    if (height === null) return false;
    if (code === 40) {
      // Reproduce M6's cropland anchor nearest each half-window's centre in pixel space.
      const half = point.u < .5 ? 0 : 1;
      const distance = ((point.u - (.25 + .5 * half)) * cover.cols) ** 2 + ((point.v - .5) * cover.rows) ** 2;
      if (distance < bestDistance[half]) { anchors[half] = i; bestDistance[half] = distance; }
      if (point.u >= .25 && point.u <= .75 && point.v >= .55 && point.v <= .85) {
        const score = height - 300 * ((point.u - .5) ** 2 + (point.v - .7) ** 2);
        if (score > bestStation) { station = i; bestStation = score; }
      }
    }
    return true;
  });
  if (anchors.includes(-1) || station < 0) return null;
  return { station: cell(cover, station), sectors: anchors.map((index, side) => ({
    id: side === 0 ? 'west' : 'east', point: cell(cover, index), path: pipeRoute(cover, walkable, station, index),
  })) };
}
