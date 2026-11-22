import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, compareRotation, type RotationResult } from '../api.ts';
import { clockHour, kilo, percent, value } from '../format.ts';
import type { StressPlan } from '../resilience.ts';
import type { Plan } from '../types.ts';
import './operator-rotation.css';

interface Props { siteId: string; plan: StressPlan; plotIds: string[]; horizon: number }
interface Draft { hour: number; pump: string; plot: string; delivery: string }
const emptyHour = (hour: number): Draft => ({ hour, pump: '0', plot: '', delivery: '0' });
const validAmount = (raw: string) => /^\d+$/.test(raw) && Number(raw) <= 100_000;

function RotationComparison({ result }: { result: RotationResult }) {
  const measures: [string, (plan: Plan) => string][] = [
    ['Delivered on time', p => `${value(p.metrics?.delivered_on_time_m3)} m³`],
    ['Least-served coverage', p => percent(p.metrics?.worst_coverage_bp)],
    ['Water withdrawn', p => `${value(p.metrics?.withdrawn_m3)} m³`],
    ['Grid energy', p => `${kilo(p.metrics?.grid_wh)} kWh`],
  ];
  return <section aria-label="Rotation replay results" aria-live="polite">
    <h3>Simulated daily service</h3>
    <table><caption>Same initial stock, quota, delivery windows and equipment</caption>
      <thead><tr><th scope="col">Daily result</th><th scope="col">Your rotation</th><th scope="col">Solver plan</th></tr></thead>
      <tbody>{measures.map(([label, read]) => <tr key={label}><th scope="row">{label}</th>
        <td>{read(result.operator)}</td><td>{read(result.optimized)}</td></tr>)}</tbody></table>
    <p>Solver status · {result.optimized.status.replaceAll('_', ' ').toLowerCase()}.</p>
    <table><caption>Your requested volumes and the amounts the site can serve (m³)</caption>
      <thead><tr><th scope="col">Hour / parcel</th><th scope="col">Pump<br/>requested → feasible</th>
        <th scope="col">Delivery<br/>requested → feasible</th></tr></thead>
      <tbody>{result.hours.map(row => <tr key={row.hour}><th scope="row">{clockHour(row.hour)} · {row.plot_id ?? 'No delivery'}</th>
        <td>{value(row.pump_m3)} → {value(row.feasible_pump_m3)}</td>
        <td>{value(row.delivery_m3)} → {value(row.feasible_delivery_m3)}</td></tr>)}</tbody></table>
  </section>;
}

function Editor({ siteId, plan, plotIds, horizon }: Props) {
  const [rows, setRows] = useState<Draft[]>(() => [emptyHour(0)]);
  const [result, setResult] = useState<RotationResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const hours = Array.from({ length: horizon }, (_, hour) => hour);
  const nextHour = hours.find(h => rows.every(r => r.hour !== h));
  const valid = rows.length > 0 && rows.every(r => validAmount(r.pump) && validAmount(r.delivery)
    && (Number(r.delivery) === 0 || plotIds.includes(r.plot))) && new Set(rows.map(r => r.hour)).size === rows.length;

  function edit(next: Draft[]) {
    pending.current?.abort();
    setBusy(false);
    setResult(undefined);
    setError('');
    setRows(next);
  }
  function update(index: number, changes: Partial<Draft>) {
    edit(rows.map((row, i) => i === index ? { ...row, ...changes } : row));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const values = rows.map(r => ({ hour: r.hour, pump_m3: Number(r.pump), plot_id: r.plot || null,
        delivery_m3: Number(r.delivery) }));
      const reply = await compareRotation(siteId, plan, values, controller.signal);
      if (!controller.signal.aborted) setResult(reply);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof ApiError
        ? Object.values(failure.fields).join(' ') || failure.message : 'The rotation could not be replayed.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <details className="surface operator-rotation">
    <summary>Compare your own rotation</summary>
    <p>Enter the pumping and parcel deliveries you would request in each hour. Omitted hours stay idle.
      Both schedules use the assumptions of this planning day.</p>
    <form onSubmit={submit}>
      {rows.map((row, index) => <div className="rotation-hour" key={index}>
        <label>Hour<select aria-label={`Hour ${index + 1}`} value={row.hour} onChange={e => update(index, { hour: Number(e.target.value) })}>
          {hours.map(h => <option key={h} value={h} disabled={rows.some((r, i) => i !== index && r.hour === h)}>{clockHour(h)}</option>)}</select></label>
        <label>Pump (m³)<input aria-label={`Pump requested (m³) ${index + 1}`} type="number" min="0" max="100000" step="1"
          required value={row.pump} onChange={e => update(index, { pump: e.target.value })}/></label>
        <label>Parcel<select aria-label={`Parcel ${index + 1}`} value={row.plot} onChange={e => update(index, { plot: e.target.value })}>
          <option value="">No parcel</option>{plotIds.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
        <label>Delivery (m³)<input aria-label={`Delivery requested (m³) ${index + 1}`} type="number" min="0" max="100000" step="1"
          required value={row.delivery} onChange={e => update(index, { delivery: e.target.value })}/></label>
        {rows.length > 1 && <button className="text-button" type="button" aria-label={`Remove hour ${index + 1}`}
          onClick={() => edit(rows.filter((_, i) => i !== index))}>Remove</button>}
      </div>)}
      {!valid && <p role="alert">Use whole cubic metres from 0 to 100,000. Select a parcel for each positive delivery.</p>}
      <div className="rotation-controls"><button className="button button-secondary" type="button" disabled={nextHour == null}
        onClick={() => nextHour != null && edit([...rows, emptyHour(nextHour)])}>Add hour</button>
        <button className="button button-primary" disabled={!valid || busy}>{busy ? 'Replaying…' : 'Replay rotation'}</button></div>
    </form>
    {error && <p role="alert">{error}</p>}
    {result && <RotationComparison result={result}/>}
  </details>;
}

export default function OperatorRotation(props: Props) {
  const { plan } = props;
  if ('scenario_id' in plan && (plan.incident || plan.weather_pair_id || plan.planning_mode === 'weather_buffer'
    || plan.state.current_slot !== 0 || Object.values(plan.state.delivered_by_plot_m3).some(Boolean)
    || Object.values(plan.state.delivered_on_time_by_plot_m3).some(Boolean))) return null;
  return <Editor key={JSON.stringify([props.siteId, plan])} {...props}/>;
}
