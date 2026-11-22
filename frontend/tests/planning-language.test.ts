import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../src/i18n/language.ts';

test('Japanese regional outputs preserve computed volumes, deadlines and coverage', () => {
  assert.equal(translate('6 of 13 m³ delivered on time.', 'ja'), '需要量13 m³のうち、期限内の配水量は6 m³です。');
  assert.equal(translate('West sector falls 2 m³ short by the 18:00 slot.', 'ja'), '西区画は18:00の時間枠までに2 m³不足します。');
  assert.equal(translate('11:00, 4 h, 75 % plan coverage, target: Reachable', 'ja'),
    '11:00から4時間・計画の充足率 75 %・目標 達成可能');
  assert.equal(translate('6 of 13 m³ delivered on time.', 'en'), '6 of 13 m³ delivered on time.');
});

test('Japanese field-record feedback distinguishes a missing reading from a zero', () => {
  assert.match(translate('No deadline measurements available.', 'ja'), /実測値がありません/);
  assert.equal(translate('0 of 3 assessed commitments met on time.', 'ja'), '評価対象3件中、0件が期限内に達成されました。');
  assert.match(translate('Row 8: last_slot must be a whole hour from 0 through 23.', 'ja'), /8行目：last_slotには0～23/);
});
