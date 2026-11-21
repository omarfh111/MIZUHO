import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageEvidence, durationEvidence, type OutageCell } from '../src/resilience.ts';

const cell: OutageCell = { start: 11, duration: 1, status: 'FEASIBLE', coverage_bp: 7000,
  reserve_status: 'unknown', reserve_m3: null, deficit_m3: 4 };

test('a reserve proof or a verified schedule can establish feasibility independently', () => {
  assert.equal(coverageEvidence({ ...cell, reserve_status: 'minimum', reserve_m3: 0 }, 80), 'reachable');
  assert.equal(coverageEvidence({ ...cell, status: 'NO_SOLUTION', coverage_bp: null,
    reserve_status: 'minimum', reserve_m3: 13 }, 80), 'reachable');
  assert.equal(coverageEvidence({ ...cell, reserve_status: 'unreachable' }, 80), 'unreachable');
  assert.equal(coverageEvidence({ ...cell, coverage_bp: 8000 }, 80), 'reachable');
  assert.equal(coverageEvidence(cell, 80), 'unknown');
  assert.equal(coverageEvidence({ ...cell, status: 'OPTIMAL' }, 80), 'unreachable');
  assert.equal(coverageEvidence({ ...cell, status: 'NO_SOLUTION', coverage_bp: null }, 80), 'unknown');
  assert.equal(coverageEvidence({ ...cell, reserve_status: 'no_target', coverage_bp: null }, 80), 'no_target');
});

test('the longest verified cut preserves inconclusive durations and missing targets', () => {
  const row: OutageCell[] = [
    { ...cell, duration: 1, coverage_bp: 8000 },
    { ...cell, duration: 2 },
    { ...cell, duration: 4, reserve_status: 'minimum' },
    { ...cell, duration: 8, reserve_status: 'unreachable' },
  ];
  assert.deepEqual(durationEvidence(row, 80), {
    comparable: true, passing: [1,4], unresolved: [2], longest: 4, ambiguous: false,
  });
  assert.equal(durationEvidence([...row, { ...cell, duration: 10 }], 80).ambiguous, true);
  assert.equal(durationEvidence([{ ...cell, reserve_status: 'no_target', coverage_bp: null }], 80).comparable, false);
  assert.deepEqual(durationEvidence([{ ...cell, reserve_status: 'unreachable' }], 80), {
    comparable: true, passing: [], unresolved: [], longest: undefined, ambiguous: false,
  });
});
