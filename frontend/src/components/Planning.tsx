import { Activity, ArrowDownToLine, ArrowRight, BookOpenText, ChartNoAxesCombined, Clock3, CloudSun, Droplets, TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { clockHour, hour, kilo, percent, provenanceLabel, value } from '../format.ts';
import type { CompareRequest, Comparison, Plan, Scenario, Warning, WeatherComparison } from '../types.ts';

interface Props {
  comparison: Comparison;
  input: CompareRequest;
  scenario: Scenario;
  stale: boolean;
  onEvidence: (source: string) => void;
}

function Stat({ label, title, reference, unit, icon, tone }: {
  label: string; title: string; reference: string; unit: string; icon: React.ReactNode; tone: string;
}) {
  return <article className="surface overview-stat">
    <div className={`stat-icon tone-${tone}`}>{icon}</div>
    <div><h3>{label}</h3><strong>{title} <small>{unit}</small></strong><p>Baseline · {reference} {unit}</p></div>
  </article>;
}

function WeatherDecision({ weather, onEvidence }: { weather: WeatherComparison; onEvidence: Props['onEvidence'] }) {
  const buffer = weather.buffer_on_adverse.metrics;
  const reference = weather.reference_on_adverse.metrics;
  const noEarlyPumping = weather.remaining_deficit_m3 > 0
    ? 'No early pumping scheduled · shortfall remains'
    : 'No early pumping needed';
  return <section className="surface weather-panel" aria-labelledby="weather-title">
    <div className="weather-copy">
      <div className="eyebrow"><CloudSun size={17} /> DAY-AHEAD WEATHER RESERVE</div>
      <h2 id="weather-title">{weather.early_pump_m3 > 0
        ? `Pump ${value(weather.early_pump_m3)} m³ before ${clockHour(weather.before_slot)}`
        : noEarlyPumping}</h2>
      <p>{weather.reason ?? 'Both plans use the same adverse weather profile.'}</p>
      <div className="weather-facts"><span>Expected water stock <b>{value(weather.expected_stock_m3)} m³</b></span>
        <span>Remaining quota <b>{value(weather.quota_remaining_m3 ?? buffer?.quota_remaining_m3)} m³</b></span>
        <span>Remaining shortfall <b>{value(weather.remaining_deficit_m3)} m³</b></span>
        {weather.additional_early_pump_m3 != null && weather.additional_early_pump_m3 !== weather.early_pump_m3 &&
          <span>Additional reserve <b>{value(weather.additional_early_pump_m3)} m³</b></span>}</div>
      <div className="weather-source">
        <span>{weather.provenance ? `Profile · ${provenanceLabel[weather.provenance]}` : 'Adverse profile'}</span>
        {weather.source_id && <button type="button" className="text-button" onClick={() => onEvidence(weather.source_id!)}><BookOpenText size={14} /> Provenance</button>}
      </div>
    </div>
    <div className="weather-compare">
      <table>
        <caption>Under the adverse profile</caption>
        <thead><tr><th scope="col">Metric</th><th scope="col">Nominal</th><th scope="col">With reserve</th></tr></thead>
        <tbody>
          <tr><th scope="row">Delivered on time</th><td>{value(reference?.delivered_on_time_m3)} m³</td><td>{value(buffer?.delivered_on_time_m3)} m³</td></tr>
          <tr><th scope="row">Grid energy</th><td>{kilo(reference?.grid_wh)} kWh</td><td>{kilo(buffer?.grid_wh)} kWh</td></tr>
          <tr><th scope="row">Water withdrawn</th><td>{value(reference?.withdrawn_m3)} m³</td><td>{value(buffer?.withdrawn_m3)} m³</td></tr>
        </tbody>
      </table>
    </div>
  </section>;
}

function Timeline({ scenario, input, reference, proposed, weather }: {
  scenario: Scenario; input: CompareRequest; reference: Plan; proposed: Plan; weather: boolean;
}) {
  const outage = new Set(input.outage_slots);
  const event = input.incident;
  if (event?.kind === 'unexpected_outage') {
    for (let slot = event.start_slot; slot < event.start_slot + event.duration_slots; slot++) outage.add(slot);
  }
  const firstOutage = scenario.slots.find(({ slot }) => outage.has(slot) && slot >= input.state.current_slot)?.slot;
  const first = firstOutage ?? scenario.slots.find(({ slot }) => slot >= input.state.current_slot)?.slot ?? 0;
  const [focused, setFocused] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const selected = focused ?? first;
  const slotCap = scenario.slots.find(({ slot }) => slot === selected)?.grid_cap_w;
  const restartCap = !outage.has(selected) && outage.has(selected - 1) && slotCap !== undefined
    ? Math.min(slotCap, input.restart_grid_cap_w ?? slotCap, input.overrides?.grid_cap_w ?? slotCap) : undefined;
  const rows = [
    { title: weather ? 'Nominal plan' : event ? 'Previous schedule' : 'Fixed schedule', plan: reference, kind: 'reference' },
    { title: weather ? 'With reserve' : event ? 'Recovery plan' : 'Proposed plan', plan: proposed, kind: 'proposed' },
  ];
  const stateFor = (slot: number) => {
    const grid = outage.has(slot) ? 'Outage' : outage.has(slot - 1) ? 'Grid restored' : 'Grid available';
    return event?.kind === 'pump_shutdown' && slot >= event.start_slot && slot < event.start_slot + event.duration_slots
      ? `${grid} · pump shutdown` : grid;
  };
  useEffect(() => {
    const element = scroller.current!;
    const target = element.querySelector<HTMLButtonElement>('.focused-hour');
    if (target && target.offsetLeft > element.clientWidth - 60) element.scrollLeft = target.offsetLeft - 160;
  }, [first]);

  return <section className="surface planning-panel" aria-labelledby="planning-title">
    <div className="panel-heading">
      <div className="title-with-icon"><div className="section-icon"><Clock3 size={18} /></div><div>
        <h2 id="planning-title">Schedule comparison</h2><p className="muted small">Hourly slots · Tunis time</p></div></div>
      <div className="planning-legend">
        <span><Zap size={13} /> Pumping</span><span><Droplets size={13} /> Irrigation</span><span><TriangleAlert size={13} /> Outage</span>
      </div>
    </div>
    <div className="timeline-scroll" ref={scroller} tabIndex={0} aria-label="Scrollable hourly schedule">
      <div className="timeline" style={{ '--slots': scenario.slots.length } as CSSProperties}>
        <div className="timeline-label hour-label">Hour</div>
        {scenario.slots.map(({ slot }) => <button type="button" key={slot}
          className={`timeline-hour ${outage.has(slot) ? 'outage-cell' : ''} ${slot === selected ? 'focused-hour' : ''}`}
          aria-label={`${hour(slot)} · ${stateFor(slot)}`} title={stateFor(slot)}
          aria-pressed={selected === slot} onClick={() => setFocused(slot)}>
          {outage.has(slot) ? <TriangleAlert size={12} /> : outage.has(slot - 1) ? <ArrowRight size={12} /> : null}
          <span>{hour(slot)}</span>
        </button>)}
        {rows.map(({ title, plan, kind }) => <div key={kind} className="timeline-row">
          <div className={`timeline-label ${kind}`}>{title}</div>
          {scenario.slots.map(({ slot }) => {
            const action = plan.actions?.find((entry) => entry.slot === slot);
            return <div key={slot} className={`timeline-cell ${outage.has(slot) ? 'outage-cell' : ''} ${slot < input.state.current_slot ? 'past-cell' : ''}`}>
              {action && action.pump_m3 > 0 && <span className="action-chip pump-chip" title={`${hour(slot)} · Pumping ${action.pump_m3} m³`}><Zap size={12} /> {action.pump_m3} m³</span>}
              {action?.deliveries.map((delivery) => <span key={delivery.plot_id} className="action-chip water-chip"
                title={`${hour(slot)} · Plot ${delivery.plot_id} · ${delivery.delivered_m3} m³`}>
                <Droplets size={12} /> {delivery.plot_id} · {delivery.delivered_m3} m³
              </span>)}
              {slot < input.state.current_slot && <span className="small muted">Past</span>}
              {plan.actions === null && slot === scenario.slots[0]?.slot && <span className="small muted">—</span>}
            </div>;
          })}
        </div>)}
      </div>
    </div>
    <div className="hour-details" aria-live="polite">
      <strong><Clock3 size={15} /> {hour(selected)} · {stateFor(selected)}
        {restartCap !== undefined && <small>Restart power cap · {kilo(restartCap)} kW</small>}
      </strong>
      {rows.map(({ title, plan }) => {
        const action = plan.actions?.find((entry) => entry.slot === selected);
        return <div key={title}><span>{title}</span>
          <span>Water stock <b>{value(action?.tank_stock_m3)} m³</b></span>
          <span>Quota <b>{value(action?.quota_remaining_m3)} m³</b></span>
          <span>Grid power <b>{kilo(action?.grid_wh)} kW</b></span>
        </div>;
      })}
    </div>
  </section>;
}

function Equity({ scenario, reference, proposed }: { scenario: Scenario; reference: Plan; proposed: Plan }) {
  const farmers = new Map<string, { plots: string[]; demand: number; minimum: number; ref: number; proposed: number; reasons: string[] }>();
  for (const plot of scenario.plots) {
    const result = proposed.plot_results?.find(({ plot_id }) => plot_id === plot.plot_id);
    const baseline = reference.plot_results?.find(({ plot_id }) => plot_id === plot.plot_id);
    const farmer = result?.farmer_id ?? plot.farmer_id;
    const record = farmers.get(farmer) ?? { plots: [], demand: 0, minimum: 0, ref: 0, proposed: 0, reasons: [] };
    record.plots.push(plot.plot_id);
    record.demand += result?.demand_m3 ?? plot.demand_m3;
    record.minimum += result?.minimum_m3 ?? plot.minimum_m3;
    record.ref += baseline?.delivered_on_time_m3 ?? 0;
    record.proposed += result?.delivered_on_time_m3 ?? 0;
    if (result?.reason && !record.reasons.includes(result.reason)) record.reasons.push(result.reason);
    farmers.set(farmer, record);
  }
  const hasPlan = proposed.plot_results !== null;
  const worst = hasPlan ? Math.min(...[...farmers.values()].filter((record) => record.minimum > 0)
    .map((record) => Math.min(10000, Math.floor(record.proposed * 10000 / record.minimum)))) : Infinity;
  return <section className="surface equity-panel" aria-labelledby="equity-title">
    <div className="panel-heading">
      <div className="title-with-icon"><div className="section-icon"><ChartNoAxesCombined size={18} /></div><div>
        <h2 id="equity-title">Service by grower</h2><p className="muted small">Minimum delivery targets met by the deadline</p></div></div>
      <span className="status-pill">Group minimum · {percent(proposed.metrics?.worst_coverage_bp)}</span>
    </div>
    <div className="table-scroll" tabIndex={0} aria-label="Grower table">
      <table className="equity-table">
        <thead><tr>{['Grower', 'Demand', 'Minimum', 'Baseline on time', 'Proposed on time', 'Coverage', 'Change vs baseline', 'Shortfall and reason'].map((label) =>
          <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{[...farmers.entries()].map(([id, record]) => {
          const basis = hasPlan && record.minimum > 0 ? Math.min(10000, Math.floor(record.proposed * 10000 / record.minimum)) : null;
          const delta = record.proposed - record.ref;
          const deficit = Math.max(0, record.minimum - record.proposed);
          return <tr key={id}>
            <th scope="row">{id}<small>{record.plots.length === 1 ? 'Plot' : 'Plots'} {record.plots.join(', ')}</small></th>
            <td>{value(record.demand)} m³</td><td>{value(record.minimum)} m³</td>
            <td>{reference.plot_results ? `${value(record.ref)} m³` : '—'}</td>
            <td>{hasPlan ? `${value(record.proposed)} m³` : '—'}</td>
            <td><div className="coverage-cell"><span>{percent(basis)}</span>
              {basis != null && <span className="coverage-meter"><i style={{ width: `${basis / 100}%` }} /></span>}</div>
              {basis === worst && basis < 10000 && <small className="weak-label">Minimum coverage</small>}</td>
            <td className={delta > 0 ? 'positive' : undefined}>{hasPlan && reference.plot_results ? `${delta > 0 ? '+' : ''}${value(delta)} m³` : '—'}</td>
            <td>{hasPlan ? `${value(deficit)} m³` : '—'}{record.reasons.length > 0 && <small>{record.reasons.join(' · ')}</small>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}

function warningKey(warning: Warning | string) {
  return typeof warning === 'string' ? warning : JSON.stringify(warning);
}

export default function Planning({ comparison, input, scenario, stale, onEvidence }: Props) {
  const weather = comparison.weather_comparison;
  const reference = weather?.reference_on_adverse ?? comparison.baseline;
  const proposed = weather?.buffer_on_adverse ?? comparison.optimized;
  const metrics = proposed.metrics;
  const baseline = reference.metrics;
  const unserved = (plan: Plan) => {
    if (!plan.plot_results) return undefined;
    let missing = 0;
    for (const row of plan.plot_results) {
      const demand = row.demand_m3 ?? scenario.plots.find((p) => p.plot_id === row.plot_id)?.demand_m3;
      if (demand === undefined) return undefined;
      missing += Math.max(0, demand - row.delivered_m3);
    }
    return missing;
  };
  const warnings = [...new Map([...reference.warnings, ...proposed.warnings].map((warning) => [warningKey(warning), warning])).values()];
  return <div className={`results ${stale ? 'results-stale' : ''}`}>
    <section className="overview-stats plan-stats" aria-label="Performance comparison">
      <Stat label="Minimum coverage" title={percent(metrics?.worst_coverage_bp)} reference={percent(baseline?.worst_coverage_bp)} unit=""
        icon={<Activity size={20} />} tone="lime" />
      <Stat label="Water withdrawn" title={value(metrics?.withdrawn_m3)} reference={value(baseline?.withdrawn_m3)} unit="m³"
        icon={<ArrowDownToLine size={19} />} tone="teal" />
      <Stat label="Grid energy" title={kilo(metrics?.grid_wh)} reference={kilo(baseline?.grid_wh)} unit="kWh"
        icon={<Zap size={19} />} tone="gold" />
      <Stat label="Peak hourly grid demand" title={kilo(metrics?.peak_grid_w)} reference={kilo(baseline?.peak_grid_w)} unit="kW"
        icon={<ChartNoAxesCombined size={19} />} tone="periwinkle" />
      <Stat label="Delivered on time" title={value(metrics?.delivered_on_time_m3)} reference={value(baseline?.delivered_on_time_m3)}
        unit="m³" icon={<Droplets size={19} />} tone="teal" />
      <Stat label="Unserved demand" title={value(unserved(proposed))} reference={value(unserved(reference))}
        unit="m³" icon={<Activity size={19} />} tone="gold" />
    </section>
    {weather && <WeatherDecision weather={weather} onEvidence={onEvidence} />}
    {comparison.incident_checkpoint && <section className="surface weather-panel">
      <h2>Recovery from {input.incident?.kind === 'pump_shutdown' ? 'pump shutdown' : 'unexpected outage'}</h2>
      <p>Actions before {hour(comparison.incident_checkpoint.current_slot)} were completed under the original plan.
        Both alternatives resume with {value(comparison.incident_checkpoint.tank_stock_m3)} m³ in the tank
        and {value(comparison.incident_checkpoint.quota_remaining_m3)} m³ of withdrawal quota.</p>
    </section>}
    <Timeline scenario={scenario} input={input} reference={reference} proposed={proposed} weather={Boolean(weather)} />
    <Equity scenario={scenario} reference={reference} proposed={proposed} />
    <section className="surface energy-panel" aria-labelledby="energy-title">
      <h2 id="energy-title"><Zap size={18} /> Pumping and diagnostics</h2>
      {metrics && <p className="muted small">The planner prioritizes the lowest on-time coverage, then reduces
        minimum shortfalls and maximizes deliveries before comparing peak grid demand, grid energy and withdrawals.
        {' '}{input.overrides && 'This comparison includes your operating assumptions. '}
        {scenario.provenance === 'simulated' && <button type="button" className="text-button" onClick={() => onEvidence('demo-site')}>
          <BookOpenText size={14} /> Simulated site assumptions</button>}</p>}
      <div className="energy-facts">
        <span>Pumping energy <b>{kilo(metrics?.pump_wh)} kWh</b> <small>Baseline {kilo(baseline?.pump_wh)} kWh</small></span>
        <span>Final water stock <b>{value(metrics?.tank_stock_m3)} m³</b></span>
        <span>Final quota <b>{value(metrics?.quota_remaining_m3)} m³</b></span>
      </div>
      {warnings.map((warning) => {
        const entry: Warning = typeof warning === 'string' ? { message: warning } : warning;
        return <div className="energy-warning" key={warningKey(warning)}>
          <TriangleAlert size={18} /><div>
            <strong>{entry.value != null ? `${value(entry.value)} ${entry.unit ?? ''} · baseline ${value(entry.reference)} ${entry.unit ?? ''}` : entry.message}</strong>
            {entry.period && <small>{entry.period}</small>}{entry.value != null && <p>{entry.message}</p>}
          </div>
          {entry.source_id && <button type="button" className="text-button" onClick={() => onEvidence(entry.source_id!)}><BookOpenText size={14} /> Provenance</button>}
        </div>;
      })}
    </section>
  </div>;
}
