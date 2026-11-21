import assert from 'node:assert/strict';
import test from 'node:test';
import { reliefGeometry, verticalExaggeration, type ReliefGrid } from '../src/components/cityReliefGeometry.ts';

const grid: ReliefGrid = { rows: 2, cols: 2, bounds: [9, 35, 9.1, 35.1], elevations: [20, 30, 90, 100] };

test('terrain preserves the geographical orientation and scales source relief in metres', () => {
  const terrain = reliefGeometry(grid)!;
  const { positions } = terrain;
  assert.deepEqual(terrain.indices, [0, 1, 2, 1, 3, 2]);
  assert.ok(positions[0] < positions[3]);
  assert.ok(positions[2] > positions[8]);
  assert.equal(terrain.low, 20);
  assert.equal(terrain.high, 100);
  assert.ok(Math.abs(positions[10] - verticalExaggeration * 80 * 100 / terrain.depthMetres) < 0.0001);
  assert.ok(terrain.widthMetres < terrain.depthMetres);
  assert.ok(terrain.widthMetres > 9_000 && terrain.widthMetres < 9_200);
});

test('null samples leave holes and preserve a valid below-sea-level altitude', () => {
  const terrain = reliefGeometry({ ...grid, elevations: [null, -35, -20, 15] })!;
  assert.equal(terrain.low, -35);
  assert.equal(terrain.sampleCount, 3);
  assert.deepEqual(terrain.indices, [1, 3, 2]);
  assert.ok(!terrain.rim.includes(0));
});

test('invalid grids and fully unavailable elevation data have no renderable terrain', () => {
  assert.equal(reliefGeometry({ ...grid, elevations: [null, null, null, null] }), null);
  assert.equal(reliefGeometry({ ...grid, elevations: [10, 20] }), null);
  assert.equal(reliefGeometry({ ...grid, bounds: [9.1, 35, 9, 35.1] }), null);
});

test('flat and mountainous grids over identical extents generate different vertex heights', () => {
  const flat = reliefGeometry({ ...grid, elevations: [0, 0, 0, 0] })!;
  const mountain = reliefGeometry({ ...grid, elevations: [0, 250, 340, 1300] })!;
  assert.equal(flat.height, 0);
  assert.equal(flat.positions[10], 0);
  assert.ok(mountain.positions[10] > 30);
});
