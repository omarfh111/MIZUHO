import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../src/i18n/language.ts';
import { commonJa } from '../src/i18n/common.ts';
import { exploreJa } from '../src/i18n/explore.ts';
import { planningJa } from '../src/i18n/planning.ts';
import { guardianJa, guardianTn } from '../src/i18n/guardian.ts';
import { tunisianMessages } from '../src/i18n/tunisianMessages.ts';

test('Tunisian covers the same static dashboard and accessibility controls as Japanese', () => {
  for (const source of Object.keys({ ...commonJa, ...exploreJa, ...planningJa })) {
    assert.ok(tunisianMessages[source]?.trim(), source);
  }
  for (const source of Object.keys(guardianJa)) assert.ok(guardianTn[source]?.trim(), source);
  for (const source of Object.keys(guardianTn)) assert.notEqual(translate(source, 'ja'), source);
});

test('Tunisian keeps dates, units, plot IDs and computed volumes intact', () => {
  const scenarios = [
    ['Plot B (EXP-02): 5 m³ by its deadline, 8 m³ minimum and 10 m³ total demand.', ['B', 'EXP-02', '5 m³', '8 m³', '10 m³']],
    ['11:00, 4 h, 75 % plan coverage, target: Reachable', ['11:00', '4', '75 %']],
    ['13 m³ unaccounted for', ['13 m³']],
    ['Compare complete archives for 1 Jul 2025 – 7 Jul 2025. Rainfall and sunlight can guide field visits. Local demand and allocations are needed to establish irrigation urgency.', ['1 جويلية 2025', '7 جويلية 2025']],
  ] as const;
  for (const [source, values] of scenarios) {
    const localized = translate(source, 'aeb');
    assert.match(localized, /[ء-ي]/);
    for (const value of values) assert.ok(localized.includes(value), value + ' in ' + localized);
  }
  assert.notEqual(translate('Missing', 'aeb'), translate('0', 'aeb'));
  assert.equal(translate('Sfax', 'aeb'), 'صفاقس');
});
