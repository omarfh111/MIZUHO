import assert from 'node:assert/strict';
import test from 'node:test';
import { FIELD_DAY_HEADER, FIELD_DAY_MAX_BYTES, parseFieldDay } from '../src/fieldDay.ts';

const today = '2026-11-22';
const read = (...records: string[]) => parseFieldDay([FIELD_DAY_HEADER, ...records].join('\r\n'), today);

test('service assessment uses each measured deadline, caps surplus and preserves unknown readings', () => {
  const day = read('2026-11-20,A,11,10,0,12', '2026-11-20,B,12,4.287,4.3,', '2026-11-20,C,23,7,,7');
  assert.equal(day.date, '2026-11-20');
  assert.deepEqual(day.parcels.map(p => [p.shortfallLitres, p.dayEndLitres]), [[10000, 12000], [0, null], [null, 7000]]);
  assert.deepEqual([day.measured, day.met, day.measuredShortfallLitres], [2, 1, 10000]);
});

test('blank optional readings cannot establish a measured total even for a known empty day-end meter', () => {
  const day = read('2026-11-20,P1,9,6,,0', '2026-11-20,P2,10,3,,');
  assert.equal(day.measured, 0);
  assert.equal(day.measuredShortfallLitres, null);
});

test('quoted spreadsheet cells, UTF-8 BOM, leap day and decimal meter precision are supported', () => {
  const csv = '\ufeff' + FIELD_DAY_HEADER.split(',').map(c => `"${c}"`).join(',') + '\r\n"2024-02-29","A-1",09,0.3,0.1,0.3\r\n';
  const day = parseFieldDay(csv, today);
  assert.equal(day.parcels[0].lastSlot, 9);
  assert.equal(day.measuredShortfallLitres, 200);
});

test('data must describe one completed local day, with one row per parcel', () => {
  for (const date of [today, '2026-11-23', '2025-02-29', '2026-13-01', '2026-7-1']) {
    assert.throws(() => read(`${date},P1,11,2,0,0`), /completed day/);
  }
  assert.throws(() => read('2026-11-20,A,9,1,,', '2026-11-19,B,9,1,,'), /same local/);
  assert.throws(() => read('2026-11-20,p-1,9,1,,', '2026-11-20,P-1,10,1,,'), /already/);
});

test('volumes, slots and meter monotonicity are validated before accepting any rows', () => {
  for (const amount of ['-1', 'NaN', '1e4', '0.0001', '1000000000']) {
    assert.throws(() => read(`2026-11-20,A,8,2,${amount},`), /non-negative volume/);
  }
  for (const slot of ['24', '-1', '10.5', '']) {
    assert.throws(() => read(`2026-11-20,A,${slot},1,,`), /whole hour/);
  }
  assert.throws(() => read('2026-11-20,A,11,0,,'), /greater than zero/);
  assert.throws(() => read('2026-11-20,A,11,2,1,0.5'), /day-end delivery/);
  assert.throws(() => read('2026-11-20,A,23,2,1,3'), /both readings/);
  assert.equal(read('2026-11-20,A,23,2,2,2').met, 1);
});

test('rejects incomplete templates, personal free text, malformed and oversized files', () => {
  assert.throws(() => read(), /at least one/);
  assert.throws(() => parseFieldDay('date,parcel', today), /six columns/);
  assert.throws(() => read('2026-11-20,A,9,5,3'), /six columns/);
  assert.throws(() => read('2026-11-20,=SUM(A1),9,5,3,4'), /parcel code/);
  assert.throws(() => parseFieldDay('A'.repeat(FIELD_DAY_MAX_BYTES + 1), today), /256 KiB/);
  assert.throws(() => read(...Array.from({ length: 1001 }, (_, i) => `2026-11-20,P${i},11,1,1,1`)), /1,000 parcels/);
});
