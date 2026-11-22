import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, Droplets, Pause, Play, RotateCcw, Sun, Zap } from 'lucide-react';
import { getForecast, getLayer, getReplay } from '../api.ts';
import { useExperience } from '../experience/index.ts';
import { percent } from '../format.ts';
import type { CompareRequest, Comparison, Layer, LayerProperties, Site } from '../types.ts';
import type { Replay, ReplayContext, ReplaySelection } from '../twin.ts';
import type { MapControls } from './mapControls.ts';
import './twin.css';

const TerrainMap = lazy(() => import('./TerrainMap.tsx'));
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Tunis', hour: '2-digit', minute: '2-digit' });
const units = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 });
const reading = (value: number | boolean | null, unit: string) => value == null ? 'Missing' :
  typeof value === 'boolean' ? (value ? 'On' : 'Off') : [units.format(value), unit].filter(Boolean).join(' ');

interface Props {
  site: Site;
  request: CompareRequest;
  comparison: Comparison;
  plan: ReplaySelection['plan'];
  onSelectPlan: (plan: ReplaySelection['plan']) => void;
  onContext: (context: ReplayContext | undefined) => void;
  onGuardianEvent: (event: GuardianEvent | undefined) => void;
  guardian: ReactNode;
}

export interface GuardianEvent {
  id: string;
  reason: 'emergency' | 'clarification';
  context: { site_id: string; comparison: CompareRequest; telemetry: ReplayContext };
}

