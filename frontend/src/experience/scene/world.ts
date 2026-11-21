import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Quality } from '../core/capabilities.ts';
import {
  DJERBA, KERKENNAH, MAP_BOUNDS, MAP_SIZE, MEDJERDA, PLACES, TUNISIA_OUTLINE, VALLEY_CENTER, VALLEY_RADIUS,
  toLonLat, toWorld, type LonLat,
} from '../core/geo.ts';
import { distanceToPolyline, distanceToSegment, fbm, random, smoothstep } from './noise.ts';

/**
 * Procedural, schematic world. Heights are an artistic exaggeration of the
 * main relief units (Dorsale, Kroumirie, Tell, Sahel, Chotts) — not a DEM.
 */

export interface ValleyLayout {
  geometry: THREE.BufferGeometry;
  plots: { matrices: Float32Array; colors: Float32Array; delays: Float32Array; count: number };
  panels: { matrices: Float32Array; delays: Float32Array; count: number };
  reservoir: { geometry: THREE.BufferGeometry; center: THREE.Vector3; radius: number };
  river: THREE.BufferGeometry;
  canals: THREE.BufferGeometry;
  dam: { position: THREE.Vector3; rotation: number; width: number };
  station: THREE.Vector3;
  pois: { id: string; label: string; position: THREE.Vector3 }[];
  center: THREE.Vector3;
}

export interface World {
  landTexture: THREE.CanvasTexture;
  mapGeometry: THREE.BufferGeometry;
  valley: ValleyLayout;
  heightAt: (x: number, z: number) => number;
  places: { id: string; label: string; kind: 'dam' | 'city'; position: THREE.Vector3 }[];
}

export type Progress = (fraction: number) => void;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/* ------------------------------------------------------------------ masks */

const LON_SPAN = MAP_BOUNDS.east - MAP_BOUNDS.west;
const LAT_SPAN = MAP_BOUNDS.north - MAP_BOUNDS.south;

