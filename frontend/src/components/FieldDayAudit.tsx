import { ChevronDown, ClipboardCheck, Download } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { FIELD_DAY_HEADER, FIELD_DAY_MAX_BYTES, parseFieldDay, type FieldDay } from '../fieldDay.ts';
import { dateLabel } from '../format.ts';
import './field-day.css';

const template = `data:text/csv;charset=utf-8,${encodeURIComponent(`${FIELD_DAY_HEADER}\r\n`)}`;
const volume = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 });
const cubicMetres = (litres: number | null) => litres === null ? 'Unknown' : `${volume.format(litres / 1000)} m³`;

function RecordedResults({ day }: { day: FieldDay }) {
  return <section className="field-day-results" aria-label="Recorded delivery results">
    <h3>{dateLabel(day.date)} · Recorded deliveries</h3>
    <p><strong>{day.measured ? `${day.met} of ${day.measured} assessed commitments met on time.` : 'No deadline measurements available.'}</strong>{' '}
      Deadline readings cover {day.measured} of {day.parcels.length} parcels.
      {day.measured > 0 && <> Total shortfall for those measured parcels was <strong>{cubicMetres(day.measuredShortfallLitres)}</strong>.</>}
    </p>
    <div className="field-day-table" role="region" aria-label="Parcel delivery records" tabIndex={0}>
      <table><caption>Metered delivery volumes supplied by the operator</caption>
        <thead><tr>{['Parcel', 'Last slot (Tunis)', 'Promised minimum', 'By deadline', 'By day end', 'Shortfall at deadline'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{day.parcels.map(parcel => <tr key={parcel.id}>
          <th scope="row" translate="no">{parcel.id}</th><td>{String(parcel.lastSlot).padStart(2, '0')}:00</td>
          <td>{cubicMetres(parcel.minimumLitres)}</td><td>{cubicMetres(parcel.onTimeLitres)}</td>
          <td>{cubicMetres(parcel.dayEndLitres)}</td><td>{cubicMetres(parcel.shortfallLitres)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p>The record describes the service received. Assessing the effect of a different schedule requires matching site, stock, quota, equipment and outage records.</p>
  </section>;
}

type ImportState = { status: 'idle' | 'reading' } | { status: 'error'; message: string } | { status: 'ready'; day: FieldDay };

export default function FieldDayAudit() {
  const [state, setState] = useState<ImportState>({ status: 'idle' });
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);

  function clear() {
    sequence.current++;
    setState({ status: 'idle' });
  }

  async function read(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const request = ++sequence.current;
    setState({ status: 'reading' });
    try {
      if (file.size > FIELD_DAY_MAX_BYTES) throw new Error('The CSV exceeds the 256 KiB limit. Import one delivery day at a time.');
      const day = parseFieldDay(await file.text());
      if (sequence.current === request) setState({ status: 'ready', day });
    } catch (error) {
      if (sequence.current === request) setState({ status: 'error', message: error instanceof Error ? error.message : 'Could not read the file.' });
    }
  }

  return <details className="surface field-day-audit">
    <summary><ClipboardCheck size={22} aria-hidden="true"/><span>Check a recorded delivery day</span><ChevronDown size={17} aria-hidden="true"/></summary>
    <div className="field-day-body">
      <p>Check whether each parcel received its agreed volume on time. Use one completed day of anonymous operator records. Your browser reads the file locally and keeps it in memory until you clear it or leave the page.</p>
      <div className="field-day-inputs">
        <a className="button button-secondary" href={template} download="mizhuo-delivery-day.csv"><Download size={16} aria-hidden="true"/> Download blank CSV</a>
        <label className="field">Recorded delivery CSV<input type="file" accept=".csv,text/csv" onChange={read}/></label>
      </div>
      <details className="field-day-format"><summary>How to fill in the CSV</summary>
        <p>Enter one row per parcel using the six columns in the template. Use commas as separators and a decimal point for volumes (up to three decimal places).</p>
        <dl>
          <dt>date, parcel_id</dt><dd>Use the same local date (YYYY-MM-DD) before today in Tunis and a unique anonymous code for each parcel.</dd>
          <dt>last_slot, minimum_m3</dt><dd>Enter the final eligible hour from 0 to 23 and the promised minimum in m³. Slot 11 includes deliveries from 11:00 until 12:00. Slot 23 ends at midnight.</dd>
          <dt>by_deadline_m3, by_day_end_m3</dt><dd>Enter cumulative volumes delivered to the parcel since local midnight, using meter differences. Leave unavailable readings blank. Enter 0 for a confirmed zero delivery.</dd>
        </dl>
      </details>
      {state.status === 'error' && <p role="alert">{state.message}</p>}
      <div aria-live="polite">{state.status === 'reading' && <p>Reading delivery records…</p>}
        {state.status === 'ready' && <RecordedResults day={state.day}/>}</div>
      {state.status !== 'idle' && <button type="button" className="text-button" onClick={clear}>Clear recorded day</button>}
    </div>
  </details>;
}
