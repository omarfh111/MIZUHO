import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { CHAPTERS } from '../src/experience/core/content.ts';
import { translate } from '../src/i18n/language.ts';
import type { FieldZone, TunisiaCatalog } from '../src/types.ts';

const data = new URL('../../data/', import.meta.url);

function checkJapanese(source: string) {
  assert.match(translate(source, 'ja'), /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, source);
  assert.equal(translate(source, 'en'), source);
}

test('all catalogued capitals and regional water questions, evidence limits and missing measurements are bilingual', () => {
  const atlas = JSON.parse(readFileSync(new URL('tunisia/catalog.json', data), 'utf8')) as TunisiaCatalog;
  for (const city of atlas.cities) {
    checkJapanese(city.name);
    assert.ok(translate(`View ${city.name}`, 'ja').includes(translate(city.name, 'ja')));
  }
  const regions = new URL('field_zones/', data);
  for (const file of readdirSync(regions).filter(name => name.endsWith('.json'))) {
    const zone: FieldZone = JSON.parse(readFileSync(new URL(file, regions), 'utf8'));
    const { label, locality, description } = zone.site.properties;
    for (const field of [label, locality, description, zone.water_question, zone.evidence.limitation, ...zone.missing_inputs]) {
      assert.ok(field);
      checkJapanese(field);
    }
  }
});

test('cinematic headline lines translate before animation splits them into words', () => {
  for (const chapter of CHAPTERS) {
    checkJapanese(chapter.body);
    for (const line of chapter.title) {
      if (line !== 'MIZUHO') checkJapanese(line);
    }
  }
});

test('Japanese fact cards preserve the sector allocation, assumed demand and archived climate evidence', () => {
  const sector = 'Hypothetical west sector: 7 m³ delivered by the deadline against 30 m³ assumed demand.';
  assert.equal(translate(sector, 'ja'), '仮想西区画：想定需要30 m³のうち、期限までに7 m³を配水しました。');
  const archive = 'Kairouan mean air temperature: 13.6 °C (2025-01-01 to 2025-01-31, 31 days, NASA POWER daily).';
  assert.equal(translate(archive, 'ja'), 'カイロアンの平均気温は13.6 °C（2025-01-01～2025-01-31、31日間、NASA POWER daily）。');
});
