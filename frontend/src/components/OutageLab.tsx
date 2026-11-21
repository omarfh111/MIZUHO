import { ArrowLeft, ArrowRight, BatteryCharging, ChevronDown, Grid2X2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, getOutageCase, getOutageGrid } from '../api.ts';
import { clockHour, kilo, percent, value } from '../format.ts';
import { coverageEvidence, durationEvidence, unmetMinimum, type CaseSettings, type Fault, type OutageCase, type OutageCell, type OutageGrid,
  type ReserveStatus, type ShareRule, type StressPlan } from '../resilience.ts';
import type { FieldZone, Plan, Site } from '../types.ts';
import CivicContinuity from './CivicContinuity.tsx';
import OutageReplay from './OutageReplay.tsx';
import './outage-lab.css';

export function OutageEntry({ open }: { open: () => void }) {
  return <aside className="outage-entry surface"><div className="outage-symbol"><Grid2X2 size={22}/></div>
    <div><strong>Outage resilience</strong><p>How long can this site meet its water commitments during a power cut?</p></div>
    <button type="button" className="button button-secondary" onClick={open}>Test outage resilience <ArrowRight size={16}/></button>
  </aside>;
}

const ruleNames: Record<ShareRule, string> = { fixed: 'Fixed turn', fair: 'Fair coverage', urgent: 'Urgent parcel first' };
const sharingRules: ShareRule[] = ['fixed', 'fair', 'urgent'];
const sharingMeasures: { label: string; format: (plan: Plan) => string }[] = [
  { label: 'Delivered on time', format: p => `${value(p.metrics?.delivered_on_time_m3)} m³` },
  { label: 'Water withdrawn', format: p => `${value(p.metrics?.withdrawn_m3)} m³` },
  { label: 'Grid electricity', format: p => `${kilo(p.metrics?.grid_wh)} kWh` },
  { label: 'Least served', format: p => percent(p.metrics?.worst_coverage_bp) },
  { label: 'Unmet minimum', format: p => `${value(unmetMinimum(p))} m³` },
];
const alternativeNames = { current: 'Current installation', larger_tank: 'Larger reservoir', backup: 'Islandable pump backup' };
const defaultSettings: CaseSettings = { heat_percent: 125, loss_m3: 3, extra_tank_m3: 10, backup_w: 2000 };
const nFields = [
  ['loss_m3', 'Incident volume (m³)', 0, 100000],
  ['heat_percent', 'Daily heat demand (% of base)', 100, 300],
  ['extra_tank_m3', 'Extra tank capacity (m³)', 0, 100000],
  ['backup_w', 'Islandable pump backup (W)', 0, 1000000],
] as const;

function reserveText(amount: number | null, status: ReserveStatus) {
  if (status === 'minimum' && amount != null) return `${value(amount)} m³`;
  return status === 'unreachable' ? 'Unreachable' : status === 'no_target' ? 'No parcel minimum' : 'Unverified';
}
function failureText(error: unknown) {
  if (error instanceof ApiError && Object.keys(error.fields).length) return Object.values(error.fields).join(' ');
  return error instanceof Error ? error.message : 'The outage service could not complete this calculation.';
}

function selectedNumbers(input: string, min: number, max: number) {
  if (!input.trim()) return undefined;
  const parts = input.split(',').map(x => x.trim());
  const numbers = parts.map(Number);
  if (numbers.length > 4 || numbers.some((n,i) => !/^\d+$/.test(parts[i]) || n < min || n > max) ||
      new Set(numbers).size !== numbers.length) return null;
  return numbers.sort((a,b) => a-b);
}
function reserveDescription(details: OutageCase) {
  if (details.reserve_status === 'minimum') return `${value(details.reserve_m3)} m³ of the stock available at ${clockHour(details.start)} must be available for use to meet the ${details.target_percent}% target by each deadline. Surplus water may stay in the tank. The withdrawal quota stays fixed.`;
  if (details.reserve_status === 'unreachable') return `The solver proved that the ${details.target_percent}% target is unreachable with the available stock, quota and delivery windows.`;
  if (details.reserve_status === 'no_target') return 'This case has no positive minimum against which to measure coverage.';
  return 'The solver could not verify a minimum reserve within its time limit.';
}

