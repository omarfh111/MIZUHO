import {
  ArrowUpRight, BookOpenText, Box, Compass, Crosshair, Droplets, Layers3, Map, MapPin,
  Minus, Plus, Radio, Sun, TriangleAlert, Wind, Zap,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLayer, type DataMode } from '../api.ts';
import { dateLabel, provenanceLabel, value } from '../format.ts';
import type { Layer, LayerId, LayerProperties, Scenario, Site, SolarOption } from '../types.ts';
import type { MapControls } from './mapControls.ts';

const TerrainMap = lazy(() => import('./TerrainMap.tsx'));
const GeographicMap = lazy(() => import('./GeographicMap.tsx'));
const layerOptions = [
  { id: 'plots', title: 'Farm plots', details: 'Crops and water demand', icon: Layers3, tone: 'lime' },
  { id: 'solar', title: 'Solar potential', details: 'Solar PV configurations', icon: Sun, tone: 'gold' },
  { id: 'wind', title: 'Wind potential', details: 'Insufficient data', icon: Wind, tone: 'periwinkle' },
  { id: 'anomalies', title: 'Water anomalies', details: 'Meter discrepancies', icon: Radio, tone: 'coral' },
] as const;

type LayerState = Partial<Record<LayerId, Layer | null>>;

interface Props {
  site: Site;
  sites: Site[];
  scenario?: Scenario;
  mode: DataMode;
  selectedOption: SolarOption | null;
  onSelectSite: (siteId: string) => void;
  onCompare: (options: string[]) => void;
  onEvidence: (source: string) => void;
  onSimulate: () => void;
}

