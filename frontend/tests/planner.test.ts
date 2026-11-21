import assert from 'node:assert/strict';
import test from 'node:test';
import { demoScenarios } from '../src/demo/catalog.ts';
import { demoCompare } from '../src/demo/planner.ts';
import type { CompareRequest, Scenario } from '../src/types.ts';

function scenario(id: string): Scenario {
  return structuredClone(demoScenarios.find((entry) => entry.id === id)!);
}

function request(input: Scenario, overrides: Partial<CompareRequest> = {}): CompareRequest {
  return {
    scenario_id: input.id, state: input.state,
    outage_slots: input.slots.filter(({ grid_available }) => !grid_available).map(({ slot }) => slot),
    solar_option_id: null, planning_mode: input.weather_pair_id ? 'weather_buffer' : 'nominal',
    weather_pair_id: input.weather_pair_id,
    ...overrides,
  };
}

test('the miniature case shares the observed 10 m³ evenly during outages', () => {
  const input = scenario('mini');
  const result = demoCompare(input, request(input));
  assert.equal(result.baseline.metrics!.worst_coverage_bp, 0);
  assert.equal(result.optimized.metrics!.worst_coverage_bp, 5000);
  assert.deepEqual(result.optimized.actions!.map((action) => action.deliveries[0]?.delivered_m3), [5, 5]);
  assert.equal(result.optimized.metrics!.pump_wh, 0);
});

test('the announced outage can be covered by prefilling from solar', () => {
  const input = scenario('mini');
  const state = { ...input.state, current_slot: 0, tank_stock_m3: 0, quota_remaining_m3: 10 };
  const result = demoCompare(input, request(input, { state }));
  assert.equal(result.baseline.metrics!.delivered_m3, 0);
  assert.equal(result.optimized.actions![0].pump_m3, 10);
  assert.equal(result.optimized.metrics!.worst_coverage_bp, 5000);
  assert.equal(result.optimized.metrics!.pump_wh, 5000);
  assert.equal(result.optimized.metrics!.grid_wh, 0);
});

test('unavailable gravity and the restart cap are enforced by both plans', () => {
  const noGravity = scenario('mini');
  noGravity.site.gravity_max_m3_per_slot = 0;
  const unavailable = demoCompare(noGravity, request(noGravity));
  assert.equal(unavailable.baseline.metrics!.delivered_m3, 0);
  assert.equal(unavailable.optimized.metrics!.delivered_m3, 0);
  const restarting = scenario('mini');
  const state = { ...restarting.state, tank_stock_m3: 0, quota_remaining_m3: 10 };
  const result = demoCompare(restarting, request(restarting, { state, outage_slots: [1], restart_grid_cap_w: 3000 }));
  for (const plan of [result.baseline, result.optimized]) {
    assert.equal(plan.actions![0].pump_m3, 0);
    assert.equal(plan.actions![1].pump_m3, 6);
    assert.equal(plan.metrics!.peak_grid_w, 3000);
    assert.equal(plan.metrics!.quota_remaining_m3, 4);
  }
});

test('weather risk advances 2 m³ before 11 h and covers the 8 m³ minimum', () => {
  const input = scenario('jplus1');
  const result = demoCompare(input, request(input)).weather_comparison!;
  assert.equal(result.early_pump_m3, 2);
  assert.equal(result.before_slot, 11);
  assert.equal(result.expected_stock_m3, 3);
  assert.equal(result.remaining_deficit_m3, 0);
  assert.equal(result.reference_on_adverse.metrics!.delivered_on_time_m3, 6);
  assert.equal(result.buffer_on_adverse.metrics!.delivered_on_time_m3, 8);
  assert.equal(result.reference_on_adverse.metrics!.withdrawn_m3, 5);
  assert.equal(result.buffer_on_adverse.metrics!.withdrawn_m3, 7);
  assert.equal(result.reference_on_adverse.metrics!.grid_wh, 0);
  assert.equal(result.buffer_on_adverse.metrics!.grid_wh, 0);
});

test('a stable profile needs no reserve and a tight quota preserves the deficit', () => {
  const stable = scenario('jplus1-stable');
  const noRisk = demoCompare(stable, request(stable)).weather_comparison!;
  assert.equal(noRisk.early_pump_m3, 0);
  assert.equal(noRisk.remaining_deficit_m3, 0);
  const input = scenario('jplus1');
  const state = { ...input.state, quota_remaining_m3: 5 };
  const limited = demoCompare(input, request(input, { state })).weather_comparison!;
  assert.equal(limited.remaining_deficit_m3, 2);
  assert.equal(limited.buffer_on_adverse.metrics!.withdrawn_m3, 5);
});

test('every demonstration plan respects the hydraulic and energy balance', () => {
  for (const input of demoScenarios) {
    const parameters = request(input, { restart_grid_cap_w: 3000, solar_option_id: 'ombriere' });
    const result = demoCompare(input, parameters);
    for (const plan of [result.baseline, result.optimized]) {
      let stock = parameters.state.tank_stock_m3;
      let quota = parameters.state.quota_remaining_m3;
      for (const action of plan.actions!) {
        assert.ok(action.slot >= parameters.state.current_slot, input.id);
        assert.ok(action.pump_m3 <= input.site.pump_max_m3_per_slot, input.id);
        assert.ok(action.deliveries.length <= 1, input.id);
        if (parameters.outage_slots.includes(action.slot)) assert.equal(action.pump_m3, 0, input.id);
        else if (parameters.outage_slots.includes(action.slot - 1)) assert.ok(action.grid_wh! <= 3000, input.id);
        quota -= action.pump_m3;
        stock += action.pump_m3;
        assert.ok(quota >= 0 && stock <= input.site.tank_capacity_m3, input.id);
        stock -= action.deliveries.reduce((total, delivery) => total + delivery.delivered_m3, 0);
        assert.ok(stock >= 0, input.id);
        assert.equal(stock, action.tank_stock_m3, input.id);
        assert.equal(quota, action.quota_remaining_m3, input.id);
      }
    }
  }
});