function CoverageGrid({ data, selected, choose }: { data: OutageGrid; selected?: OutageCell; choose: (cell: OutageCell) => void }) {
  const labels = { reachable: 'Reachable', unreachable: 'Unreachable', unknown: 'Unresolved', no_target: 'No parcel minimum' };
  return <div className="outage-matrix-wrap"><table className="outage-matrix">
    <caption>Fair plan coverage and deficit, with a separate feasibility verdict for the {data.target_percent}% target</caption>
    <thead><tr><th scope="col">Start</th>{data.durations.map(d => <th scope="col" key={d}>{d} h</th>)}</tr></thead>
    <tbody>{data.starts.map(start => <tr key={start}><th scope="row">{clockHour(start)}</th>{data.durations.map(duration => {
      const cell = data.cells.find(c => c.start === start && c.duration === duration);
      if (!cell) return <td key={duration} aria-label="Outside the simulation window">—</td>;
      const evidence = coverageEvidence(cell, data.target_percent);
      return <td key={duration}><button type="button" className={`outage-cell outage-${evidence}`}
        aria-label={`${clockHour(start)}, ${duration} h, ${percent(cell.coverage_bp)} plan coverage, target: ${labels[evidence]}`}
        aria-pressed={selected?.start === start && selected.duration === duration} onClick={() => choose(cell)}>
        <strong>{percent(cell.coverage_bp)}</strong><small>{value(cell.deficit_m3)} m³ short</small><small>{labels[evidence]}</small></button></td>;
    })}</tr>)}</tbody>
  </table>
    <h4>Longest tested cut meeting {data.target_percent}%</h4>
    <ul className="outage-duration-summary">{data.starts.map(start => {
      const row = data.cells.filter(c => c.start === start);
      const { comparable, passing, longest, unresolved, ambiguous } = durationEvidence(row, data.target_percent);
      return <li key={start}><span>{clockHour(start)}</span><strong>{!comparable ? 'No parcel minimum' :
        ambiguous ? 'Undetermined' : longest == null ? 'None' : `${longest} h`}</strong>
        {comparable && <small>{passing.length ? `Reachable at ${passing.join(', ')} h` : 'No verified passing case'}
          {unresolved.length > 0 && ` · unresolved at ${unresolved.join(', ')} h`}</small>}</li>;
    })}</ul></div>;
}

type Study = 'sharing' | 'incidents' | 'heat' | 'upgrades' | 'community';
const studies: [Study, string][] = [['sharing','Water sharing'], ['incidents','Leak or sensor?'], ['heat','Three-day heat'],
  ['upgrades','Tank or backup?'], ['community','Community electricity']];