function drawPolygon(ctx: CanvasRenderingContext2D, points: readonly LonLat[], w: number, h: number) {
  ctx.beginPath();
  points.forEach(([lon, lat], i) => {
    const x = ((lon - MAP_BOUNDS.west) / LON_SPAN) * w;
    const y = ((MAP_BOUNDS.north - lat) / LAT_SPAN) * h;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.closePath();
}

function drawLine(ctx: CanvasRenderingContext2D, points: readonly LonLat[], w: number, h: number) {
  ctx.beginPath();
  points.forEach(([lon, lat], i) => {
    const x = ((lon - MAP_BOUNDS.west) / LON_SPAN) * w;
    const y = ((MAP_BOUNDS.north - lat) / LAT_SPAN) * h;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
}

/** R: land, B: Medjerda. Sampled by the map shader for crisp coastlines and rivers. */
function buildLandTexture(width: number) {
  const height = Math.round((width * LAT_SPAN) / LON_SPAN);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ff0000';
  for (const shape of [TUNISIA_OUTLINE, DJERBA, KERKENNAH]) {
    drawPolygon(ctx, shape, width, height);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = '#0000ff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width / 520;
  drawLine(ctx, MEDJERDA, width, height);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  return texture;
}

/** Low-resolution blurred land field used to shape heights smoothly away from the coast. */
function buildLandField() {
  const w = 256;
  const h = Math.round((w * LAT_SPAN) / LON_SPAN);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  for (const shape of [TUNISIA_OUTLINE, DJERBA, KERKENNAH]) {
    drawPolygon(ctx, shape, w, h);
    ctx.fill();
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  let field = new Float32Array(w * h);
  for (let i = 0; i < field.length; i++) field[i] = data[i * 4] / 255;
  // Three separable box blurs approximate a gaussian.
  const radius = 4;
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += field[y * w + Math.min(w - 1, Math.max(0, x + k))];
        tmp[y * w + x] = sum / (radius * 2 + 1);
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
        out[y * w + x] = sum / (radius * 2 + 1);
      }
    }
    field = out;
  }
  return (lon: number, lat: number) => {
    const fx = ((lon - MAP_BOUNDS.west) / LON_SPAN) * (w - 1);
    const fy = ((MAP_BOUNDS.north - lat) / LAT_SPAN) * (h - 1);
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(h - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - x0));
    const ty = Math.min(1, Math.max(0, fy - y0));
    const a = field[y0 * w + x0];
    const b = field[y0 * w + x0 + 1];
    const c = field[(y0 + 1) * w + x0];
    const d = field[(y0 + 1) * w + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

/* ---------------------------------------------------------------- relief */

const VERTICAL = 2.1;

function makeRelief(land: (lon: number, lat: number) => number) {
  return (lon: number, lat: number) => {
    const shore = smoothstep(0.4, 0.78, land(lon, lat));
    if (shore <= 0) return 0;
    const n = fbm(lon * 3.1, lat * 3.1);
    const detail = fbm(lon * 11, lat * 11, 3);
    const dorsale = Math.exp(-((distanceToSegment(lon, lat, 8.25, 35.05, 10.55, 36.74) / 0.33) ** 2)) * (0.75 + 0.7 * n);
    const kroumirie = Math.exp(-((Math.hypot(lon - 8.72, lat - 36.86) / 0.27) ** 2)) * (0.8 + 0.4 * detail);
    const mogods = Math.exp(-((Math.hypot(lon - 9.25, lat - 37.06) / 0.24) ** 2)) * 0.45;
    const tell = smoothstep(34.8, 36.3, lat) * 0.38 * n;
    const dahar = Math.exp(-((distanceToSegment(lon, lat, 10.0, 32.2, 10.25, 33.4) / 0.25) ** 2)) * 0.35;
    const steppe = 0.14 * n + 0.05 * detail;
    let h = 0.06 + steppe + tell + dorsale * 1.3 + kroumirie + mogods + dahar;
    // Chott el Jerid: a flat salt pan.
    const chott = ((lon - 8.35) / 0.58) ** 2 + ((lat - 33.76) / 0.15) ** 2;
    h *= smoothstep(0.7, 1.4, chott) * 0.92 + 0.08;
    // Medjerda valley floor.
    const river = distanceToPolyline(lon, lat, MEDJERDA);
    h = 0.05 + (h - 0.05) * smoothstep(0.02, 0.2, river);
    return h * shore * VERTICAL;
  };
}

/* ----------------------------------------------------------------- build */

export async function buildWorld(quality: Quality, onTerrain: Progress, onValley: Progress): Promise<World> {
  const landTexture = buildLandTexture(quality.mapTexture);
  const field = buildLandField();
  const relief = makeRelief(field);
  const heightAt = (x: number, z: number) => {
    const [lon, lat] = toLonLat(x, z);
    return relief(lon, lat);
  };
  onTerrain(0.1);
  await nextFrame();

  const [sx, sz] = quality.mapSegments;
  const mapGeometry = new THREE.PlaneGeometry(MAP_SIZE.width, MAP_SIZE.depth, sx, sz);
  mapGeometry.rotateX(-Math.PI / 2);
  mapGeometry.translate(MAP_SIZE.centerX, 0, MAP_SIZE.centerZ);
  const position = mapGeometry.attributes.position as THREE.BufferAttribute;
  const rowsPerChunk = 24;
  for (let row = 0; row <= sz; row++) {
    for (let col = 0; col <= sx; col++) {
      const i = row * (sx + 1) + col;
      position.setY(i, heightAt(position.getX(i), position.getZ(i)));
    }
    if (row % rowsPerChunk === 0) {
      onTerrain(0.1 + 0.85 * (row / sz));
      await nextFrame();
    }
  }
  mapGeometry.computeVertexNormals();
  onTerrain(1);
  await nextFrame();

  const valley = await buildValley(heightAt, quality.valleySegments, onValley);
  const places = PLACES.map((place) => {
    const { x, z } = toWorld(place.at);
    return { id: place.id, label: place.label, kind: place.kind, position: new THREE.Vector3(x, heightAt(x, z), z) };
  });
  return { landTexture, mapGeometry, valley, heightAt, places };
}

/* ---------------------------------------------------------------- valley */

/** Flat strip following a polyline; uv.x runs along it, uv.y across. */
function ribbon(points: THREE.Vector3[], width: number) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let travelled = 0;
  points.forEach((p, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    const sx = (-tz / len) * width;
    const sz = (tx / len) * width;
    if (i) travelled += p.distanceTo(points[i - 1]);
    positions.push(p.x + sx, p.y, p.z + sz, p.x - sx, p.y, p.z - sz);
    uvs.push(travelled, 0, travelled, 1);
    if (i) {
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

const CROPS = ['#d4b45a', '#6e8f3e', '#9cc95a', '#5f8a3a', '#b7cf74', '#7a6440', '#c9ef86'].map((hex) => new THREE.Color(hex));

async function buildValley(baseHeight: (x: number, z: number) => number, segments: number, onProgress: Progress): Promise<ValleyLayout> {
  const c = toWorld(VALLEY_CENTER);
  const R = VALLEY_RADIUS;
  const rand = random(1907);

  const reservoirLonLat = PLACES.find((p) => p.id === 'bou-heurtma')!.at;
  const res = toWorld(reservoirLonLat);
  const reservoirRadius = 0.62;
  const riverLine = MEDJERDA.map((p) => {
    const w = toWorld(p);
    return [w.x, w.z] as [number, number];
  });

  // Fine terrain detail, faded at the rim so it meets the map exactly.
  const basin = (x: number, z: number) => {
    const d = Math.hypot((x - res.x) / 1.15, (z - res.z) / 0.85) / reservoirRadius;
    return 1 - smoothstep(0.55, 1.35, d);
  };
  const height = (x: number, z: number) => {
    const rim = 1 - smoothstep(R * 0.55, R * 0.98, Math.hypot(x - c.x, z - c.z));
    const river = distanceToPolyline(x, z, riverLine);
    const floor = smoothstep(0.25, 1.7, river);
    const detail = (fbm(x * 1.9, z * 1.9) - 0.5) * 0.16 * floor + (fbm(x * 7, z * 7, 2) - 0.5) * 0.025;
    const base = baseHeight(x, z);
    const carved = base + detail * rim - basin(x, z) * 0.16 * rim - (1 - smoothstep(0, 0.12, river)) * 0.05 * rim;
    return carved + 0.03;
  };

  const geometry = new THREE.PlaneGeometry(R * 2, R * 2, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(c.x, 0, c.z);
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, height(pos.getX(i), pos.getZ(i)));
  geometry.computeVertexNormals();
  onProgress(0.3);
  await nextFrame();

  /* Valley axis follows the river through the perimeter. */
  const axisAngle = Math.atan2(-(riverLine[3][1] - riverLine[1][1]), riverLine[3][0] - riverLine[1][0]);
  const ax = Math.cos(axisAngle);
  const az = -Math.sin(axisAngle);
  const nx = -az;
  const nz = ax;

  /* Reservoir surface: irregular lake outline. */
  const shape = new THREE.Shape();
  const steps = 72;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = reservoirRadius * (0.82 + 0.3 * fbm(Math.cos(a) * 1.6 + 4, Math.sin(a) * 1.6 + 9, 3));
    const x = Math.cos(a) * r * 1.15;
    const y = Math.sin(a) * r * 0.85;
    if (i) shape.lineTo(x, y);
    else shape.moveTo(x, y);
  }
  const reservoirGeometry = new THREE.ShapeGeometry(shape, 6);
  reservoirGeometry.rotateX(-Math.PI / 2);
  const waterLevel = baseHeight(res.x, res.z) - 0.05;
  const reservoirCenter = new THREE.Vector3(res.x, waterLevel, res.z);

  /* Dam wall at the downstream (south) shore, pump station just below. */
  const damPosition = new THREE.Vector3(res.x + 0.08, waterLevel, res.z + reservoirRadius * 0.78);
  const station = new THREE.Vector3(res.x + 0.42, 0, res.z + reservoirRadius * 1.25);
  station.y = height(station.x, station.z);

  /* Plots: a jittered grid aligned with the valley axis. */
  const plotMatrices: number[] = [];
  const plotColors: number[] = [];
  const plotDelays: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const solarSites = [
    new THREE.Vector3(station.x + 0.42, 0, station.z + 0.05),
    new THREE.Vector3(c.x + ax * 1.6 + nx * 0.85, 0, c.z + az * 1.6 + nz * 0.85),
  ];
  const cellA = 0.36;
  const cellN = 0.27;
  for (let i = -9; i <= 9; i++) {
    for (let j = -6; j <= 6; j++) {
      const along = i * cellA + (rand() - 0.5) * 0.05;
      const across = j * cellN + (j > 0 ? 0.12 : -0.12);
      const x = c.x + ax * along + nx * across;
      const z = c.z + az * along + nz * across;
      const fromCenter = Math.hypot(x - c.x, z - c.z);
      const river = distanceToPolyline(x, z, riverLine);
      if (fromCenter > R * 0.8 || river < 0.16 || river > 1.75) continue;
      if (Math.hypot((x - res.x) / 1.15, (z - res.z) / 0.85) < reservoirRadius * 1.5) continue;
      if (solarSites.some((s) => Math.hypot(x - s.x, z - s.z) < 0.5)) continue;
      if (Math.hypot(x - station.x, z - station.z) < 0.3) continue;
      if (rand() < 0.08) continue;
      const block = fbm(x * 0.9 + 3, z * 0.9 + 11, 2);
      const crop = CROPS[Math.min(CROPS.length - 1, Math.floor(block * CROPS.length * 1.25 + rand() * 1.4) % CROPS.length)];
      const w = cellA * (0.82 + rand() * 0.12);
      const d = cellN * (0.78 + rand() * 0.14);
      const y = height(x, z);
      q.setFromAxisAngle(up, axisAngle + (rand() - 0.5) * 0.04);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(w, 1, d));
      plotMatrices.push(...m.elements);
      plotColors.push(crop.r, crop.g, crop.b);
      plotDelays.push(Math.min(1, Math.hypot(x - station.x, z - station.z) / (R * 1.7)));
    }
  }
  onProgress(0.55);
  await nextFrame();

  /* Solar arrays: rows of panels tilted towards the south (+z). */
  const panelMatrices: number[] = [];
  const panelDelays: number[] = [];
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.5);
  solarSites.forEach((site, s) => {
    const rows = s ? 7 : 5;
    const cols = s ? 12 : 9;
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        const x = site.x + (k - cols / 2) * 0.075;
        const z = site.z + (r - rows / 2) * 0.085;
        const y = height(x, z) + 0.035;
        m.compose(new THREE.Vector3(x, y, z), tilt, new THREE.Vector3(0.068, 0.006, 0.05));
        panelMatrices.push(...m.elements);
        panelDelays.push((k / cols) * 0.6 + (r / rows) * 0.4);
      }
    }
  });

  /* Water network: river ribbon + canal tubes with a running "flow" coordinate. */
  // The national polyline is sparse: densify it first, then keep the stretch crossing the perimeter.
  const riverCurve = new THREE.CatmullRomCurve3(riverLine.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const riverSamples = riverCurve.getSpacedPoints(900)
    .filter((p) => Math.hypot(p.x - c.x, p.z - c.z) < R * 1.02)
    .map((p) => {
      p.y = height(p.x, p.z) + 0.012;
      return p;
    });
  const river = ribbon(riverSamples, 0.045);

  const canalCurves: { points: THREE.Vector3[]; radius: number; start: number }[] = [];
  const lift = (x: number, z: number, extra = 0.022) => new THREE.Vector3(x, height(x, z) + extra, z);
  const head = lift(damPosition.x + 0.05, damPosition.z + 0.1);
  // Main canal: dam → station → valley.
  const valleyEntry = new THREE.Vector3(c.x + nx * -0.42 - ax * 0.3, 0, c.z + nz * -0.42 - az * 0.3);
  const main = [head, lift(station.x - 0.05, station.z + 0.02), lift((station.x + valleyEntry.x) / 2, (station.z + valleyEntry.z) / 2), lift(valleyEntry.x, valleyEntry.z)];
  canalCurves.push({ points: main, radius: 0.016, start: 0 });
  // Distribution mains, on each bank, running along the valley axis.
  for (const side of [-1, 1]) {
    const offset = side * 0.2 + (side > 0 ? 0.12 : -0.12);
    const pts: THREE.Vector3[] = [];
    for (let t = -3.1; t <= 3.1; t += 0.5) {
      const x = c.x + ax * t + nx * offset;
      const z = c.z + az * t + nz * offset;
      if (Math.hypot(x - c.x, z - c.z) < R * 0.82) pts.push(lift(x, z));
    }
    if (pts.length > 2) canalCurves.push({ points: pts, radius: 0.012, start: 0.3 });
  }
  // Laterals between plot columns.
  for (let i = -8; i <= 8; i += 2) {
    for (const side of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 6; j++) {
        const along = i * cellA + cellA / 2;
        const across = side * (0.32 + j * cellN);
        const x = c.x + ax * along + nx * across;
        const z = c.z + az * along + nz * across;
        if (Math.hypot(x - c.x, z - c.z) > R * 0.8) break;
        pts.push(lift(x, z, 0.018));
      }
      if (pts.length > 2) canalCurves.push({ points: pts, radius: 0.0075, start: 0.55 + Math.abs(i) * 0.02 });
    }
  }
  const tubes = canalCurves.map(({ points, radius, start }) => {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const length = curve.getLength();
    const tube = new THREE.TubeGeometry(curve, Math.max(12, Math.round(length * 40)), radius, 5, false);
    const uv = tube.attributes.uv as THREE.BufferAttribute;
    const flow = new Float32Array(uv.count);
    const distance = new Float32Array(uv.count);
    for (let k = 0; k < uv.count; k++) {
      flow[k] = start + uv.getX(k) * (1 - start) * 0.45;
      distance[k] = uv.getX(k) * length;
    }
    tube.setAttribute('aFlow', new THREE.BufferAttribute(flow, 1));
    tube.setAttribute('aDistance', new THREE.BufferAttribute(distance, 1));
    tube.deleteAttribute('normal');
    tube.deleteAttribute('uv');
    return tube;
  });
  const canals = mergeGeometries(tubes)!;
  tubes.forEach((t) => t.dispose());
  onProgress(0.9);
  await nextFrame();

  const plotCentroid = new THREE.Vector3(c.x + ax * -1.1 + nx * 0.7, 0, c.z + az * -1.1 + nz * 0.7);
  plotCentroid.y = height(plotCentroid.x, plotCentroid.z);
  const solarPoi = solarSites[0].clone();
  solarPoi.y = height(solarPoi.x, solarPoi.z);

  onProgress(1);
  return {
    geometry,
    plots: {
      matrices: new Float32Array(plotMatrices), colors: new Float32Array(plotColors),
      delays: new Float32Array(plotDelays), count: plotDelays.length,
    },
    panels: { matrices: new Float32Array(panelMatrices), delays: new Float32Array(panelDelays), count: panelDelays.length },
    reservoir: { geometry: reservoirGeometry, center: reservoirCenter, radius: reservoirRadius },
    river,
    canals,
    dam: { position: damPosition, rotation: 0, width: 0.5 },
    station,
    pois: [
      { id: 'reservoir', label: 'Reservoir', position: reservoirCenter.clone() },
      { id: 'station', label: 'Pumping station', position: station.clone() },
      { id: 'solar', label: 'Solar array', position: solarPoi },
      { id: 'plots', label: 'Irrigated plots', position: plotCentroid },
    ],
    center: new THREE.Vector3(c.x, height(c.x, c.z), c.z),
  };
}
