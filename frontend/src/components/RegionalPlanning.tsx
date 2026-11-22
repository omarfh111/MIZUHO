import { Activity, ArrowUpRight, Droplets, MapPin, Pause, Play, Sun } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, getFieldZone, getRegionalPlanning, runRegionalPlanning } from '../api.ts';
import { useExperience } from '../experience/index.ts';
import { clockHour, dateLabel, kilo, percent, value } from '../format.ts';
import type { FieldZone, Plan, RegionalDemandBasis, RegionalPlanningContext, RegionPlanContext, RegionPlanRequest, RegionalPlanningResult,
  RegionSector, Site } from '../types.ts';
import RegionalDemandEstimator from './RegionalDemandEstimator.tsx';
import OutageLab, { OutageEntry } from './OutageLab.tsx';
import CommitmentRegister from './CommitmentRegister.tsx';
import OperatorRotation from './OperatorRotation.tsx';
import StoredWaterOnly from './StoredWaterOnly.tsx';
import VoiceGuardian, { type GuardianConfirmation } from './VoiceGuardian.tsx';
import './field-zone.css';

const RegionalSiteScene = lazy(() => import('./RegionalSiteScene.tsx'));
type InputKey = Exclude<keyof RegionPlanRequest, 'date' | 'outage_hours' | 'demand_basis'>;
type Draft = Partial<Record<InputKey, string>>;
type Input = { key: InputKey; title: string; unit: string; min?: number; max?: number; step?: string };
const groups: { title: string; fields: Input[] }[] = [
  { title: 'Water and demand', fields: [
    { key: 'tank_capacity_m3', title: 'Tank capacity', unit: 'm³' },
    { key: 'initial_stock_m3', title: 'Initial tank stock', unit: 'm³' },
    { key: 'withdrawal_limit_m3', title: 'Withdrawal limit', unit: 'm³' },
    { key: 'demand_west_m3', title: 'West sector demand', unit: 'm³' },
    { key: 'demand_east_m3', title: 'East sector demand', unit: 'm³' },
    { key: 'gravity_flow_m3_h', title: 'Gravity delivery capacity', unit: 'm³/h' },
  ] },
  { title: 'Pump and electricity', fields: [
    { key: 'pump_flow_m3_h', title: 'Pump capacity', unit: 'm³/h' },
    { key: 'pump_wh_per_m3', title: 'Pump energy intensity', unit: 'Wh/m³', min: 1 },
    { key: 'grid_cap_w', title: 'Grid power ceiling', unit: 'W', max: 1e9 },
    { key: 'pv_capacity_kwp', title: 'PV array capacity', unit: 'kWp', max: 10000, step: 'any' },
    { key: 'pv_performance_ratio', title: 'PV performance ratio', unit: '0–1', min: 0, max: 1, step: 'any' },
  ] },
];
const example: Record<InputKey, string> = {
  tank_capacity_m3: '40', initial_stock_m3: '8', withdrawal_limit_m3: '36',
  demand_west_m3: '24', demand_east_m3: '24', gravity_flow_m3_h: '8',
  pump_flow_m3_h: '8', pump_wh_per_m3: '450', grid_cap_w: '3600',
  pv_capacity_kwp: '4', pv_performance_ratio: '0.8', delivery_start_hour: '9', delivery_end_hour: '15',
};
const hours = Array.from({ length: 24 }, (_, hour) => hour);
const planNames = { baseline: 'Fixed turn', optimized: 'Optimized plan' };

