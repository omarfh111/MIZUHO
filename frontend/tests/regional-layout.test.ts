import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import type { FieldZone } from '../src/types.ts';
import { regionalLayout } from '../src/components/regionalLayout.ts';
import { sampleSurface } from '../src/components/surfaceSample.ts';
import { tankDimensionScale } from '../src/components/stationVariant.ts';

test('every regional network reaches its own M6 crop anchors over dry mapped cells', () => {
  const signatures = new Set<string>();
  const directory = new URL('../../data/field_zones/', import.meta.url);
  const files = readdirSync(directory).filter(name => name.endsWith('.json'));
  assert.ok(files.length >= 6);
  for (const file of files) {
    const profile: FieldZone = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
    const layout = regionalLayout(profile);
    assert.ok(layout);
    const { relief, land_cover: cover } = profile;
    assert.equal(sampleSurface(relief, cover, layout.station).coverCode, 40);
    for (const sector of layout.sectors) {
      assert.ok(sector.path.length > 1);
      assert.deepEqual(sector.path[0], layout.station);
      assert.deepEqual(sector.path.at(-1), sector.point);
      assert.equal(sampleSurface(relief, cover, sector.point).coverCode, 40);
      assert.equal(sector.point.u < .5, sector.id === 'west');
      for (const point of sector.path) {
        const sample = sampleSurface(relief, cover, point);
        assert.ok(sample.elevation !== null && sample.coverCode && [10, 20, 30, 40, 50, 60].includes(sample.coverCode));
      }
    }
    signatures.add(JSON.stringify(layout.sectors.map(s => s.path)));
    assert.deepEqual(layout, regionalLayout(profile));
  }
  assert.equal(signatures.size, files.length);
});

test('storage upgrades scale vessel dimensions by relative volume and keep the nominal installation intact', () => {
  assert.equal(tankDimensionScale(), 1);
  assert.equal(tankDimensionScale(1), 1);
  assert.equal(tankDimensionScale(8), 2);
  assert.ok(Math.abs(tankDimensionScale(1.5) ** 3 - 1.5) < 1e-9);
});
