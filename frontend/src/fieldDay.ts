export const FIELD_DAY_HEADER = 'date,parcel_id,last_slot,minimum_m3,by_deadline_m3,by_day_end_m3';
export const FIELD_DAY_MAX_BYTES = 256 * 1024;

export interface ParcelRecord {
  id: string;
  lastSlot: number;
  minimumLitres: number;
  onTimeLitres: number | null;
  dayEndLitres: number | null;
  shortfallLitres: number | null;
}

export interface FieldDay {
  date: string;
  simulatedSite?: string;
  parcels: ParcelRecord[];
  measured: number;
  met: number;
  measuredShortfallLitres: number | null;
}

// Both supported formats contain only constrained identifiers, dates and numbers.
function cells(line: string) {
  return line.split(',').map(cell => cell.trim().replace(/^"([^"]*)"$/, '$1'));
}

function litres(text: string, row: number, column: string): number {
  if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(text)) {
    throw new Error(`Row ${row}: ${column} needs a non-negative volume in m³ with up to nine whole digits and three decimal places.`);
  }
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
}

function localToday(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function parseFieldDay(csv: string, today = localToday()): FieldDay {
  if (csv.length > FIELD_DAY_MAX_BYTES) throw new Error('The CSV exceeds the 256 KiB limit. Import one delivery day at a time.');
  const lines = csv.trim().split(/\r\n|\n|\r/);
  const header = cells(lines[0]).join(',');
  const simulated = header === `${FIELD_DAY_HEADER},simulated_site`;
  if (!simulated && header !== FIELD_DAY_HEADER) throw new Error('Use the six columns in the order shown in the blank template, separated by commas.');
  const parcels: ParcelRecord[] = [];
  const ids = new Set<string>();
  let date = '';
  let simulatedSite: string | undefined;
  let measured = 0;
  let met = 0;
  let measuredShortfallLitres = 0;
  for (let index = 1; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    const row = index + 1;
    if (parcels.length >= 1000) throw new Error('Import up to 1,000 parcels for one delivery day.');
    const values = cells(lines[index]);
    if (simulated) {
      const site = values[6];
      if (values.length !== 7 || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(site) || (simulatedSite && site !== simulatedSite)) {
        throw new Error('Keep the same simulated site identifier on every example row.');
      }
      simulatedSite = site;
    } else if (values.length !== 6) {
      throw new Error(`Row ${row}: supply six columns. Keep the comma for a missing reading.`);
    }
    const [localDate, id, slot, minimum, onTime, dayEnd] = values;
    const stamp = Date.parse(`${localDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || Number.isNaN(stamp) || new Date(stamp).toISOString().slice(0, 10) !== localDate || localDate >= today) {
      throw new Error(`Row ${row}: enter a completed day before today in Tunis as YYYY-MM-DD.`);
    }
    if (date && date !== localDate) throw new Error(`Row ${row}: all parcels must belong to the same local delivery day.`);
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) throw new Error(`Row ${row}: enter a parcel code of 1–32 letters, digits, hyphens or underscores, starting with a letter or digit.`);
    if (ids.has(id.toLowerCase())) throw new Error(`Row ${row}: this parcel code already has a commitment for the day.`);
    if (!/^\d{1,2}$/.test(slot) || Number(slot) > 23) throw new Error(`Row ${row}: last_slot must be a whole hour from 0 through 23.`);
    const minimumLitres = litres(minimum, row, 'minimum_m3');
    if (!minimumLitres) throw new Error(`Row ${row}: minimum_m3 must be greater than zero for a delivery commitment.`);
    const onTimeLitres = onTime === '' ? null : litres(onTime, row, 'by_deadline_m3');
    const dayEndLitres = dayEnd === '' ? null : litres(dayEnd, row, 'by_day_end_m3');
    if (onTimeLitres !== null && dayEndLitres !== null) {
      if (dayEndLitres < onTimeLitres) throw new Error(`Row ${row}: the day-end delivery cannot be less than the volume delivered by the deadline.`);
      if (Number(slot) === 23 && dayEndLitres !== onTimeLitres) throw new Error(`Row ${row}: the deadline is the end of the day, so both readings must agree.`);
    }
    const shortfallLitres = onTimeLitres === null ? null : Math.max(0, minimumLitres - onTimeLitres);
    if (shortfallLitres !== null) {
      measured++;
      measuredShortfallLitres += shortfallLitres;
      if (shortfallLitres === 0) met++;
    }
    date = localDate;
    ids.add(id.toLowerCase());
    parcels.push({ id, lastSlot: Number(slot), minimumLitres, onTimeLitres, dayEndLitres, shortfallLitres });
  }
  if (!parcels.length) throw new Error('Add at least one parcel commitment beneath the header.');
  return { date, simulatedSite, parcels, measured, met, measuredShortfallLitres: measured ? measuredShortfallLitres : null };
}