function Forecast({ siteId }: { siteId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getForecast>>>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getForecast(siteId, controller.signal).then((data) => { if (!controller.signal.aborted) setData(data); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [siteId]);
  if (!data?.test) return <p role="status">{failed ? 'Forecast service unavailable.' : data ? 'Insufficient load history.' : 'Calculating forecast…'}</p>;
  return <><p>Simulated load archive · issued 20 Nov 2026 at 18:00 Tunis time. Held-out mean absolute error over {data.test.hours} hours:
    {' '}{data.test.regression_mae_kw} kW (regression), {data.test.same_hour_last_week_mae_kw} kW (same hour last week).</p>
    <table><thead><tr><th>Forecast hour</th><th>Site load</th></tr></thead><tbody>{data.points.map((p) =>
      <tr key={p.timestamp}><th>{clock.format(new Date(p.timestamp))}</th><td>{reading(p.load_kw,'kW')}</td></tr>)}</tbody></table></>;
}

export default function DigitalTwin({ site, request, comparison, plan, onSelectPlan, onContext, onGuardianEvent, guardian }: Props) {
  const [missing, setMissing] = useState<number[]>([]);
  const [imbalance, setImbalance] = useState<number[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, play] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [attempt, retry] = useState(0);
  const [equipment, inspect] = useState('reservoir');
  const [layers, setLayers] = useState<{ plots: Layer; solar: Layer }>();
  const [layerError, setLayerError] = useState(false);
  const [hardwareError, setHardwareError] = useState(false);
  const [forecastOpen, setForecastOpen] = useState(false);
  const [sensorOpen, setSensorOpen] = useState(false);
  const fallback = useCallback(() => setHardwareError(true), []);
  const controls = useRef<MapControls>(null);
  const cinematic = useExperience().active;
  const weather = comparison.weather_comparison;
  const selected = plan === 'baseline' ? weather?.reference_on_adverse ?? comparison.baseline :
    weather?.buffer_on_adverse ?? comparison.optimized;
  const physicalReplay = useMemo(() => selected.actions && ({
    comparison: request, plan, weather_profile: weather ? 'adverse' as const : 'central' as const,
    actions: selected.actions.map(({ slot, pump_m3, deliveries }) => ({ slot, pump_m3, deliveries })),
  }), [selected.actions, request, plan, weather]);
  const body = useMemo(() => physicalReplay && ({
    ...physicalReplay,
    missing_flow_slots: missing, balance_anomaly_slots: imbalance,
  }), [physicalReplay, missing, imbalance]);
  const [result, setResult] = useState<{ body: typeof body; physicalReplay: typeof physicalReplay; replay: Replay }>();
  const [failure, setFailure] = useState<{ body: typeof body; attempt: number; message: string }>();
  const lastFrame = useRef<Replay['frames'][number] | undefined>(undefined);
  // Virtual faults leave the physical trace unchanged. Keep the current controls and timeline mounted while refreshing readings.
  const replay = result?.physicalReplay === physicalReplay ? result?.replay : undefined;
  const readings = result?.body === body ? replay : undefined;
  const error = failure?.body === body && failure?.attempt === attempt ? failure.message : undefined;
  const frame = replay?.frames[Math.min(index, replay.frames.length - 1)];
  if (frame) lastFrame.current = frame;

  useEffect(() => {
    if (!body) return;
    const controller = new AbortController();
    getReplay(body, controller.signal).then((replay) => {
      if (!controller.signal.aborted) {
        setResult({ body, physicalReplay, replay });
        setFailure(undefined);
      }
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setFailure({ body, attempt, message: error.message });
    });
    return () => controller.abort();
  }, [body, physicalReplay, attempt]);

  useEffect(() => {
    const controller = new AbortController();
    const load = (id: 'plots' | 'solar') => getLayer(site.properties.site_id, id, 'live', controller.signal);
    Promise.all([load('plots'), load('solar')]).then(([plots, solar]) => {
      if (!controller.signal.aborted) setLayers({ plots, solar });
    }).catch(() => { if (!controller.signal.aborted) setLayerError(true); });
    return () => controller.abort();
  }, [site.properties.site_id]);

  useEffect(() => {
    if (!body || !frame || !readings) { onContext(undefined); return; }
    const { comparison: _comparison, ...selection } = body;
    onContext({ ...selection, selected_slot: frame.slot });
    return () => onContext(undefined);
  }, [body, frame, readings, onContext]);

  // A changed replay or sensor injection supersedes any unanswered call from the old trace.
  useEffect(() => { onGuardianEvent(undefined); }, [body, onGuardianEvent]);

  useEffect(() => {
    if (!body || !frame || !readings) return;
    const atSlot = [...readings.alerts, ...readings.events].filter(item => item.simulation_slot === frame.slot);
    const event = ['unexplained_water', 'high_pump_energy_intensity', 'pump_shutdown', 'tank_empty', 'grid_outage', 'missing_flow']
      .map(type => atSlot.find(item => item.type === type)).find(Boolean);
    if (!event) return;
    const { comparison: original, ...trace } = body;
    const siteId = site.properties.site_id;
    onGuardianEvent({ id: [siteId, plan, event.timestamp, event.type, event.equipment_id].join('/'),
      reason: event.type === 'missing_flow' ? 'clarification' : 'emergency',
      context: { site_id: siteId, comparison: original, telemetry: { ...trace, selected_slot: frame.slot } } });
  }, [body, frame, readings, plan, site.properties.site_id, onGuardianEvent]);

  useEffect(() => {
    if (!playing || !replay) return;
    if (index >= replay.frames.length - 1) { play(false); return; }
    const timer = window.setTimeout(() => setIndex(index + 1), 1400 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, replay, index, speed]);

  const toggle = (slots: number[], slot: number) => slots.includes(slot) ? slots.filter((s) => s !== slot) : [...slots, slot].sort((a,b) => a-b);
  const selectMarker = (properties: LayerProperties | null) => inspect(properties?.plot_id ?? properties?.equipment ?? (properties?.option_id ? 'solar' : 'reservoir'));
  const parcel = frame?.parcels.find(({ plot_id }) => plot_id === equipment);
  const events = readings ? [...readings.events, ...readings.alerts].filter((event) => event.simulation_slot === frame?.slot) : [];
  const signals = readings?.measurements.filter((signal) => signal.simulation_slot === frame?.slot) ?? [];
  const retryReplay = <button type="button" onClick={() => retry((value) => value + 1)}>Retry replay</button>;
  useEffect(() => { play(false); }, [plan]);
  const plotMarker = layers?.plots.features.find(({ properties }) => properties.plot_id === equipment)?.properties;
  return <section className="surface twin" aria-label="Operational digital twin">
    <header className="twin-head"><div className="title-with-icon"><div className="section-icon"><Activity size={20}/></div>
      <div><h2>Operational digital twin</h2><p className="muted small">M4 physical replay · virtual instrumentation · Tunis time</p></div></div>
      <div className="twin-switch" role="group" aria-label="Playback plan">{(['baseline','optimized'] as const).map((id) =>
        <button key={id} type="button" aria-pressed={id === plan} onClick={() => onSelectPlan(id)}>
          {id === 'baseline' ? (request.incident ? 'Previous schedule' : weather ? 'Nominal on adverse' : 'Fixed schedule') :
            (request.incident ? 'Recovery plan' : weather ? 'Reserve on adverse' : 'Optimized plan')}</button>)}</div></header>
    {!frame && <p className="twin-message" role="status">{!body ? 'This plan has no actions to replay.' : error ??
      (replay ? 'No simulation slots available.' : 'Loading physical replay…')}{error && retryReplay}</p>}
      <div className="twin-body" hidden={!frame}><div className="map-viewport twin-map">
        {hardwareError || layerError ? <div className="map-loading">Terrain unavailable. Use the equipment inspector below.</div> :
          layers && lastFrame.current && !cinematic && <Suspense fallback={null}><TerrainMap site={site} layers={layers} active={plotMarker ?? null}
            select={selectMarker} controls={controls} onUnavailable={fallback} demo={site.properties.relief === 'jendouba-demo'} snapshot={frame ?? lastFrame.current}/></Suspense>}
        <div className="map-tag"><span className="status-dot"/>{frame?.grid_available ? 'Grid available' : 'Grid outage'}</div>
        <div className="map-hint">{events.length ? events.length + ' replay events' : 'Drag to rotate'}</div>
      </div>{frame && <aside className="twin-inspector"><label>Inspect equipment or parcel<select value={equipment} onChange={(e) => inspect(e.target.value)}>
        {['reservoir','pump','solar','grid',...new Set([...(layers?.plots.features.map(({properties}) => properties.plot_id).filter((id): id is string => Boolean(id)) ?? []), ...frame.parcels.map((p) => p.plot_id)])].map((id) =>
          <option key={id} value={id}>{id.length === 1 ? 'Parcel ' + id : id[0].toUpperCase() + id.slice(1)}</option>)}</select></label>
        <strong className="twin-reading" data-testid="equipment-reading">{equipment === 'reservoir' ? reading(frame.tank_stock_m3, 'm³') : equipment === 'pump' ?
          (frame.pump_m3 > 0 ? 'Running' : 'Stopped') : equipment === 'solar' ? reading(frame.solar_potential_wh, 'Wh') :
          equipment === 'grid' ? (frame.grid_available ? 'Available' : 'Outage') : parcel ? reading(parcel.delivered_m3, 'm³') : 'Outside plan'}</strong>
        <p>{equipment === 'reservoir' ? 'End-of-slot stock · ' + reading(frame.tank_capacity_m3, 'm³') + ' capacity' :
          equipment === 'pump' ? reading(frame.pump_m3, 'm³') + ' pumped · ' + reading(frame.pump_wh, 'Wh') :
          equipment === 'grid' ? reading(frame.grid_wh, 'Wh') + ' consumed this slot' : equipment === 'solar' ?
          reading(frame.solar_wh, 'Wh') + ' used for pumping' : parcel ? percent(parcel.coverage_bp) + ' cumulative minimum coverage' : 'No simulated demand in this scenario.'}</p>
        <ul><li><Droplets/>Remaining quota <b>{reading(frame.quota_remaining_m3, 'm³')}</b></li><li><Activity/>Delivered <b>{reading(frame.delivered_m3, 'm³')}</b></li>
        <li><Sun/>PV potential <b>{reading(frame.solar_potential_wh, 'Wh')}</b></li><li><Zap/>Grid used <b>{reading(frame.grid_wh, 'Wh')}</b></li></ul>
      </aside>}</div>
    {guardian}
    {frame && replay && <>
      <div className="twin-transport"><button type="button" aria-label={playing ? 'Pause playback' : 'Play timeline'} onClick={() => {
        if (index >= replay.frames.length - 1) setIndex(0); play(!playing);
      }}>{playing ? <Pause/> : <Play/>}</button><button type="button" aria-label="Restart timeline" onClick={() => { setIndex(0); play(false); }}><RotateCcw/></button>
        <time dateTime={frame.timestamp}>{clock.format(new Date(frame.timestamp))}</time>
        <input type="range" aria-label="Simulation timeline" min={0} max={replay.frames.length - 1} value={index} onChange={(e) => { play(false); setIndex(+e.target.value); }}/>
        <select aria-label="Playback speed" value={speed} onChange={(e) => setSpeed(+e.target.value)}>{[.5,1,2,4].map((n) => <option key={n} value={n}>{n}×</option>)}</select></div>
      <details className="twin-details"><summary>Parcel deliveries and coverage</summary><table><thead><tr><th>Parcel</th><th>This slot</th><th>On time to date</th><th>Minimum coverage</th></tr></thead><tbody>
        {frame.parcels.map((p) => <tr key={p.plot_id}><th>{p.plot_id}</th><td>{reading(p.delivered_m3,'m³')}</td><td>{reading(p.delivered_on_time_m3,'m³')}</td><td>{percent(p.coverage_bp)}</td></tr>)}
      </tbody></table></details>
      <details className="twin-details" open={sensorOpen} onToggle={(e) => setSensorOpen(e.currentTarget.open)}><summary>Virtual sensors and event injection</summary>
        <fieldset><legend>Inject a sensor fault at {clock.format(new Date(frame.timestamp))}</legend>
          <label><input type="checkbox" checked={missing.includes(frame.slot)} onChange={() => { play(false); setMissing(toggle(missing,frame.slot)); }}/> Missing flow reading</label>
          <label><input type="checkbox" checked={imbalance.includes(frame.slot)} onChange={() => { play(false); setImbalance(toggle(imbalance,frame.slot)); }}/> Water-balance discrepancy</label>
        </fieldset><p className="muted small">Faults affect virtual measurements. Physical stock and approved actions come from the simulator.</p>
        {!readings ? <p role="status">{error ?? 'Updating virtual readings…'} {error && retryReplay}</p> : <>
        <table><thead><tr><th>Equipment</th><th>Measurement</th><th>Value</th><th>Quality</th></tr></thead><tbody>{signals.map((s) =>
          <tr key={s.sensor_id}><th>{s.equipment_id}</th><td>{s.metric}</td><td>{reading(s.value,s.unit)}</td><td>{s.quality}</td></tr>)}</tbody></table>
        <ul>{events.map((e,i) => <li key={i}>{clock.format(new Date(e.timestamp))} · {e.equipment_id} · {e.message}</li>)}</ul>
        </>}
      </details>
      <details className="twin-details" open={forecastOpen} onToggle={(e) => setForecastOpen(e.currentTarget.open)}><summary>Day-ahead load forecast</summary>
        {forecastOpen && <Forecast siteId={site.properties.site_id}/>}
      </details>
    </>}
  </section>;
}