export default function SiteMap({ site, sites, scenario, selectedOption, mode, onSelectSite, onCompare, onEvidence, onSimulate }: Props) {
  const [catalog, setCatalog] = useState<LayerState>({});
  const [visible, setVisible] = useState<LayerId[]>(['plots', 'solar']);
  const [active, setActive] = useState<LayerProperties | null>(null);
  const isDemo = mode === 'demo';
  const [view, setView] = useState<'3d' | '2d'>(isDemo ? '3d' : '2d');
  const [hardwareError, setHardwareError] = useState(false);
  const [tiles, setTiles] = useState(false);
  const [tileError, setTileError] = useState(false);
  const controls = useRef<MapControls>(null);
  const fallback = useCallback(() => { setHardwareError(true); setView('2d'); }, []);
  const handleTileError = useCallback(() => { setTiles(false); setTileError(true); }, []);
  const { properties } = site;

  useEffect(() => {
    const controller = new AbortController();
    layerOptions.forEach(({ id }) => {
      getLayer(properties.site_id, id, mode, controller.signal)
        .then((layer) => { if (!controller.signal.aborted) setCatalog((catalog) => ({ ...catalog, [id]: layer })); })
        .catch(() => { if (!controller.signal.aborted) setCatalog((catalog) => ({ ...catalog, [id]: null })); });
    });
    return () => controller.abort();
  }, [mode, properties.site_id]);

  const layers = useMemo(() => {
    const active: Partial<Record<LayerId, Layer>> = {};
    visible.forEach((id) => { if (catalog[id]) active[id] = catalog[id]; });
    return active;
  }, [catalog, visible]);
  const optionIds = [...new Set(catalog.solar?.features.flatMap(({ properties }) =>
    properties.option_id ? [properties.option_id] : []) ?? [])];
  const toggleLayer = (id: LayerId) => {
    setVisible((current) => current.includes(id) ? current.filter((layer) => layer !== id) : [...current, id]);
    if (catalog[id]?.features.some(({ properties }) => properties === active)) setActive(null);
  };
  const location = `${site.geometry.coordinates[1].toFixed(4)}° N  ·  ${site.geometry.coordinates[0].toFixed(4)}° E`;
  const inspectable = Object.values(layers).flatMap((layer) => layer.features.map(({ properties }) => properties));

  return <>
    <div className="workbench">
      <section className="surface map-card" aria-label="Agricultural site map">
        <div className="map-head">
          <div className="title-with-icon"><div className="section-icon"><Map size={18} /></div><div>
            <h2>{properties.label} site</h2>
            <span className="muted small">{properties.locality ?? location}</span>
          </div></div>
          <div className="segmented" aria-label="Map view">
            <button type="button" aria-pressed={view === '3d'} disabled={!isDemo || hardwareError} onClick={() => setView('3d')}><Box size={14} /> 3D terrain</button>
            <button type="button" aria-pressed={view === '2d'} onClick={() => setView('2d')}><Map size={14} /> 2D map</button>
          </div>
        </div>
        <div className={`map-viewport ${view === '2d' ? 'map-flat' : ''}`}>
          <Suspense fallback={<div className="map-loading" role="status">Loading the map…</div>}>
            {view === '3d'
              ? <TerrainMap site={site} layers={layers} active={active} select={setActive} controls={controls} onUnavailable={fallback} />
              : <GeographicMap site={site} layers={layers} active={active} select={setActive} controls={controls}
                tiles={tiles} onTileError={handleTileError} />}
          </Suspense>
          <div className="map-tag"><span className="status-dot" />{view === '3d' ? 'Simulated terrain' : tiles ? 'OpenStreetMap basemap' : 'Local layers'}</div>
          <div className="map-compass" aria-label="North"><span>N</span><Compass size={29} strokeWidth={1.25} /></div>
          <div className="map-controls">
            <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => controls.current?.zoom(1)}><Plus size={19} /></button>
            <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => controls.current?.zoom(-1)}><Minus size={19} /></button>
            <button type="button" aria-label="Reset map view" title="Recentrer" onClick={() => controls.current?.reset()}><Crosshair size={17} /></button>
          </div>
          <div className="map-hint">{view === '3d' ? 'Drag to rotate' : <>
            <button type="button" onClick={() => { setTileError(false); setTiles(!tiles); }}>{tiles ? 'Hide basemap' : 'Show online basemap'}</button>
          </>}</div>
          {view === '2d' && (tileError || hardwareError) && <div className="map-notice" role="status">
            <TriangleAlert size={14} /> {tileError ? 'Basemap unavailable · local layers active' : 'Terrain unavailable · 2D map active'}
          </div>}
        </div>
        <div className="map-footer">
          <span className="map-coordinates"><Crosshair size={14} /> {location}</span>
          <div className="map-key">
            {layers.plots && <span><i className="map-swatch" /> Plots</span>}
            {isDemo && view === '3d' && layers.plots && <span><i className="map-swatch water-swatch" /> Irrigation network</span>}
            {layers.solar && <span><i className="map-swatch solar-swatch" /> Solar PV</span>}
            {layers.anomalies && <span><i className="map-swatch anomaly-swatch" /> Anomalies</span>}
            {layers.wind && <span><i className="map-swatch wind-swatch" /> Wind</span>}
          </div>
        </div>
      </section>

      <aside className="map-sidebar" aria-label="Site and layers">
        <section className="surface site-card">
          <div className="aside-label"><MapPin size={15} /> {active ? 'SELECTED AREA' : 'PILOT SITE'}</div>
          {sites.length > 1 && <select className="site-select" aria-label="Pilot site" value={properties.site_id} onChange={(event) => onSelectSite(event.target.value)}>
            {sites.map(({ properties }) => <option key={properties.site_id} value={properties.site_id}>{properties.label}</option>)}
          </select>}
          {view === '2d' && inspectable.length > 0 && <select className="site-select" aria-label="Inspect an area"
            value={active ? inspectable.indexOf(active) : -1}
            onChange={(event) => setActive(inspectable[Number(event.target.value)] ?? null)}>
            <option value={-1}>Site overview</option>
            {inspectable.map((zone, index) => <option key={index} value={index}>{zone.label ?? zone.plot_id ?? `Zone ${index + 1}`}</option>)}
          </select>}
          <h2>{active?.label ?? properties.label}</h2>
          <p>{active ? [active.crop, active.signal, active.period, active.resolution].filter(Boolean).join(' · ') || 'Insufficient data'
            : properties.description ?? 'Site for irrigation simulation and resource monitoring.'}</p>
          {active ? <button type="button" className="text-button" onClick={() => setActive(null)}>Back to site</button> :
            <div className="site-stats">
              <div><span><Layers3 size={14} /> Plots</span><strong>{value(catalog.plots?.features.length)}</strong></div>
              <div><span><Droplets size={14} /> Reservoir</span><strong>{value(scenario?.site.tank_capacity_m3)} <small>m³</small></strong></div>
            </div>}
          <button type="button" className="text-button evidence-link"
            onClick={() => onEvidence(active?.source_id ?? properties.source_id)}><BookOpenText size={14} /> Provenance <ArrowUpRight size={13} /></button>
        </section>

        <section className="surface layers-card">
          <h2><Layers3 size={17} /> Data layers</h2>
          {layerOptions.map(({ id, title, details, icon: Icon, tone }) => {
            const layer = catalog[id];
            const status = layer === undefined ? 'Loading…' : !layer || layer.status === 'unavailable'
              ? 'Unavailable' : provenanceLabel[layer.status ?? layer.features[0]?.properties.status ?? properties.status];
            const sourceId = layer?.source_id ?? layer?.features[0]?.properties.source_id;
            const date = layer?.date ?? layer?.features[0]?.properties.date;
            return <div key={id} className="layer-row">
              <span className={`layer-icon tone-${tone}`}><Icon size={16} /></span>
              <div className="layer-label"><span>{title}</span>
                <small title={details}>{status}{date && ` · ${dateLabel(date)}`}</small>
              </div>
              {sourceId && <button type="button" className="bare-icon layer-source" aria-label={`Source · ${title}`} title={`Source · ${title}`}
                onClick={() => onEvidence(sourceId)}><BookOpenText size={13} /></button>}
              <button type="button" className="toggle" role="switch" aria-label={title} aria-checked={visible.includes(id)}
                disabled={!layer || layer.status === 'unavailable' || !layer.features.length} onClick={() => toggleLayer(id)}><span /></button>
            </div>;
          })}
        </section>
        <div className="map-actions">
          <button type="button" className="button button-primary" onClick={() => onCompare(optionIds)} disabled={optionIds.length < 2}>
            <Zap size={17} /> Compare solar options <ArrowUpRight className="end-icon" size={17} />
          </button>
          {selectedOption && <small className="selected-solar"><Sun size={14} /> {selectedOption.label}</small>}
          <button type="button" className="button button-secondary" onClick={onSimulate} disabled={!scenario}>
            <Droplets size={17} /> Open simulation
          </button>
        </div>
      </aside>
    </div>
    {scenario && <section className="overview-stats" aria-label="Site configuration">
      {[
        { icon: Droplets, title: 'Initial water stock', amount: value(scenario.state.tank_stock_m3), unit: 'm³', tone: 'teal', hint: 'Water available in the reservoir' },
        { icon: Layers3, title: 'Available withdrawal quota', amount: value(scenario.state.quota_remaining_m3), unit: 'm³', tone: 'lime', hint: 'Water remaining for withdrawal' },
        { icon: Zap, title: 'Pump flow rate', amount: value(scenario.site.pump_max_m3_per_slot), unit: 'm³/h', tone: 'gold', hint: 'Rated capacity' },
      ].map(({ icon: Icon, title, amount, unit, tone, hint }) => <div key={title} className="surface overview-stat">
        <div className={`stat-icon tone-${tone}`}><Icon size={19} /></div>
        <div><h3>{title}</h3><strong>{amount} <small>{unit}</small></strong><p>{hint}</p></div>
      </div>)}
    </section>}
  </>;
}