function PlanSummary({ result, confirmedAt }: { result: RegionalPlanningResult; confirmedAt?: Date }) {
  const [approvedAt, approve] = useState<Date | undefined>(confirmedAt);
  const proposed = result.comparison.optimized;
  const reviewable = ['OPTIMAL', 'FEASIBLE'].includes(proposed.status) && proposed.metrics && proposed.actions?.length;
  const rows: [string, (plan: Plan) => string][] = [
    ['Delivered on time (m³)', plan => value(plan.metrics?.delivered_on_time_m3)],
    ['Minimum sector coverage', plan => percent(plan.metrics?.worst_coverage_bp)],
    ['Unserved demand (m³)', plan => value(plan.plot_results?.reduce((total, plot) =>
      total + Math.max(0, (plot.demand_m3 ?? 0) - plot.delivered_m3), 0))],
    ['Water withdrawn (m³)', plan => value(plan.metrics?.withdrawn_m3)],
    ['Grid energy (kWh)', plan => kilo(plan.metrics?.grid_wh)],
    ['Peak grid demand (kW)', plan => kilo(plan.metrics?.peak_grid_w)],
  ];
  return <section className="surface field-detail-card region-summary" aria-label="Regional plan comparison">
    <h2><Activity size={20} /> Plan comparison</h2>
    <table><thead><tr><th scope="col">Simulated outcome</th><th scope="col">Fixed turn</th><th scope="col">Optimized</th></tr></thead>
      <tbody>{rows.map(([label, read]) => <tr key={label}><th scope="row">{label}</th>
        <td>{read(result.comparison.baseline)}</td><td>{read(result.comparison.optimized)}</td></tr>)}</tbody></table>
    <p>Solver status · {result.comparison.optimized.status.replaceAll('_', ' ').toLowerCase()}.</p>
    {result.comparison.optimized.plot_results?.map(sector => <p key={sector.plot_id} className="region-sector-note">
      <strong>{sector.plot_id === 'west' ? 'West' : 'East'} sector</strong>
      {' '}{value(sector.delivered_on_time_m3)} of {value(sector.demand_m3)} m³ delivered on time. {sector.reason}
    </p>)}
    {result.comparison.optimized.warnings.map((warning, index) =>
      <p key={index}>{typeof warning === 'string' ? warning : warning.message}</p>)}
    {reviewable ? <div className="region-review">
      <p>Record your review of the optimized simulation for the current inputs in this session.</p>
      {approvedAt ? <p role="status"><strong>Simulated plan approved</strong>{' · '}
        <time dateTime={approvedAt.toISOString()}>{new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Africa/Tunis', dateStyle: 'medium', timeStyle: 'medium',
        }).format(approvedAt)} Tunis time</time></p> :
        <button className="button button-secondary" type="button" onClick={() => approve(new Date())}>Approve simulated plan</button>}
    </div> : null}
  </section>;
}

interface Props {
  site: Site;
  onPlanChange: (context: RegionPlanContext | undefined) => void;
  visible?: boolean;
}

