import assert from 'node:assert/strict';
import test from 'node:test';
import { demoScenarios } from '../src/demo/catalog.ts';
import { defaultOperating, parseOperating } from '../src/operating.ts';

const mini = demoScenarios.find((s) => s.id === 'mini')!;
test('untouched operating controls preserve the existing comparison request', () => {
  assert.deepEqual(parseOperating(defaultOperating(mini), mini, false, [1, 2]), { fields: {}, errors: {} });
});

test('derived constraints preserve zero limits and reject demand below a registered minimum', () => {
  const inputs = { ...defaultOperating(mini), pump: '0', grid: '0', solar: '0', gravity: false, demand: { A: '9', B: '15' } };
  const { fields, errors } = parseOperating(inputs, mini, false, [1, 2]);
  assert.equal(fields.overrides?.pump_max_m3_per_slot, 0);
  assert.equal(fields.overrides?.grid_cap_w, 0);
  assert.equal(fields.overrides?.solar_percent, 0);
  assert.equal(fields.overrides?.gravity_available, false);
  assert.equal(fields.overrides?.demand_by_plot_m3?.B, 15);
  assert.ok(errors['overrides.demand_by_plot_m3.A']);
});

test('incident replay respects outage hours and excludes archived profiles in paired weather mode', () => {
  const inputs = { ...defaultOperating(mini), profile: 'toiture' as const, event: 'unexpected_outage' as const, start: 1, duration: 1 };
  assert.ok(parseOperating(inputs, mini, false, [1]).errors.incident);
  assert.deepEqual(parseOperating(inputs, mini, false, []).fields.incident, { kind: 'unexpected_outage', start_slot: 1, duration_slots: 1 });
  assert.deepEqual(parseOperating(inputs, mini, true, []).fields, {});
});
