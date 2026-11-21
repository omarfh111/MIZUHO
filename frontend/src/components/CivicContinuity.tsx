import { BatteryCharging, ChevronDown, HousePlug } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { runHouseholdContinuity, type HouseholdInputs, type HouseholdResult } from '../api.ts';
import { clockHour, kilo } from '../format.ts';
import './civic.css';

type Circuit = Omit<HouseholdInputs, 'start_hour' | 'duration_hours'>;
type FieldName = keyof Circuit;
const inputs: [FieldName, string, number, number][] = [
  ['households', 'Homes on this circuit', 1, 10000],
  ['essential_w_per_home', 'Continuous essentials per home (W)', 0, 100000],
  ['lighting_w_per_home', 'Additional lighting per home (W)', 0, 100000],
  ['lights_from_hour', 'Lighting starts at hour', 0, 23],
  ['lights_until_hour', 'Lighting ends at hour', 0, 23],
  ['available_ac_wh', 'Usable backup energy at outage start (Wh AC)', 0, 1e9],
  ['island_output_w', 'Island-capable output limit (W)', 0, 1e7],
];
const example: Circuit = { households: 10, essential_w_per_home: 40, lighting_w_per_home: 20,
  lights_from_hour: 18, lights_until_hour: 6, available_ac_wh: 1200, island_output_w: 750 };
const energy = (wh: number) => `${kilo(wh)} kWh`;
const timespan = (minutes: number) => `${Math.floor(minutes / 60)} h ${minutes % 60} min`;

export default function CivicContinuity({ startHour, durationHours, city }: { startHour?: number; durationHours?: number; city?: string }) {
  const [localStart, setStart] = useState('18');
  const [localDuration, setDuration] = useState('4');
  const [values, setValues] = useState<Partial<Record<FieldName, string>>>({});
  const [outcome, setOutcome] = useState<{ key: string; result?: HouseholdResult; error?: string; pending?: boolean }>();
  const request = useRef<AbortController | null>(null);
  const start = startHour ?? Number(localStart);
  const duration = durationHours ?? Number(localDuration);
  const key = JSON.stringify([city, start, duration, values]);
  const current = outcome?.key === key ? outcome : undefined;
  useEffect(() => {
    setOutcome(undefined);
    return () => request.current?.abort();
  }, [city, start, duration]);

  function edit(field: FieldName, value: string) {
    request.current?.abort();
    setOutcome(undefined);
    setValues(fields => ({ ...fields, [field]: value }));
  }

  async function calculate(event: FormEvent) {
    event.preventDefault();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const circuit = Object.fromEntries(inputs.map(([field]) => [field, Number(values[field])])) as Circuit;
    if (circuit.essential_w_per_home + circuit.lighting_w_per_home === 0 ||
      (circuit.lighting_w_per_home > 0 && circuit.lights_from_hour === circuit.lights_until_hour)) {
      setOutcome({ key, error: 'Enter a positive circuit load and a distinct start and end hour for any lighting.' });
      return;
    }
    setOutcome({ key, pending: true });
    try {
      const result = await runHouseholdContinuity({ ...circuit, start_hour: start, duration_hours: duration }, controller.signal);
      if (!controller.signal.aborted) setOutcome({ key, result });
    } catch {
      if (!controller.signal.aborted) setOutcome({ key, error: 'Could not calculate the household balance. Review the inputs and try again.' });
    }
  }

  const result = current?.result;
  return <details className="civic-continuity">
    <summary><HousePlug size={22} aria-hidden="true" /><span>Household electricity during the outage</span><ChevronDown size={18} aria-hidden="true" /></summary>
    <div className="civic-body">
      <p>{city ? `Model an outage in ${city}` : `Replay the selected ${duration}-hour outage starting at ${clockHour(start)}`} for an independent residential circuit.
        Enter the homes, essential loads and usable backup you want to test. The irrigation pump uses a separate supply.</p>
      <form onSubmit={calculate}>
        {startHour === undefined && durationHours === undefined && <div className="civic-times">
          <label className="field">Outage start (local hour)<input type="number" min="0" max="23" step="1" required value={localStart} onChange={e => { setStart(e.target.value); setOutcome(undefined); }} /></label>
          <label className="field">Outage duration (hours)<input type="number" min="1" max="24" step="1" required value={localDuration} onChange={e => { setDuration(e.target.value); setOutcome(undefined); }} /></label>
        </div>}
        <div className="civic-fields">{inputs.map(([field, label, min, max]) => <label className="field" key={field}>
          {label}<input type="number" min={min} max={max} step="1" required value={values[field] ?? ''} onChange={e => edit(field, e.target.value)} />
        </label>)}</div>
        <p>Enter AC energy available after battery losses. Use zero output for a grid-only circuit. The backup supplies these loads without recharging during the outage.</p>
        <div className="civic-actions">
          <button type="submit" disabled={current?.pending} className="button button-primary"><BatteryCharging size={16} />{current?.pending ? 'Calculating…' : 'Calculate household continuity'}</button>
          <button type="button" className="text-button" onClick={() => {
            request.current?.abort(); setOutcome(undefined);
            setValues(Object.fromEntries(inputs.map(([field]) => [field, String(example[field])])));
          }}>Load example circuit</button>
        </div>
      </form>
      {current?.error && <p role="alert">{current.error}</p>}
      {result && <section className="civic-results" aria-label="Simulated household continuity" aria-live="polite">
        <h3>{result.demand_wh === 0 ? 'No household load scheduled during this outage' :
          result.first_shortfall_after_minutes == null ? 'All essential loads covered for this outage' :
          `First shortfall after ${timespan(result.first_shortfall_after_minutes)}`}</h3>
        <dl><div><dt>Backup delivered</dt><dd>{energy(result.supplied_wh)}</dd></div>
          <div><dt>Unserved electricity</dt><dd>{energy(result.unserved_wh)}</dd></div></dl>
        <p>To cover every hour, this circuit needs {energy(result.demand_wh)} of usable energy and at least {result.minimum_island_output_w.toLocaleString('en-GB')} W of island-capable output.</p>
        <details><summary>Hourly household balance</summary><div className="civic-hourly"><table>
          <thead><tr><th>Hour</th><th>Demand (Wh)</th><th>Served (Wh)</th><th>Unserved (Wh)</th><th>Reserve (Wh)</th></tr></thead>
          <tbody>{result.hours.map(row => <tr key={`${row.day_offset}-${row.hour}`}><th scope="row">{clockHour(row.hour)}{row.day_offset ? ' (+1 day)' : ''}</th>
            <td>{row.demand_wh}</td><td>{row.supplied_wh}</td><td>{row.unserved_wh}</td><td>{row.remaining_ac_wh}</td></tr>)}</tbody>
        </table></div></details>
      </section>}
      <p className="civic-source">Household loads and backup equipment are scenario assumptions. <a href="https://www.energy.gov/cmei/systems/solar-and-resilience-basics" rel="noreferrer" target="_blank">How islanded backup works ↗</a></p>
    </div>
  </details>;
}