function CaseReview({ site, capacity, profile, details, settings, study, setStudy, backToGrid }: {
  site: Site; capacity: number; profile?: FieldZone; details: OutageCase; settings: CaseSettings; study: Study; setStudy: (tab: Study) => void;
  backToGrid: () => void;
}) {
  const [rule, setRule] = useState<ShareRule>('fair');
  const [fault, setFault] = useState<Fault>('physical_loss');
  const [upgrade, setUpgrade] = useState<'current' | 'larger_tank' | 'backup'>('current');
  const [prefill, setPrefill] = useState(true);
  const [paced, setPaced] = useState(false);
  const [heatDay, setHeatDay] = useState(1);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, [details]);
  const event = study === 'incidents' ? details.incidents.find(i => i.kind === fault) : undefined;
  const hardware = study === 'upgrades' ? details.upgrades.find(i => i.id === upgrade) : undefined;
  const plan: Plan | null | undefined = study === 'incidents' ? event?.plan : study === 'upgrades' ? hardware?.plan :
    study === 'heat' ? (paced ? details.heat_reserved_days : details.heat_days).find(d => d.day === heatDay)?.plan :
    study === 'sharing' && !prefill && rule === 'fair' ? details.without_prefill : details.rules[rule];
  const replayTitle = study === 'incidents' ? fault === 'physical_loss' ? 'Physical water loss' : 'Faulty stock reading' :
    study === 'heat' ? `Heat day ${heatDay} · ${paced ? 'Paced withdrawals' : 'Use quota as needed'}` :
    study === 'upgrades' ? alternativeNames[upgrade] : rule === 'fair' && !prefill ? 'Fair plan with fixed-turn pumping limits' : ruleNames[rule];
  const replayCapacity = capacity + (hardware?.id === 'larger_tank' ? settings.extra_tank_m3 : 0);
  const currentDeficit = unmetMinimum(details.rules.fair);
  const firstShort = plan?.plot_results?.filter(p => p.minimum_m3 != null && p.delivered_on_time_m3 < p.minimum_m3)
    .map(plot => ({ plot, definition: details.plots.find(p => p.plot_id === plot.plot_id) }))
    .filter(p => p.definition != null).sort((a, b) => a.definition!.deadline_slot - b.definition!.deadline_slot)[0];
  return <section className="surface outage-review" aria-label="Selected outage case">
    <header><div><span className="outage-eyebrow">Selected interruption</span>
      <h2 ref={title} tabIndex={-1}>{clockHour(details.start)} – {clockHour(details.start + details.duration)}</h2></div><div>
        <span className="outage-eyebrow">Minimum starting reserve</span>
        <strong>{reserveText(details.reserve_m3, details.reserve_status)}</strong></div></header>
    <p>{reserveDescription(details)}</p><button type="button" className="text-button" onClick={backToGrid}><ArrowLeft size={14}/> Back to outage grid</button>
    <div className="outage-studies" role="group" aria-label="Explore this interruption">{studies.map(([id,name]) =>
      <button key={id} type="button" aria-pressed={study === id} onClick={() => setStudy(id)}>{name}</button>)}</div>
    {study === 'sharing' && <section aria-label="Sharing rule comparison">
      <h3>Who receives water on time?</h3><p>Every rule starts with the same stock and quota. Urgency gives first priority to {details.urgent_plot_id}.</p>
      <table className="outage-table" aria-label="Daily results by sharing rule"><thead><tr><th scope="col">Daily result</th>
        {sharingRules.map(id => <th scope="col" key={id}><button className="text-button" type="button"
          aria-pressed={rule === id && (id !== 'fair' || prefill)} onClick={() => { setRule(id); setPrefill(true); }}>{ruleNames[id]}</button></th>)}
        </tr></thead><tbody>{sharingMeasures.map(measure => <tr key={measure.label}><th scope="row">{measure.label}</th>
          {sharingRules.map(id => <td key={id}>{measure.format(details.rules[id])}</td>)}
        </tr>)}</tbody></table>
      {rule === 'fair' && <label className="outage-check"><input type="checkbox" checked={prefill} onChange={e => setPrefill(e.target.checked)} />
        Allow pre-outage pumping above the fixed-turn schedule</label>}
      {rule === 'fair' && <p>At the same quota the fair plan reaches {percent(details.rules.fair.metrics?.worst_coverage_bp)} coverage with prefill available
        and {percent(details.without_prefill.metrics?.worst_coverage_bp)} when earlier pumping is capped at the fixed-turn schedule.</p>}
    </section>}
    {study === 'incidents' && <section aria-label="Water incident diagnosis"><h3>Where did the water go?</h3>
      <p>At {clockHour(details.start)} the experiment introduces a {value(settings.loss_m3)} m³ disturbance.
        Read the simulated tank state beside the instrument before choosing an inspection.</p>
      <div className="outage-choices">{([['physical_loss','Physical water loss'], ['meter_error','Stock meter fault']] as const).map(([id,title]) =>
        <button type="button" key={id} aria-pressed={fault === id} onClick={() => setFault(id)}>{title}</button>)}</div>
      <p className="outage-advice"><TriangleAlert size={19}/><span>{fault === 'physical_loss'
        ? 'Check the tank level independently, then compare inlet and outlet volumes over the same interval and inspect the distribution network.'
        : 'Cross-check the indicated level against a manual gauge or a second calibrated meter. Verify its timestamp and calibration before dispatching a leak crew.'}</span></p>
    </section>}
    {study === 'heat' && <section aria-label="Three-day heat test"><h3>How much water remains tomorrow?</h3>
      <p>Each day uses {settings.heat_percent}% of the entered demand. Weather and outages repeat. The end stock and remaining quota carry into the next day.</p>
      {details.heat_days.length ? <><div className="outage-choices">{(['Use quota as needed', 'Pace withdrawals over three days'] as const).map((name,i) =>
        <button type="button" key={name} aria-pressed={paced === Boolean(i)} onClick={() => setPaced(Boolean(i))}>{name}</button>)}</div>
        <p>{paced ? 'Each day can withdraw its share of the quota remaining across the days left. Unused water carries forward.' :
          'Each day may use all the remaining quota. Later days inherit any shortfall.'}</p>
        <table className="outage-table"><thead><tr><th>Day</th><th>Tank<br/>start → end (m³)</th>
        <th>Quota<br/>start → end (m³)</th><th>Unmet minimum</th></tr></thead><tbody>{(paced ? details.heat_reserved_days : details.heat_days).map(item =>
          <tr key={item.day}><th><button className="text-button" type="button" aria-pressed={item.day === heatDay}
            onClick={() => setHeatDay(item.day)}>Day {item.day}</button></th><td>{value(item.initial_stock_m3)} → {value(item.end_stock_m3)}</td>
            <td>{value(item.initial_quota_m3)} → {value(item.end_quota_m3)}</td><td>{value(item.deficit_m3)} m³</td></tr>)}</tbody></table></>
        : <p role="status">This test needs a complete 24-hour scenario starting at midnight.</p>}
      <small>This is a demand sensitivity experiment. Soil moisture, crop stage and an observed three-day heat episode would be needed for a field recommendation.</small>
    </section>}
    {study === 'upgrades' && <section aria-label="Infrastructure comparison"><h3>Store more water or keep the pump powered?</h3>
      <p>The larger tank adds {settings.extra_tank_m3} m³ of capacity with the same initial water. An islandable generator can power the pump
        at up to {settings.backup_w} W for every outage hour, assuming sufficient fuel throughout. Grid-tied PV shuts down.
        The household experiment uses a separate battery with a finite energy budget.</p>
      <table className="outage-table"><thead><tr><th>Installation</th><th>Deficit avoided</th><th>Grid</th><th>Backup</th></tr></thead>
        <tbody>{details.upgrades.map(item => {
          const deficit = unmetMinimum(item.plan);
          return <tr key={item.id}><th><button type="button" className="text-button" aria-pressed={upgrade === item.id}
            onClick={() => setUpgrade(item.id)}>{alternativeNames[item.id]}</button></th>
            <td>{value(currentDeficit == null || deficit == null ? null : currentDeficit - deficit)} m³</td>
            <td>{kilo(item.plan.metrics?.grid_wh)} kWh</td><td>{kilo(item.backup_wh)} kWh</td></tr>;
        })}</tbody></table>
    </section>}
    {study !== 'community' && plan && <>
      <OutageReplay site={site} profile={profile} details={details} plan={plan} capacity={replayCapacity} nominalCapacity={capacity}
        hasBackup={hardware?.id === 'backup'} readings={event?.readings} title={replayTitle}/>
      <h3>Parcel commitments</h3>
      {firstShort && <p><strong>{firstShort.plot.plot_id}</strong> reaches its deadline at the end of {clockHour(firstShort.definition!.deadline_slot)} with
        {' '}{value(firstShort.plot.minimum_m3! - firstShort.plot.delivered_on_time_m3)} m³ still missing. This is the earliest missed deadline in this replay.</p>}
      {plan.plot_results && <><p>Total demand left unserved across the replay is <strong>{value(plan.plot_results.some(p => p.demand_m3 == null) ? null :
        plan.plot_results.reduce((sum,p) => sum + Math.max(0, p.demand_m3! - p.delivered_m3), 0))} m³</strong>.</p>
        <table className="outage-table"><thead><tr><th>Parcel</th><th>Deadline hour</th><th>Minimum</th><th>On time</th><th>Deficit</th></tr></thead>
        <tbody>{plan.plot_results.map(p => {
          const plot = details.plots.find(a => a.plot_id === p.plot_id);
          return <tr key={p.plot_id}><th>{p.plot_id}</th><td>{plot ? clockHour(plot.deadline_slot) : '—'}</td><td>{value(p.minimum_m3)} m³</td>
            <td>{value(p.delivered_on_time_m3)} m³</td><td>{value(p.minimum_m3 == null ? null : Math.max(0, p.minimum_m3 - p.delivered_on_time_m3))} m³</td></tr>;
        })}</tbody></table></>}
    </>}
  </section>;
}

