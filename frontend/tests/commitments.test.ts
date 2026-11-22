import assert from 'node:assert/strict';
import test from 'node:test';
import { parcelCommitments } from '../src/commitments.ts';
import type { Plan } from '../src/types.ts';

const targets = [
  { plot_id: 'A', deadline_slot: 12, allowed_slots: [8, 12, 14] },
  { plot_id: 'B', deadline_slot: 14, allowed_slots: [10, 16] },
];
const verified: Plan = { status: 'FEASIBLE', warnings: [], metrics: null,
  plot_results: [
    { plot_id: 'A', minimum_m3: 8, delivered_on_time_m3: 7, delivered_m3: 9 },
    { plot_id: 'B', minimum_m3: 0, delivered_on_time_m3: 0, delivered_m3: 0 },
  ], actions: [
    { slot: 8, pump_m3: 0, deliveries: [{ plot_id: 'A', delivered_m3: 4 }] },
    { slot: 12, pump_m3: 0, deliveries: [{ plot_id: 'A', delivered_m3: 3 }] },
    { slot: 14, pump_m3: 0, deliveries: [{ plot_id: 'A', delivered_m3: 2 }] },
  ] };

test('keeps the credited daily total but lists only remaining releases, including the deadline hour', () => {
  const rows = parcelCommitments(targets, verified, 12)!;
  assert.deepEqual(rows.map(row => row.id), ['B', 'A']);
  assert.equal(rows[0].lastEligible, 10);
  assert.equal(rows[0].shortfall, 0);
  const parcel = rows[1];
  assert.equal(parcel.lastEligible, 12);
  assert.equal(parcel.timely, 7);
  assert.equal(parcel.shortfall, 1);
  assert.deepEqual(parcel.remaining, [{ slot: 12, volume: 3 }, { slot: 14, volume: 2 }]);
});

test('unavailable minimums, parcels, actions and solver results remain unknown', () => {
  const plan = { ...verified, actions: null, plot_results: [{ plot_id: 'A', delivered_on_time_m3: 0, delivered_m3: 0 }] };
  for (const row of parcelCommitments(targets, plan, 0)!) {
    assert.equal(row.shortfall, null);
    assert.equal(row.remaining, undefined);
  }
  assert.equal(parcelCommitments(targets, { ...verified, status: 'NO_SOLUTION' }, 0), null);
  assert.equal(parcelCommitments(targets, { ...verified, plot_results: null }, 0), null);
});

test('keeps a due commitment when no eligible on-time slot exists', () => {
  const rows = parcelCommitments([{ plot_id: 'A', allowed_slots: [14], deadline_slot: 12 }], verified, 0)!;
  assert.equal(rows[0].lastEligible, null);
  assert.equal(rows[0].deadline, 12);
  assert.equal(rows[0].shortfall, 1);
});
