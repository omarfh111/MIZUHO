import assert from 'node:assert/strict';
import test from 'node:test';
import { findCoverSample, sampleSurface } from '../src/components/surfaceSample.ts';
import type { ReliefGrid } from '../src/components/cityReliefGeometry.ts';

const grid: ReliefGrid = { rows: 2, cols: 2, bounds: [8, 34, 9, 35], elevations: [0, 100, 200, 500] };
const cover = { rows: 2, cols: 2, classes: [80, 40, 60, 10] };

test('inspection resolves north-up cover and south-up terrain over the same real coordinates', () => {
  const sample = sampleSurface(grid, cover, { u: .75, v: .75 });
  assert.equal(sample.coverCode, 40);
  assert.equal(sample.longitude, 8.75);
  assert.equal(sample.latitude, 34.75);
  assert.equal(sample.elevation, 325);
  assert.equal(sampleSurface(grid, cover, { u: 1, v: 0 }).coverCode, 10);
  assert.equal(sampleSurface(grid, cover, { u: 0, v: 1 }).coverCode, 80);
});

test('a void triangle or unclassified land-cover cell stays unavailable', () => {
  const sample = sampleSurface({ ...grid, elevations: [0, 100, 200, null] }, { ...cover, classes: [80, null, 60, 10] },
    { u: .75, v: .75 });
  assert.equal(sample.coverCode, null);
  assert.equal(sample.elevation, null);
});

test('keyboard inspection selects a cell actually classified in the displayed texture', () => {
  const p = findCoverSample(cover, 40, { u: 0, v: 0 })!;
  assert.deepEqual(p, { u: .75, v: .75 });
  assert.equal(sampleSurface(grid, cover, p).coverCode, 40);
  assert.equal(findCoverSample(cover, 20, p), null);
});