interface LabProps {
  site: Site;
  plan?: StressPlan;
  label: string;
  capacity: number;
  plots: string[];
  profile?: FieldZone;
  back: () => void;
}

export default function OutageLab({ site, plan, label, capacity, plots, profile, back }: LabProps) {
  const [target, setTarget] = useState('80');
  const [starts, setStarts] = useState('');
  const [durations, setDurations] = useState('');
  const [grid, setGrid] = useState<OutageGrid>();
  const [picked, setPicked] = useState<OutageCell>();
  const [detail, setDetail] = useState<OutageCase>();
  const [settings, setSettings] = useState(defaultSettings);
  const [study, selectStudy] = useState<Study>('sharing');
  const [openedCommunity, setOpenedCommunity] = useState(false);
  const [busy, setBusy] = useState<'grid' | 'case'>();
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const id = site.properties.site_id;
  const heading = useRef<HTMLHeadingElement>(null);
  const matrix = useRef<HTMLElement>(null);
  useEffect(() => {
    heading.current?.focus();
    return () => pending.current?.abort();
  }, []);
  const allowed = plan && !('incident' in plan && plan.incident);
  const validTarget = /^\d+$/.test(target) && Number(target) >= 1 && Number(target) <= 100;
  const selectedStarts = selectedNumbers(starts, 0, 23);
  const selectedDurations = selectedNumbers(durations, 1, 24);
  const validTimes = selectedStarts !== null && selectedDurations !== null;

  function cancel() {
    pending.current?.abort();
    setBusy(undefined);
    setError('');
  }
  async function calculate(cell?: OutageCell) {
    if (!plan || !allowed || !validTarget || !validTimes) return;
    cancel();
    if (cell && nFields.some(([key,,min,max]) => !Number.isSafeInteger(settings[key]) || settings[key] < min || settings[key] > max)) {
      setError('Check the incident, heat, capacity and backup values in Case assumptions.');
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setDetail(undefined);
    setPicked(cell);
    setBusy(cell ? 'case' : 'grid');
    if (!cell) setGrid(undefined);
    try {
      if (cell) {
        const result = await getOutageCase(id, plan, Number(target), cell.start, cell.duration, settings, controller.signal);
        if (!controller.signal.aborted) setDetail(result);
      } else {
        const result = await getOutageGrid(id, plan, Number(target), controller.signal, selectedStarts, selectedDurations);
        if (!controller.signal.aborted) setGrid(result);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(failureText(cause));
    } finally { if (!controller.signal.aborted) setBusy(undefined); }
  }
  function revise(patch: Partial<CaseSettings>) {
    cancel();
    setDetail(undefined);
    setSettings(current => ({ ...current, ...patch }));
  }
  function clearGrid() { cancel(); setGrid(undefined); setDetail(undefined); setPicked(undefined); }
  return <div className="outage-lab">
    <button type="button" className="text-button" onClick={back}><ArrowLeft size={15}/> Back to planning inputs</button>
    <section className="surface outage-intro" aria-label="Outage resilience experiment">
      <div className="outage-symbol"><Grid2X2 size={22}/></div><div>
        <span className="outage-eyebrow">{site.properties.label} · {label}</span>
        <h2 tabIndex={-1} ref={heading}>Outage resilience</h2>
        <p>Choose the minimum service you want to protect. Compare power cuts, then open a case to replay parcel deliveries and test the same interruption against a community load.</p>
      </div>
    </section>
    {!allowed ? <section className="surface outage-section" role="status"><h3>{plan ? 'Remove the existing incident to test a new interruption' : 'Set the station and parcel assumptions first'}</h3>
      <p>{plan ? 'The grid compares disruptions from a common starting state.' : 'The stress test uses the water, equipment and demand values entered for this site.'}</p>
      <button type="button" className="button button-secondary" onClick={back}>Edit planning inputs</button></section> : <>
      <section className="surface outage-section" aria-label="Outage coverage grid" ref={matrix}>
        <div className="outage-grid-header"><div><h3>Reservoir autonomy</h3>
          <p>Each cell adds one interruption to the existing outages. Coverage is the smallest share of a parcel’s minimum delivered by its deadline.</p>
          {'planning_mode' in plan && plan.planning_mode === 'weather_buffer' && <p>This experiment uses the central weather profile.</p>}</div>
          <form onSubmit={e => { e.preventDefault(); void calculate(); }}><label className="field"><span>Coverage target (%)</span>
            <input required type="number" min="1" max="100" step="1" value={target} onChange={e => {
              clearGrid(); setTarget(e.target.value);
            }}/></label>
            <button type="submit" className="button button-primary" disabled={!validTarget || !validTimes || busy === 'grid'}><Grid2X2 size={15}/>
              {busy === 'grid' ? 'Testing outages…' : 'Run outage grid'}</button></form></div>
        <details className="outage-times"><summary>Choose test hours and durations</summary>
          <p>Leave these empty for the site defaults. Enter up to four distinct whole numbers separated by commas within the remaining scenario horizon.</p>
          <div><label className="field"><span>Start hours (0–23)</span><input type="text" value={starts}
            placeholder="e.g. 6, 9, 11, 16" aria-invalid={selectedStarts === null} onChange={e => { clearGrid(); setStarts(e.target.value); }}/></label>
          <label className="field"><span>Durations (hours, 1–24)</span><input type="text" value={durations} placeholder="e.g. 1, 2, 4, 8"
            aria-invalid={selectedDurations === null} onChange={e => { clearGrid(); setDurations(e.target.value); }}/></label></div>
          {!validTimes && <p role="alert">Check the hour ranges, duplicates and four-value limit.</p>}</details>
        {grid && <>
          <CoverageGrid data={grid} selected={picked} choose={cell => void calculate(cell)}/>
          <p className="outage-grid-note"><ShieldCheck size={16}/><span>{grid.cells.length} stress cases. Select a cell to inspect its reachable reserve,
            hourly schedule and alternatives. Short scenarios include only interruptions that fit the remaining horizon.</span></p>
        </>}
      </section>
      {picked && <section className="surface outage-settings">
        <details><summary>Case assumptions <ChevronDown size={16}/></summary>
          <form onSubmit={e => { e.preventDefault(); void calculate(picked); }}>
            <label className="field"><span>Urgent parcel</span><select value={settings.urgent_plot_id ?? ''} onChange={e => revise({ urgent_plot_id: e.target.value || undefined })}>
              <option value="">Earliest deadline</option>{plots.map(plot => <option key={plot}>{plot}</option>)}</select></label>
            {nFields.map(([key,title,min,max]) => <label className="field" key={key}><span>{title}</span><input type="number" min={min}
              max={max} step="1" required value={Number.isNaN(settings[key]) ? '' : settings[key]} onChange={e => revise({ [key]: e.target.valueAsNumber })}/></label>)}
            <button type="submit" className="button button-secondary" disabled={busy === 'case'}>Recalculate selected case</button>
          </form></details>
        {busy === 'case' && <p role="status">Solving the {clockHour(picked.start)} interruption and checking alternatives…</p>}
        {!detail && !busy && !error && <p role="status">Case assumptions changed. Recalculate to update the replay.</p>}
      </section>}
      {error && <p role="alert" className="outage-error">{error} <button type="button" className="text-button" onClick={() => void calculate(picked)}>Retry calculation</button></p>}
      {detail && <CaseReview site={site} profile={profile} capacity={capacity} details={detail} settings={settings} study={study}
        backToGrid={() => matrix.current?.querySelector<HTMLButtonElement>('button.outage-cell[aria-pressed="true"]')?.focus()}
        setStudy={tab => { selectStudy(tab); if (tab === 'community') setOpenedCommunity(true); }}/>}
      {openedCommunity && picked && <div hidden={!detail || study !== 'community'}>
        <CivicContinuity startHour={picked.start} durationHours={picked.duration}/></div>}
    </>}
    <small className="outage-foot"><BatteryCharging size={15}/> Simulated interruptions and equipment · Tunis time.
      The assistant covers the site and its standard planner. Results for this outage experiment are explained here.</small>
  </div>;
}
