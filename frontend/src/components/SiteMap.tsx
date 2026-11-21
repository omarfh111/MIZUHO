import {
  ArrowUpRight, BookOpenText, Compass, Crosshair, Droplets, Layers3, Map, MapPin,
  Minus, Plus, Radio, Sun, TriangleAlert, Wind, Zap,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLayer, type DataMode } from '../api.ts';
import { dateLabel, provenanceLabel, value } from '../format.ts';
import { useExperience } from '../experience/index.ts';
import type { Layer, LayerId, LayerProperties, Scenario, Site, SolarOption } from '../types.ts';
import type { MapControls } from './mapControls.ts';
import AgriculturePanel from './AgriculturePanel.tsx';
import SitePicker from './SitePicker.tsx';

const TerrainMap = lazy(() => import('./TerrainMap.tsx'));
const FieldZoneMap = lazy(() => import('./FieldZoneMap.tsx'));
const layerOptions = [
  { id: 'plots', title: 'Farm plots', details: 'Crops and water demand', icon: Layers3, tone: 'lime' },
  { id: 'solar', title: 'Solar potential', details: 'Solar PV configurations', icon: Sun, tone: 'gold' },
  { id: 'wind', title: 'Wind potential', details: 'Insufficient data', icon: Wind, tone: 'periwinkle' },
  { id: 'anomalies', title: 'Water anomalies', details: 'Meter discrepancies', icon: Radio, tone: 'coral' },
] as const;
const surveyLayers = [
  { ...layerOptions[0], details: 'Mapped parcel boundaries' },
  { id: 'wapor', title: 'WaPOR water use', details: 'Estimated evapotranspiration · 100 m cells', icon: Droplets, tone: 'teal' },
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

export default function SiteMap(props: Props) {
  if (props.site.properties.field_zone) {
    return <Suspense fallback={<div className="surface page-fallback" role="status">Loading agricultural zone…</div>}>
      <FieldZoneMap site={props.site} sites={props.sites} onSelectSite={props.onSelectSite}
        onEvidence={props.onEvidence} onSimulate={props.onSimulate} />
    </Suspense>;
  }
  return <PilotSiteMap {...props} />;
}

function PilotSiteMap({ site, sites, scenario, selectedOption, mode, onSelectSite, onCompare, onEvidence, onSimulate }: Props) {
  const { active: cinematicActive } = useExperience();
  const [catalog, setCatalog] = useState<LayerState>({});
  const layerChoices = site.properties.survey_available ? surveyLayers : layerOptions;
  const [visible, setVisible] = useState<LayerId[]>(site.properties.survey_available ? ['plots', 'wapor'] : ['plots', 'solar']);
  const [active, setActive] = useState<LayerProperties | null>(null);
  const [hardwareError, setHardwareError] = useState(false);
  const controls = useRef<MapControls>(null);
  const loads = useRef<AbortController | null>(null);
  const fallback = useCallback(() => setHardwareError(true), []);
  const { properties } = site;
  const hasDemoRelief = mode === 'demo' || (properties.status === 'simulated' && properties.relief === 'jendouba-demo');

  const loadLayer = useCallback((id: LayerId) => {
    const signal = loads.current?.signal;
    if (!signal || signal.aborted) return;
    setCatalog(current => ({ ...current, [id]: undefined }));
    getLayer(properties.site_id, id, mode, signal)
      .then(layer => { if (!signal.aborted) setCatalog(current => ({ ...current, [id]: layer })); })
      .catch(() => { if (!signal.aborted) setCatalog(current => ({ ...current, [id]: null })); });
  }, [mode, properties.site_id]);
  useEffect(() => {
    const controller = new AbortController();
    loads.current = controller;
    layerChoices.forEach(({ id }) => loadLayer(id));
    return () => controller.abort();
  }, [layerChoices, loadLayer]);

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
  const inspectable = Object.entries(layers).flatMap(([id, layer]) =>
    id === 'wapor' ? [] : layer.features.map(({ properties }) => properties));

  return <>
    <div className="workbench">
      <section className="surface map-card" aria-label="Agricultural site map">
        <div className="map-head">
          <div className="title-with-icon"><div className="section-icon"><Map size={18} /></div><div>
            <h2>{properties.label} site</h2>
            <span className="muted small">{properties.locality ?? location}</span>
          </div></div>
        </div>
        <div className="map-viewport">
          {hardwareError ? <div className="map-loading" role="status">
            <p><TriangleAlert size={17} /> 3D view unavailable. Use the area selector to inspect site layers.</p>
          </div> : cinematicActive ? <div className="map-loading" aria-hidden /> : <>
            <Suspense fallback={<div className="map-loading" role="status">Loading the map…</div>}>
              <TerrainMap site={site} layers={layers} active={active} select={setActive} controls={controls}
                onUnavailable={fallback} demo={hasDemoRelief} />
            </Suspense>
            <div className="map-tag"><span className="status-dot" />{hasDemoRelief ? 'Simulated terrain' : 'Site geometry'}</div>
            <div className="map-compass" aria-label="North"><span>N</span><Compass size={29} strokeWidth={1.25} /></div>
            <div className="map-controls">
              <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => controls.current?.zoom(1)}><Plus size={19} /></button>
              <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => controls.current?.zoom(-1)}><Minus size={19} /></button>
              <button type="button" aria-label="Reset map view" title="Reset map view" onClick={() => controls.current?.reset()}><Crosshair size={17} /></button>
            </div>
            <div className="map-hint">Drag to rotate</div>
          </>}
        </div>
        <div className="map-footer">
          <span className="map-coordinates"><Crosshair size={14} /> {location}</span>
          <div className="map-key">
            {layers.plots && <span><i className="map-swatch" /> Plots</span>}
            {hasDemoRelief && !hardwareError && layers.plots && <span><i className="map-swatch water-swatch" /> Irrigation network</span>}
            {layers.solar && <span><i className="map-swatch solar-swatch" /> Solar PV</span>}
            {layers.anomalies && <span><i className="map-swatch anomaly-swatch" /> Anomalies</span>}
            {layers.wind && <span><i className="map-swatch wind-swatch" /> Wind</span>}
            {layers.wapor && <span><i className="wapor-gradient" /> AETI · 0–6 mm/day</span>}
          </div>
        </div>
      </section>

      <aside className="map-sidebar" aria-label="Site and layers">
        <section className="surface site-card">
          <div className="aside-label"><MapPin size={15} /> {active ? 'SELECTED AREA' : 'PILOT SITE'}</div>
          <SitePicker sites={sites} siteId={properties.site_id} select={onSelectSite} />
          {inspectable.length > 0 && <select className="site-select" aria-label="Inspect an area"
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
          {layerChoices.map(({ id, title, details, icon: Icon, tone }) => {
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
              {layer === null ? <button type="button" className="text-button" aria-label={`Retry ${title}`}
                onClick={() => loadLayer(id)}>Retry</button> :
                <button type="button" className="toggle" role="switch" aria-label={title} aria-checked={visible.includes(id)}
                  disabled={!layer || layer.status === 'unavailable' || !layer.features.length} onClick={() => toggleLayer(id)}><span /></button>}
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
    {properties.survey_available && <AgriculturePanel siteId={properties.site_id} plotId={active?.plot_id} onEvidence={onEvidence} />}
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
