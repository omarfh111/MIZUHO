import { ArrowRight, ArrowUpRight, BookOpenText, CloudSun, Crosshair, Droplets, Layers3, Map, MapPin } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { getFieldZone } from '../api.ts';
import { useExperience } from '../experience/index.ts';
import { dateLabel, value } from '../format.ts';
import type { FieldZone, Site, TunisiaSource } from '../types.ts';
import { landCover } from './landCover.ts';
import { findCoverSample, sampleSurface, type SurfacePoint } from './surfaceSample.ts';
import SitePicker from './SitePicker.tsx';
import './field-zone.css';

const RegionalSiteScene = lazy(() => import('./RegionalSiteScene.tsx'));

interface Props {
  site: Site;
  sites: Site[];
  onSelectSite: (id: string) => void;
  onEvidence: (id: string) => void;
  onSimulate: () => void;
}

function DataSource({ source }: { source: TunisiaSource }) {
  return <li>
    <a href={source.url} target="_blank" rel="noreferrer">{source.name} <ArrowUpRight size={14} /></a>
    <span>{source.coverage}</span>
    <small>{source.attribution} · {source.license} · Retrieved {dateLabel(source.retrieved_at)}</small>
    {source.assets?.length || source.sha256 ? <details>
      <summary>Original data and verification</summary>
      {source.assets?.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">
        Source asset {index + 1} <ArrowUpRight size={12} />
      </a>)}
      {source.sha256 && <small>SHA-256 <code>{source.sha256}</code></small>}
    </details> : null}
  </li>;
}

function ZoneCoverage({ cover }: { cover: FieldZone['land_cover'] }) {
  const entries = Object.entries(cover.pixel_counts).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return <div className="field-cover">
    <div className="field-cover-bar" aria-hidden="true">
      {entries.map(([code, count]) => <span key={code} style={{
        flexGrow: count, background: landCover.get(Number(code))?.color,
      }} />)}
    </div>
    <ul aria-label="Land-cover class shares">
      {entries.map(([code, count]) => {
        const item = landCover.get(Number(code));
        return <li key={code}>
          <i aria-hidden="true" style={{ background: item?.color }} />
          <span>{item?.label ?? code}</span>
          <strong>{value(count * 100 / total)}%</strong>
        </li>;
      })}
    </ul>
    <p className="muted small">Shares of {value(total)} classified pixels in the map window. Water pixels are included.</p>
  </div>;
}

