import { Pause, Play, RotateCcw } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { getLayer } from '../api.ts';
import { clockHour, kilo, value } from '../format.ts';
import type { OutageCase } from '../resilience.ts';
import type { Action, FieldZone, Layer, LayerProperties, Plan, Site } from '../types.ts';
import type { MapControls } from './mapControls.ts';

const TerrainMap = lazy(() => import('./TerrainMap.tsx'));
const RegionalSiteScene = lazy(() => import('./RegionalSiteScene.tsx'));
type MeterSeries = OutageCase['incidents'][number]['readings'];

function PilotScene({ site, action, stock, capacity, grid, plots, tankScale, backupActive }: {
  site: Site; action: Action; stock: number; capacity: number; grid: boolean; plots: OutageCase['plots'];
  tankScale?: number; backupActive: boolean;
}) {
  const [layers, setLayers] = useState<{ plots: Layer; solar: Layer }>();
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  const [active, select] = useState<LayerProperties | null>(null);
  const controls = useRef<MapControls | null>(null);
  const fallback = useCallback(() => setError('WebGL unavailable. The hourly readings below follow the same plan.'), []);
  useEffect(() => {
    const controller = new AbortController();
    const get = (id: 'plots' | 'solar') => getLayer(site.properties.site_id, id, 'live', controller.signal);
    Promise.all([get('plots'), get('solar')]).then(([plots, solar]) => {
      if (!controller.signal.aborted) setLayers({ plots, solar });
    }).catch(() => { if (!controller.signal.aborted) setError('The pilot map layers could not be loaded.'); });
    return () => controller.abort();
  }, [site, attempt]);
  return <div className="map-viewport outage-pilot-map" aria-label="Simulated Jendouba network">
    {error ? <p className="outage-map-status" role="status">{error} <button type="button" className="text-button"
      onClick={() => { setError(''); retry(v => v + 1); }}>Retry map</button></p> :
      layers ? <TerrainMap site={site} layers={layers} active={active} select={select} controls={controls} demo
        onUnavailable={fallback} snapshot={{ tank_stock_m3: stock, tank_capacity_m3: capacity, pump_m3: action.pump_m3,
          grid_available: grid, parcels: action.deliveries, tank_scale: tankScale, backup_active: backupActive }}/> :
        <p className="outage-map-status" role="status">Loading the pilot network…</p>}
    {active && <span className="map-tag">{active.label ?? active.plot_id ?? active.equipment}
      {active.plot_id && (plots.some(plot => plot.plot_id === active.plot_id)
        ? ` · ${value(action.deliveries.find(d => d.plot_id === active.plot_id)?.delivered_m3 ?? 0)} m³ this hour`
        : ' · Outside this scenario')}</span>}
  </div>;
}

interface Props {
  site: Site;
  profile?: FieldZone;
  details: OutageCase;
  plan: Plan;
  capacity: number;
  nominalCapacity: number;
  hasBackup: boolean;
  readings?: MeterSeries;
  title: string;
}

export default function OutageReplay({ site, profile, details, plan, capacity, nominalCapacity, hasBackup, readings, title }: Props) {
  const actions = plan.actions;
  const [hour, setHour] = useState(details.start);
  const nextHour = actions?.findIndex(frame => frame.slot >= hour) ?? -1;
  const index = nextHour >= 0 ? nextHour : Math.max(0, (actions?.length ?? 1) - 1);
  const [playing, play] = useState(false);
  const [speed, setSpeed] = useState(1);
  const frame = actions?.[index];
  const reading = readings?.find(r => r.slot === frame?.slot);
  const stock = reading?.physical_stock_m3 ?? frame?.tank_stock_m3;
  const available = frame && !details.outage_slots.includes(frame.slot);
  useEffect(() => { setHour(details.start); }, [details]);
  useEffect(() => { play(false); }, [actions]);
  useEffect(() => {
    if (!playing || !actions) return;
    if (index >= actions.length - 1) { play(false); return; }
    const timer = window.setTimeout(() => setHour(actions[index + 1].slot), 1300 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, actions, index, speed]);
  if (!actions || !frame || stock == null) return <p role="status">No verified physical replay is available for this case.</p>;
  const tankScale = nominalCapacity > 0 ? capacity / nominalCapacity : undefined;
  const backupActive = hasBackup && !available && frame.pump_m3 > 0;
  return <section className="outage-replay" aria-label="Selected outage replay">
    <div className="outage-replay-title"><div><span>{site.properties.label}</span><h3>{title}</h3></div>
      <strong className={available ? 'outage-grid-on' : 'outage-grid-off'}>{available ? 'Grid available' : 'Grid outage'} · {clockHour(frame.slot)}</strong></div>
    <Suspense fallback={<p className="outage-map-status" role="status">Loading the site model…</p>}>
      {profile ? <RegionalSiteScene profile={profile} frame={{ tank_stock_m3: stock, tank_capacity_m3: capacity,
        pump_m3: frame.pump_m3, grid_available: Boolean(available), deliveries: frame.deliveries, tank_scale: tankScale,
        backup_active: backupActive }} /> :
        <PilotScene site={site} action={frame} stock={stock} capacity={capacity} grid={Boolean(available)} plots={details.plots}
          tankScale={tankScale} backupActive={backupActive}/>}
    </Suspense>
    <div className="outage-transport">
      <button type="button" className="button button-secondary" aria-label={playing ? 'Pause outage replay' : 'Play outage replay'} onClick={() => {
        if (index === actions.length - 1) setHour(actions[0].slot);
        play(!playing);
      }}>{playing ? <Pause size={15}/> : <Play size={15}/>}</button>
      <button type="button" className="text-button" aria-label="Restart outage replay" onClick={() => { setHour(actions[0].slot); play(false); }}><RotateCcw size={16}/></button>
      <label><span>{clockHour(frame.slot)}</span><input type="range" aria-label="Outage replay hour" min={0} max={actions.length - 1}
        value={index} onChange={e => { setHour(actions[Number(e.target.value)].slot); play(false); }} /></label>
      <select aria-label="Outage replay speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[1, 2, 4].map(n => <option key={n} value={n}>{n}×</option>)}</select>
    </div>
    <dl className="outage-readings" aria-label="Physical results for this hour">
      <div><dt>End stock</dt><dd>{value(stock)} m³</dd></div>
      <div><dt>Pumped</dt><dd>{value(frame.pump_m3)} m³</dd></div>
      <div><dt>Remaining quota</dt><dd>{value(frame.quota_remaining_m3)} m³</dd></div>
      {reading ? <><div><dt>Tank sensor</dt><dd>{value(reading.reported_stock_m3)} m³</dd></div>
        <div><dt>Water lost</dt><dd>{value(reading.physical_loss_m3)} m³</dd></div></> :
        <div><dt>Grid energy</dt><dd>{kilo(available ? frame.grid_wh : 0)} kWh</dd></div>}
    </dl>
    <div className="outage-deliveries" aria-label="Hourly deliveries">{details.plots.map(plot =>
      <span key={plot.plot_id}>{plot.plot_id}<b>{value(frame.deliveries.find(d => d.plot_id === plot.plot_id)?.delivered_m3 ?? 0)} m³</b></span>)}</div>
  </section>;
}