export default function RegionalPlanning({ site, onPlanChange, visible = true }: Props) {
  const id = site.properties.site_id;
  const cinematic = useExperience().active;
  const [resources, setResources] = useState<{ profile: FieldZone; context: RegionalPlanningContext }>();
  const [resourceError, setResourceError] = useState(false);
  const [needsQuota, setNeedsQuota] = useState(false);
  const [attempt, retry] = useState(0);
  const [opened, setOpened] = useState(visible);
  const [stress, setStress] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [demandBasis, setDemandBasis] = useState<Partial<Record<RegionSector, RegionalDemandBasis>>>({});
  const [estimatorVersion, resetEstimator] = useState(0);
  const [selectedDate, setDate] = useState('');
  const [outages, setOutages] = useState<number[]>([]);
  const [exampleLoaded, setExampleLoaded] = useState(false);
  const [calculated, setCalculated] = useState<{ inputs: RegionPlanRequest; result: RegionalPlanningResult; confirmedAt?: Date }>();
  const result = calculated?.result;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const [planId, selectPlan] = useState<'optimized' | 'baseline'>('optimized');
  const [index, seek] = useState(0);
  const [playing, play] = useState(false);
  const [speed, setSpeed] = useState(1);
  const replayRegion = useRef<HTMLElement>(null);
  const assumptionSection = useRef<HTMLElement>(null);
  const day = resources?.context.days.find(d => d.date === selectedDate);
  const plan = result?.comparison[planId];
  const frame = plan?.actions?.[index];

  useEffect(() => { if (visible) setOpened(true); }, [visible]);

  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    setResourceError(false);
    Promise.all([getFieldZone(id, controller.signal), getRegionalPlanning(id, controller.signal)])
      .then(([profile, context]) => {
        if (controller.signal.aborted) return;
        setResources({ profile, context });
        setDate(context.days.at(-1)?.date ?? '');
      }).catch(() => { if (!controller.signal.aborted) setResourceError(true); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [id, attempt, opened]);

  useEffect(() => {
    if (!playing) return;
    if (stress || !visible || cinematic || !plan?.actions || index >= plan.actions.length - 1) { play(false); return; }
    const timer = window.setTimeout(() => seek(index + 1), 1200 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, plan, visible, cinematic, speed, stress]);

  useEffect(() => {
    if (result && visible && assumptionSection.current?.contains(document.activeElement)) replayRegion.current?.focus();
  }, [result, visible]);

  function invalidate() {
    setNeedsQuota(false);
    request.current?.abort();
    setBusy(false);
    setCalculated(undefined);
    setError('');
    play(false);
    onPlanChange(undefined);
  }

  function edit(key: InputKey, raw: string) {
    invalidate();
    if (key === 'demand_west_m3' || key === 'demand_east_m3') {
      const sector = key === 'demand_west_m3' ? 'west' : 'east';
      setDemandBasis(current => { const next = { ...current }; delete next[sector]; return next; });
    }
    setDraft(current => ({ ...current, [key]: raw }));
  }

  function changeDay(next: string) {
    invalidate();
    setDraft(current => ({ ...current, ...(demandBasis.west && { demand_west_m3: '' }),
      ...(demandBasis.east && { demand_east_m3: '' }) }));
    setDemandBasis({});
    setDate(next);
  }

  async function solve(event: FormEvent) {
    event.preventDefault();
    if (!resources || !day) return;
    invalidate();
    const fields = Object.keys(example) as InputKey[];
    if (fields.some(key => !draft[key]?.trim() || !Number.isFinite(Number(draft[key])))) {
      setError('Complete all station assumptions before calculating.'); return;
    }
    const inputs = Object.fromEntries(fields.map(key => [key, Number(draft[key])])) as Record<InputKey, number>;
    if (inputs.initial_stock_m3 > inputs.tank_capacity_m3) { setError('Initial stock exceeds tank capacity.'); return; }
    if (inputs.delivery_start_hour > inputs.delivery_end_hour) { setError('The delivery window must end after or at its first hour.'); return; }
    if (inputs.pv_performance_ratio <= 0) { setError('The PV performance ratio must be greater than zero.'); return; }
    const body: RegionPlanRequest = { ...inputs, date: day.date, outage_hours: outages,
      ...(Object.keys(demandBasis).length > 0 && { demand_basis: demandBasis }) };
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const response = await runRegionalPlanning(id, body, controller.signal);
      if (controller.signal.aborted) return;
      setCalculated({ inputs: body, result: response });
      seek(inputs.delivery_start_hour);
      selectPlan('optimized');
      onPlanChange({ inputs: body, comparison_id: response.comparison_id });
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof ApiError && Object.keys(failure.fields).length
        ? Object.values(failure.fields).join(' ') : 'The planning service could not complete the comparison. Try calculating again.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function confirmGuardian(confirmed: GuardianConfirmation) {
    if (!calculated || !('zone_inputs' in confirmed) || confirmed.zone_result.site_id !== id ||
      confirmed.zone_inputs.withdrawal_limit_m3 >= calculated.inputs.withdrawal_limit_m3) return;
    const { zone_inputs: inputs, zone_result: next } = confirmed;
    setDraft(previous => ({ ...previous, withdrawal_limit_m3: String(inputs.withdrawal_limit_m3) }));
    setCalculated({ inputs, result: next, confirmedAt: new Date() });
    onPlanChange({ inputs, comparison_id: next.comparison_id });
    play(false);
    selectPlan('optimized');
    seek(inputs.delivery_start_hour);
  }
  const guardian = visible && !cinematic && <VoiceGuardian key={stress ? 'stress' : result?.comparison_id ?? 'setup'}
    context={{ site_id: id, zone_plan: !stress && calculated ? { inputs: calculated.inputs, comparison_id: calculated.result.comparison_id } : undefined }}
    incoming={!stress && needsQuota && !draft.withdrawal_limit_m3 ? { id: id + '/missing-quota', reason: 'clarification' } : undefined}
    onConfirm={confirmGuardian} />;
  if (!resources) return <>{guardian}<section className="surface page-fallback" role={resourceError ? 'alert' : 'status'}>
    {resourceError ? <>Regional planning inputs could not be loaded. <button type="button" className="button button-secondary"
      onClick={() => retry(n => n + 1)}>Retry planning inputs</button></> : 'Loading the regional terrain and solar archive…'}</section></>;

  const { profile, context } = resources;
  if (stress) {
    const keys = Object.keys(example) as InputKey[];
    const complete = day && keys.every(key => draft[key]?.trim() && Number.isFinite(Number(draft[key])));
    const inputs = complete ? {
      ...Object.fromEntries(keys.map(key => [key, Number(draft[key])])) as Record<InputKey, number>,
      date: day.date, outage_hours: outages, ...(Object.keys(demandBasis).length > 0 && { demand_basis: demandBasis }),
    } : undefined;
    return visible && !cinematic && <>{guardian}<OutageLab site={site} plan={inputs} profile={profile} label="Regional experiment"
      capacity={Number(draft.tank_capacity_m3)} plots={context.anchors.map(a => a.plot_id)} back={() => {
        setStress(false);
        if (result && inputs) onPlanChange({ inputs, comparison_id: result.comparison_id });
      }}/></>;
  }
  const [west, south, east, north] = profile.relief.bounds;
  const markers = context.anchors.map(anchor => {
    const delivery = frame?.deliveries.find(d => d.plot_id === anchor.plot_id)?.delivered_m3 ?? 0;
    const capacity = Number(draft.gravity_flow_m3_h);
    const prefix = anchor.plot_id === 'west' ? 'West' : 'East';
    return { id: anchor.plot_id, u: (anchor.longitude - west) / (east - west), v: (anchor.latitude - south) / (north - south),
      deliveryFraction: frame ? (capacity > 0 ? delivery / capacity : 0) : undefined,
      label: frame ? `${prefix} · ${value(delivery)} m³` : `${prefix} sector` };
  });
  const actionCount = plan?.actions?.length ?? 0;
  return <div className="region-planning" aria-label="Regional planning experiment">
    {guardian}
    <section className="surface field-detail-card region-location" aria-label="Regional simulation terrain" ref={replayRegion} tabIndex={-1}>
      <div className="region-title"><div><h2><MapPin size={20} /> {site.properties.label}</h2>
        <p>Two hypothetical irrigation sectors, each anchored to a cell classified as cropland by ESA WorldCover in 2021.</p></div>
        {result ? <div className="field-surface-switch" role="group" aria-label="Regional playback plan">
          {(['baseline', 'optimized'] as const).map(id => <button type="button" key={id} aria-pressed={id === planId}
            onClick={() => { selectPlan(id); play(false); }}>{planNames[id]}</button>)}</div> :
          <button type="button" className="button button-secondary" onClick={() =>
            assumptionSection.current?.querySelector<HTMLButtonElement>('button')?.focus()}>Set up experiment</button>}</div>
      {visible && !cinematic && <Suspense fallback={<div className="field-map-status">Loading terrain…</div>}>
        <RegionalSiteScene profile={profile} markers={markers} frame={frame?.tank_stock_m3 === undefined ? undefined : {
          tank_stock_m3: frame.tank_stock_m3, tank_capacity_m3: Number(draft.tank_capacity_m3), pump_m3: frame.pump_m3,
          grid_available: !outages.includes(frame.slot), deliveries: frame.deliveries,
          pv_capacity_kwp: Number(draft.pv_capacity_kwp), solar_potential_wh: result?.solar_wh[frame.slot],
        }} />
      </Suspense>}
      {result && !frame && <p role="status">The {planNames[planId].toLowerCase()} has no actions to replay.</p>}
      {frame && result && <section className="region-replay" aria-label="Regional hourly replay">
        <div className="region-transport">
          <button type="button" className="button button-secondary" aria-label={playing ? 'Pause regional replay' : 'Play regional replay'} onClick={() => {
            if (index >= actionCount - 1) seek(0);
            play(!playing);
          }}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
          <strong>{clockHour(frame.slot)}</strong>
          <input type="range" aria-label="Regional simulation hour" min="0" max={actionCount - 1} value={index}
            onChange={event => { play(false); seek(Number(event.target.value)); }} />
          <select aria-label="Regional playback speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}>
            {[1, 2, 4].map(n => <option key={n} value={n}>{n}×</option>)}</select>
        </div>
        <dl>{[['Tank stock', value(frame.tank_stock_m3) + ' m³'], ['Water pumped', value(frame.pump_m3) + ' m³'],
          ['PV potential', kilo(result.solar_wh[frame.slot]) + ' kWh'], ['Grid', outages.includes(frame.slot) ? 'Outage' : 'Available']]
          .map(([title, reading]) => <div key={title}><dt>{title}</dt><dd>{reading}</dd></div>)}</dl>
        <small>Map labels show simulated hourly deliveries in Tunis time. The teal bars show each delivery as a share of assumed gravity capacity.</small>
      </section>}
    </section>
    {calculated && <>
      <CommitmentRegister plan={calculated.result.comparison[planId]} selected={planId} labels={planNames}
        onSelect={id => { selectPlan(id); play(false); }} fromSlot={0} sectors
        plots={context.anchors.map(({ plot_id }) => ({ plot_id, deadline_slot: calculated.inputs.delivery_end_hour,
          allowed_slots: hours.filter(h => h >= calculated.inputs.delivery_start_hour && h <= calculated.inputs.delivery_end_hour) }))} />
      <OperatorRotation siteId={id} plan={calculated.inputs} plotIds={context.anchors.map(a => a.plot_id)} horizon={24} />
      <PlanSummary key={calculated.result.comparison_id} result={calculated.result} confirmedAt={calculated.confirmedAt} />
    </>}
    <section className="surface field-detail-card region-form" ref={assumptionSection}>
      <div className="region-title"><div><h2><Droplets size={20} /> Set planning assumptions</h2>
        <p>Compare an alternating fixed turn and an optimized schedule against the same water and power limits.</p></div>
        <button type="button" className="button button-secondary" onClick={() => {
          invalidate(); setDraft({ ...example }); setExampleLoaded(true); setOutages([11, 12, 13]);
          setDemandBasis({}); resetEstimator(n => n + 1);
        }}>Load example assumptions</button></div>
      <p className="region-assumption-note">{exampleLoaded ? 'Editable example loaded. ' : ''}
        Tank, pump, quotas, demands and outages are scenario inputs. No station measurements or water rights are available for these sectors.</p>
      <fieldset className="region-weather"><legend><Sun size={16} /> Archived solar input</legend>
        <label className="field"><span>Irradiation day · Tunis time</span>
          <select value={selectedDate} onChange={e => changeDay(e.target.value)}>
            {context.days.map(d => <option key={d.date} value={d.date}>{dateLabel(d.date)}</option>)}</select></label>
        {day && <div className="region-weather-day">
          <div className="region-irradiation" aria-label="Hourly gridded irradiation">
            {day.irradiation_wh_m2.map((wh, h) => <i key={h} title={`${clockHour(h)} · ${value(wh)} Wh/m²`}
              style={{ height: `${wh / Math.max(1, ...day.irradiation_wh_m2) * 100}%` }} />)}
          </div>
          <span>{value(day.irradiation_wh_m2.reduce((sum, wh) => sum + wh, 0) / 1000)} kWh/m² ·
            {' '}<a href={day.source.url} target="_blank" rel="noreferrer">NASA POWER hourly estimate <ArrowUpRight size={12}/></a></span>
        </div>}
        <p className="muted small">Nearby sites can share a NASA POWER solar grid cell. Local rainfall, terrain and operating conditions can still differ.</p>
      </fieldset>
      {day?.weather ? <RegionalDemandEstimator key={selectedDate + estimatorVersion} siteId={id} date={day.date} weather={day.weather} applied={demandBasis}
        onApply={(sector, volume, basis) => {
          invalidate();
          setDraft(current => ({ ...current, [`demand_${sector}_m3`]: String(volume) }));
          setDemandBasis(current => ({ ...current, [sector]: basis }));
        }}
        onDiscard={sector => { if (demandBasis[sector]) edit(`demand_${sector}_m3`, ''); }} /> :
        <p className="muted small">A verified daily reference ET₀ and rainfall pair is unavailable. Enter sector demands below.</p>}
      <form onSubmit={solve} onInvalidCapture={event => {
        const field = event.target;
        if (field instanceof HTMLInputElement && field.name === 'withdrawal_limit_m3' && field.validity.valueMissing) setNeedsQuota(true);
      }}>
        <StoredWaterOnly onApply={() => {
          invalidate();
          setDraft(current => ({ ...current, withdrawal_limit_m3: '0' }));
          setOutages([]);
        }} />
        {groups.map(group => <fieldset key={group.title}><legend>{group.title}</legend><div className="region-inputs">
          {group.fields.map(({ key, title, unit, min = 0, max = 100000, step = '1' }) =>
            <div key={key}><label className="field"><span>{title} ({unit})</span><input type="number" name={key} required min={min}
              max={max} step={step} value={draft[key] ?? ''} onChange={e => edit(key, e.target.value)} /></label>
              {((key === 'demand_west_m3' && demandBasis.west) || (key === 'demand_east_m3' && demandBasis.east)) &&
                <div className="region-demand-origin"><small>Weather estimate · {dateLabel(selectedDate)}</small>
                  <button type="button" className="text-button" onClick={() => edit(key, draft[key] ?? '')}>
                    Use manual {key === 'demand_west_m3' ? 'west' : 'east'} demand</button></div>}</div>)}
        </div></fieldset>)}
        <fieldset><legend>Delivery window and grid outages</legend>
          <div className="region-window">{(['delivery_start_hour', 'delivery_end_hour'] as const).map((key, i) =>
            <label className="field" key={key}><span>{i === 0 ? 'First' : 'Last'} delivery hour (inclusive)</span>
              <select value={draft[key] ?? ''} required onChange={e => edit(key, e.target.value)}>
                <option value="">Choose hour</option>{hours.map(h => <option key={h} value={h}>{clockHour(h)}</option>)}</select></label>)}</div>
          <p className="small">Select each hour with a grid outage. The model assumes grid-tied PV and gravity-fed delivery.</p>
          <div role="group" aria-label="Regional grid outage hours" className="region-outages">
            {hours.map(h => <button type="button" key={h} aria-pressed={outages.includes(h)} onClick={() => {
              invalidate(); setOutages(current => current.includes(h) ? current.filter(v => v !== h) : [...current, h].sort((a, b) => a - b));
            }}>{clockHour(h)}</button>)}</div>
          {outages.length > 0 && <button type="button" className="text-button" onClick={() => { invalidate(); setOutages([]); }}>
            Clear outage hours</button>}
        </fieldset>
        {error && <p role="alert" className="field-error">{error}</p>}
        <button type="submit" className="button button-primary" disabled={busy || !day}>{busy ? 'Calculating…' : 'Compare regional plans'}</button>
        <p role="status" className="region-run-status">{result ? 'Comparison ready above. The terrain now shows hourly sector deliveries.' : ''}</p>
      </form>
    </section>
    <OutageEntry open={() => {
      request.current?.abort();
      setBusy(false);
      setStress(true);
      onPlanChange(undefined);
    }}/>
  </div>;
}