export default function FieldZoneMap({ site, sites, onSelectSite, onEvidence, onSimulate }: Props) {
  const { active: cinematicActive } = useExperience();
  const [profile, setProfile] = useState<FieldZone>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [surface, setSurface] = useState<'Satellite' | 'Land cover' | 'Elevation'>('Satellite');
  const [point, setPoint] = useState<SurfacePoint | null>(null);
  const { properties } = site;
  const sample = profile && point && sampleSurface(profile.relief, profile.land_cover, point);

  useEffect(() => {
    const controller = new AbortController();
    getFieldZone(properties.site_id, controller.signal).then(result => {
      if (!controller.signal.aborted) setProfile(result);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [properties.site_id, attempt]);

  return <div className="field-zone">
    <div className="workbench">
      <section className="surface map-card field-map" aria-label="Agricultural zone map">
        <header className="map-head">
          <div className="title-with-icon"><div className="section-icon"><Map size={18} /></div><div>
            <h2>{properties.label}</h2><span className="muted small">{properties.locality}</span>
          </div></div>
          {profile && <div className="field-surface-switch" role="group" aria-label="Map surface">
            {(['Satellite', 'Land cover', 'Elevation'] as const).map(option =>
              <button key={option} type="button" aria-pressed={surface === option} onClick={() => setSurface(option)}>{option}</button>)}
          </div>}
        </header>
        {!profile || cinematicActive ? <div className="field-map-status" role={failed ? 'alert' : 'status'}>
          {failed ? <>
            <p>The agricultural zone could not be loaded.</p>
            <button type="button" className="button button-secondary" onClick={() => {
              setFailed(false);
              setAttempt(count => count + 1);
            }}>Retry zone</button>
          </> : !cinematicActive && 'Loading the georeferenced map…'}
        </div> : <Suspense fallback={<div className="field-map-status" role="status">Loading terrain…</div>}>
          <RegionalSiteScene profile={profile} showLandCover={surface === 'Land cover'} satellite={surface === 'Satellite'}
            markers={sample ? [{ ...sample, id: 'sample', label: landCover.get(sample.coverCode ?? 0)?.label ?? 'Sample' }] : []}
            onInspect={setPoint} />
        </Suspense>}
        <footer className="map-footer">
          <span className="map-coordinates"><Crosshair size={14} />
            {site.geometry.coordinates[1].toFixed(4)}° N · {site.geometry.coordinates[0].toFixed(4)}° E
          </span>
          <span>{surface === 'Satellite' ? 'Sentinel-2 composite · 2021' : surface === 'Land cover' ? 'ESA WorldCover 2021 · Copernicus DEM' : 'Copernicus DEM'}</span>
        </footer>
      </section>
      <aside className="map-sidebar" aria-label="Site and layers">
        <section className="surface site-card">
          <div className="aside-label"><MapPin size={15} /> AGRICULTURAL SITE</div>
          <SitePicker sites={sites} siteId={properties.site_id} select={onSelectSite} />
          <h2>{properties.label}</h2>
          <p>{properties.description}</p>
          <button type="button" className="text-button evidence-link" onClick={() => onEvidence(properties.source_id)}>
            <BookOpenText size={14} /> Study reference <ArrowUpRight size={13} />
          </button>
        </section>
        {profile && <section className="surface layers-card">
          <h2><Layers3 size={18} /> Land-cover breakdown</h2>
          <ZoneCoverage cover={profile.land_cover} />
        </section>}
        {profile && <button type="button" className="button button-primary" onClick={onSimulate}>
          Model an irrigation plan <ArrowRight size={16} /></button>}
      </aside>
    </div>
    {profile && <section className="surface field-inspect" aria-label="Geographic sample">
      <label className="field"><span>Inspect mapped land cover</span>
        <select value="" onChange={event => {
          const near = findCoverSample(profile.land_cover, Number(event.target.value), point ?? { u: .5, v: .5 });
          if (near) setPoint(near);
        }}>
          <option value="">Choose a class or click the terrain</option>
          {[...new Set(profile.land_cover.classes)].filter((code): code is number => code !== null)
            .sort((a, b) => a - b).map(code => <option key={code} value={code}>{landCover.get(code)?.label ?? code}</option>)}
        </select>
      </label>
      <div aria-live="polite">{sample ? <>
        <strong>{landCover.get(sample.coverCode ?? 0)?.label ?? 'Unclassified'} · {value(sample.elevation)} m</strong>
        <span>{sample.latitude.toFixed(4)}° N · {sample.longitude.toFixed(4)}° E</span>
      </> : <strong>Inspect a location on the relief</strong>}
        <small>Dominant ESA WorldCover class in the display cell and interpolated Copernicus elevation.</small>
      </div>
    </section>}
    {profile && <div className="field-details">
      <section className="surface field-detail-card" aria-label="Water management context">
        <h2><Droplets size={20} /> Water management context</h2>
        <p className="field-question">{profile.water_question}</p>
        <p>{profile.evidence.limitation}</p>
        <h3>Field verification needed for an operational plan</h3>
        <ul>{profile.missing_inputs.map(input => <li key={input}>{input}</li>)}</ul>
      </section>
      <section className="surface field-detail-card" aria-label="Climate archive">
        <h2><CloudSun size={20} /> Climate archive</h2>
        <p>{dateLabel(profile.climate.start)} – {dateLabel(profile.climate.end)} · {profile.climate.days} complete days</p>
        <dl>
          <div><dt>Mean air temperature</dt><dd>{value(profile.climate.temperature_mean_c)} °C</dd></div>
          <div><dt>Precipitation</dt><dd>{value(profile.climate.precipitation_mm)} mm</dd></div>
          <div><dt>Daily solar irradiation</dt><dd>{value(profile.climate.irradiation_mean_kwh_m2_day)} kWh/m²/day</dd></div>
        </dl>
        <p className="muted small">Regional gridded estimates at the reference point.</p>
      </section>
      <section className="surface field-detail-card field-sources" aria-label="Zone data sources">
        <h2><BookOpenText size={20} /> Data sources</h2>
        <ul>{[profile.location_source, profile.relief.source, profile.land_cover.source, profile.climate.source]
          .map(source => <DataSource key={source.id} source={source} />)}</ul>
      </section>
    </div>}
  </div>;
}
