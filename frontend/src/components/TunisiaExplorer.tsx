import { ArrowDown, ArrowLeft, ArrowUpRight, MapPin, Mountain, Search, Sun, Thermometer, Droplets } from 'lucide-react';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { getTunisia, getTunisiaCity } from '../api.ts';
import { useExperience } from '../experience/index.ts';
import CivicContinuity from './CivicContinuity.tsx';
import type { TunisiaCatalog, TunisiaCity, TunisiaCityAnalysis, TunisiaClimate, TunisiaPeriod, TunisiaSource } from '../types.ts';
import './tunisia-explorer.css';

const CityRelief = lazy(() => import('./CityRelief.tsx'));
const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
const toRadians = Math.PI / 180;

type LinkedSite = {
  id: string;
  readonly coordinates: readonly [number, number];
  label: string;
  onOpen: () => void;
};

interface Props {
  selectedCityId?: string;
  onCityResolved: (city: TunisiaCity) => void;
  onCityChange: (city: TunisiaCity | null, nearbySiteIds: string[]) => void;
  selectedPeriod?: TunisiaPeriod;
  onPeriodChange?: (period: TunisiaPeriod | undefined) => void;
  sites?: readonly LinkedSite[];
}

type Result<T> = { value: T; error?: never } | { value?: never; error: string };
type Camera = { x: number; y: number; scale: number };
type Point = Pick<Camera, 'x' | 'y'>;
const markerOffsets: Point[] = [{ x: 0, y: 0 }, ...[30, 48, 65, 83].flatMap(radius =>
  Array.from({ length: 8 }, (_, index) => ({
    x: radius * Math.cos(index * Math.PI / 4),
    y: radius * Math.sin(index * Math.PI / 4),
  })))];

const showNumber = (value: number | null | undefined, unit: string) =>
  value == null ? 'Unavailable' : `${number.format(value)} ${unit}`;

function showDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : date.format(parsed);
}

function normalize(value: string) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('en');
}

function distanceKm([longitude, latitude]: LinkedSite['coordinates'], city: TunisiaCity) {
  const lat = latitude * toRadians;
  const cityLat = city.latitude * toRadians;
  const halfDeltaLong = (longitude - city.longitude) * toRadians / 2;
  const sine = Math.sin((lat - cityLat) / 2) ** 2 + Math.cos(lat) * Math.cos(cityLat) * Math.sin(halfDeltaLong) ** 2;
  return 12_742 * Math.asin(Math.sqrt(Math.min(1, sine)));
}

function nearestCity(site: LinkedSite, cities: TunisiaCity[]) {
  return cities.reduce<{ id: string; distance: number } | null>((nearest, city) => {
    const distance = distanceKm(site.coordinates, city);
    return distance <= 35 && (nearest === null || distance < nearest.distance) ? { id: city.id, distance } : nearest;
  }, null);
}

function cartography(boundary: FeatureCollection<Polygon | MultiPolygon>) {
  const polygons = boundary.features.flatMap(({ geometry }) =>
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [longitude, latitude] of ring) {
        west = Math.min(west, longitude);
        east = Math.max(east, longitude);
        south = Math.min(south, latitude);
        north = Math.max(north, latitude);
      }
    }
  }
  if (![west, east, south, north].every(Number.isFinite) || west >= east || south >= north) return null;
  const longitudeFactor = Math.cos((south + north) / 2 * toRadians);
  const origin = { longitude: (west + east) / 2, latitude: (south + north) / 2 };
  const project = ([longitude, latitude]: Position) => ({
    x: (longitude - origin.longitude) * longitudeFactor,
    y: origin.latitude - latitude,
  });
  const outlines = polygons.map(polygon => {
    const path = new Path2D();
    for (const ring of polygon) {
      ring.forEach((position, index) => {
        const { x, y } = project(position);
        if (index) path.lineTo(x, y);
        else path.moveTo(x, y);
      });
      path.closePath();
    }
    return path;
  });
  return { outlines, project, width: (east - west) * longitudeFactor, height: north - south };
}

function NationalMap({ catalog, selected, onPick }: {
  catalog: TunisiaCatalog;
  selected: TunisiaCity | undefined;
  onPick: (city: TunisiaCity) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const camera = useRef<Camera>(null);
  const [zooming, setZooming] = useState(false);
  const map = useMemo(() => cartography(catalog.boundary), [catalog.boundary]);

  useLayoutEffect(() => {
    const element = viewport.current;
    const drawing = canvas.current;
    if (!element || !drawing || !map) return;
    const paint = drawing.getContext('2d');
    if (!paint) return;
    const ctx = paint;
    const surface = drawing;
    const markers = new Map([...element.querySelectorAll<HTMLButtonElement>('[data-city-marker]')]
      .map(marker => [marker.dataset.cityMarker, marker]));
    const sorted = [...catalog.cities].sort((a, b) => Number(b.id === selected?.id) - Number(a.id === selected?.id));
    const points = sorted.map(city => ({
      city,
      marker: markers.get(city.id),
      point: map.project([city.longitude, city.latitude]),
    }));
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, width = 0, height = 0, ratio = 1;

    const target = (): Camera => {
      const initial = Math.min((width - 42) / map.width, (height - 64) / map.height);
      if (!selected) return { x: 0, y: 0, scale: initial };
      const point = map.project([selected.longitude, selected.latitude]);
      return { ...point, scale: Math.min(width, height) / (width < 450 ? 1.45 : 1.8) };
    };

    function render(view: Camera) {
      camera.current = view;
      const offsetX = width / 2 - view.x * view.scale;
      const offsetY = height / 2 - view.y * view.scale;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(offsetX, offsetY);
      ctx.scale(view.scale, view.scale);
      const fill = ctx.createLinearGradient(-map!.width / 2, -map!.height / 2, map!.width / 2, map!.height / 2);
      fill.addColorStop(0, '#245e54');
      fill.addColorStop(0.55, '#17463e');
      fill.addColorStop(1, '#453e2b');
      ctx.fillStyle = fill;
      ctx.strokeStyle = 'rgba(165, 216, 192, .5)';
      ctx.lineWidth = 0.8 / view.scale;
      ctx.lineJoin = 'round';
      for (const path of map!.outlines) {
        ctx.fill(path, 'evenodd');
        ctx.stroke(path);
      }
      const visibleMarkers: Point[] = [];
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.strokeStyle = '#c8e4ab86';
      ctx.fillStyle = '#c8e4ab';
      ctx.lineWidth = 1;
      for (const { marker, point, city } of points) {
        if (!marker) continue;
        const x = offsetX + point.x * view.scale;
        const y = offsetY + point.y * view.scale;
        marker.hidden = x < 16 || y < 16 || x > width - 16 || y > height - 16;
        if (marker.hidden) continue;
        // Separate close city targets while keeping each surveyed coordinate visible under its leader.
        const offset = markerOffsets.find(offset => (
          x + offset.x >= 16 && y + offset.y >= 16 && x + offset.x <= width - 16 && y + offset.y <= height - 16
          && visibleMarkers.every(other => Math.hypot(other.x - x - offset.x, other.y - y - offset.y) >= 28)
        ));
        const pin = { x: x + (offset?.x ?? 0), y: y + (offset?.y ?? 0) };
        visibleMarkers.push(pin);
        marker.style.transform = `translate(${pin.x}px, ${pin.y}px) translate(-50%, -50%)`;
        marker.style.zIndex = city.id === selected?.id ? '2' : '1';
        if (pin.x !== x || pin.y !== y) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(pin.x, pin.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function resize() {
      const previousWidth = width;
      const previousHeight = height;
      width = Math.max(64, element!.clientWidth);
      height = Math.max(64, element!.clientHeight);
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (surface.width !== Math.round(width * ratio) || surface.height !== Math.round(height * ratio)) {
        surface.width = Math.round(width * ratio);
        surface.height = Math.round(height * ratio);
      }
      return previousWidth !== width || previousHeight !== height;
    }

    resize();
    const destination = target();
    const origin = camera.current;
    if (!motion.matches && origin && (
      Math.abs(origin.scale - destination.scale) > 0.05 ||
      Math.abs(origin.x - destination.x) > 0.001 || Math.abs(origin.y - destination.y) > 0.001
    )) {
      setZooming(true);
      const start = performance.now();
      const duration = 690;
      const fly = (now: number) => {
        const progress = Math.min(1, Math.max(0, (now - start) / duration));
        const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
        render({
          x: origin.x + (destination.x - origin.x) * eased,
          y: origin.y + (destination.y - origin.y) * eased,
          scale: origin.scale * (destination.scale / origin.scale) ** eased,
        });
        if (progress < 1) frame = requestAnimationFrame(fly);
        else { frame = 0; setZooming(false); }
      };
      frame = requestAnimationFrame(fly);
    } else {
      render(destination);
      setZooming(false);
    }
    const observer = new ResizeObserver(() => {
      if (!resize()) return;
      cancelAnimationFrame(frame);
      render(target());
      setZooming(false);
    });
    observer.observe(element);
    const finish = () => {
      if (!motion.matches) return;
      cancelAnimationFrame(frame);
      render(target());
      setZooming(false);
    };
    motion.addEventListener('change', finish);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      motion.removeEventListener('change', finish);
    };
  }, [catalog.cities, map, selected]);

  if (!map) return <div className="tn-unavailable" role="status">The boundary map is unavailable. Select a city from the directory.</div>;
  return <div className="tn-map" ref={viewport} data-view={selected ? 'city' : 'country'} data-zooming={zooming || undefined}
    role="group" aria-label="Interactive map of Tunisia">
    <canvas ref={canvas} aria-hidden="true" />
    <div className="tn-map-label" aria-live="polite">
      <span>{selected ? 'City view' : 'Country view'}</span>
      <strong>{selected?.name ?? 'Tunisia'}</strong>
    </div>
    <span className="tn-compass" aria-label="North">N <span aria-hidden="true">↑</span></span>
    {catalog.cities.map(city => (
      <button type="button" className="tn-marker" aria-label={`Explore ${city.name}`}
        aria-pressed={city.id === selected?.id} key={city.id} data-city-marker={city.id} onClick={() => onPick(city)}>
        <span className="tn-marker-dot" aria-hidden="true" />
        <span className="tn-marker-name" aria-hidden="true">{city.name}</span>
      </button>
    ))}
    <div className="tn-map-key"><span /> City <span /> Governorate boundary</div>
  </div>;
}

function SourceNote({ source }: { source: TunisiaSource }) {
  return <li>
    <a href={source.url} target="_blank" rel="noreferrer">{source.name} <ArrowUpRight aria-hidden="true" size={13} /></a>
    <span>{source.coverage}</span>
    <small>{source.provenance === 'mapped' ? 'Mapped' : 'Estimated'} · {source.attribution}
      {source.license && ` · ${source.license}`}{source.retrieved_at && ` · Retrieved ${showDate(source.retrieved_at)}`}</small>
    {Boolean(source.assets?.length || source.sha256) && <details className="tn-source-proof">
      <summary>Original data and checksum</summary>
      {source.assets?.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">
        Original terrain tile {index + 1} <ArrowUpRight aria-hidden="true" size={12} />
      </a>)}
      {source.sha256 && <small>Source SHA-256 <code>{source.sha256}</code></small>}
    </details>}
  </li>;
}

function ClimateSummary({ city, archive, selectedPeriod, onPeriodChange }: {
  city: TunisiaCity;
  archive: TunisiaClimate;
  selectedPeriod?: TunisiaPeriod;
  onPeriodChange?: Props['onPeriodChange'];
}) {
  const fullPeriod = { start: archive.start, end: archive.end };
  const valid = (period: TunisiaPeriod) => period.start >= archive.start && period.start <= period.end && period.end <= archive.end;
  const [period, setPeriod] = useState(() => selectedPeriod && valid(selectedPeriod) ? selectedPeriod : fullPeriod);
  const [submitted, setSubmitted] = useState<TunisiaPeriod | undefined>(
    () => selectedPeriod && valid(selectedPeriod) ? selectedPeriod : undefined,
  );
  const [result, setResult] = useState<Result<TunisiaClimate | null>>();
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!submitted) return;
    const controller = new AbortController();
    getTunisiaCity(city.id, controller.signal, submitted).then(profile => {
      if (controller.signal.aborted) return;
      setResult({ value: profile.climate });
      onPeriodChange?.(submitted);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setResult({ error: 'Climate data could not be loaded for these dates. Try again.' });
    });
    return () => controller.abort();
  }, [city.id, onPeriodChange, submitted]);

  const climate = submitted ? result?.value : archive;
  return <>
    <form className="tn-date-form" onSubmit={event => {
      event.preventDefault();
      setInvalid(!valid(period));
      if (valid(period)) {
        setResult(undefined);
        setSubmitted({ ...period });
      }
    }}>
      <div className="tn-date-fields">
        <label>Start date
          <input type="date" min={archive.start} max={archive.end} required value={period.start}
            onChange={event => { setPeriod({ ...period, start: event.target.value }); setInvalid(false); }} />
        </label>
        <label>End date
          <input type="date" min={archive.start} max={archive.end} required value={period.end}
            onChange={event => { setPeriod({ ...period, end: event.target.value }); setInvalid(false); }} />
        </label>
      </div>
      <div className="tn-date-actions">
        <button type="submit" className="button button-secondary" disabled={Boolean(submitted && !result)}>Apply dates</button>
        {submitted && <button type="button" className="tn-country-btn" onClick={() => {
          setPeriod(fullPeriod);
          setSubmitted(undefined);
          setResult(undefined);
          setInvalid(false);
          onPeriodChange?.(undefined);
        }}>Full archive</button>}
      </div>
      {invalid && <p role="alert" className="tn-form-error">Choose an end date at or after the start date.</p>}
    </form>
    {climate ? <>
      <p className="tn-period" aria-live="polite">{showDate(climate.start)} – {showDate(climate.end)} · {climate.days} days</p>
      <dl>
        <div><dt><Thermometer size={15} aria-hidden="true" /> Mean air temperature</dt><dd>{showNumber(climate.temperature_mean_c, '°C')}</dd></div>
        <div><dt><Droplets size={15} aria-hidden="true" /> Period precipitation</dt><dd>{showNumber(climate.precipitation_mm, 'mm')}</dd></div>
        <div><dt><Sun size={15} aria-hidden="true" /> Mean daily solar irradiation</dt><dd>{showNumber(climate.irradiation_mean_kwh_m2_day, 'kWh/m²/day')}</dd></div>
      </dl>
    </> : <p role={result?.error ? 'alert' : 'status'} className="tn-terrain-status">
      {result?.error ?? (result?.value === null ? 'No complete climate records are available for these dates.' : 'Loading climate data…')}
    </p>}
    <ul className="tn-sources"><SourceNote source={climate?.source ?? archive.source} /></ul>
  </>;
}

function CityAnalysis({ city, analysis, retry, sites, selectedPeriod, onPeriodChange }: {
  city: TunisiaCity;
  analysis: Result<TunisiaCityAnalysis> | undefined;
  retry: () => void;
  sites: readonly LinkedSite[];
  selectedPeriod?: TunisiaPeriod;
  onPeriodChange?: Props['onPeriodChange'];
}) {
  const cinematic = useExperience().active;
  const profile = analysis?.value;
  const climate = profile?.climate;
  const relief = profile?.relief;
  return <section className="tn-city" id="tunisia-city-analysis" tabIndex={-1} aria-label={`${city.name} analysis`}>
    <header className="tn-city-heading">
      <div><p className="tn-kicker"><MapPin size={14} aria-hidden="true" /> City analysis</p>
        <h2>{city.name}</h2></div>
      <p className="tn-coordinates">{city.latitude.toFixed(3)}°N · {city.longitude.toFixed(3)}°E</p>
    </header>
    {!analysis && <div className="tn-unavailable" role="status">Loading city data…</div>}
    {analysis?.error && <div className="tn-unavailable" role="alert">
      <span>{analysis.error}</span><button type="button" className="button button-secondary" onClick={retry}>Retry city data</button>
    </div>}
    {profile && <div className="tn-analysis-grid">
      <section className="tn-analysis-card" aria-labelledby="tn-relief-title">
        <header><Mountain size={21} aria-hidden="true" /><div><h3 id="tn-relief-title">Terrain</h3>
          <p>Elevation model · local city surroundings</p></div></header>
        {relief && !cinematic ? <Suspense fallback={<div className="tn-terrain-status" role="status">Loading terrain…</div>}>
          <CityRelief name={city.name} relief={relief} /></Suspense> :
          !relief && <p className="tn-terrain-status">Elevation data are unavailable for this city.</p>}
        {relief && <ul className="tn-sources"><SourceNote source={relief.source} /></ul>}
      </section>
      <section className="tn-analysis-card tn-climate" aria-labelledby="tn-climate-title">
        <header><Sun size={21} aria-hidden="true" /><div><h3 id="tn-climate-title">Climate summary</h3>
          <p>Historical gridded estimates</p></div></header>
        {climate ? <ClimateSummary city={city} archive={climate}
          selectedPeriod={selectedPeriod} onPeriodChange={onPeriodChange} /> :
          <p className="tn-terrain-status">Climate records are unavailable for this city.</p>}
      </section>
    </div>}
    <section className="tn-field">
      <div><h3>Field sites and simulation</h3><p>{sites.length
        ? 'Open a nearby field site to inspect its mapped data and available planning inputs.'
        : 'Parcel boundaries, irrigation allocations, and equipment measurements are unavailable for this city.'}</p></div>
      {!!sites.length && <div className="tn-site-actions">
        {sites.map(site => <button type="button" className="button button-secondary" key={site.label} onClick={site.onOpen}>
          {site.label}<ArrowUpRight size={15} aria-hidden="true" />
        </button>)}
      </div>}
    </section>
    <CivicContinuity city={city.name} />
  </section>;
}

export default function TunisiaExplorer({ selectedCityId, onCityResolved, onCityChange, selectedPeriod, onPeriodChange, sites = [] }: Props) {
  const [catalog, setCatalog] = useState<Result<TunisiaCatalog>>();
  const [catalogAttempt, retryCatalog] = useState(0);
  const [cityAnalysis, setCityAnalysis] = useState<{ id: string; result: Result<TunisiaCityAnalysis> }>();
  const [cityAttempt, retryCity] = useState(0);
  const [search, setSearch] = useState('');
  const directoryRef = useRef<HTMLInputElement>(null);
  const data = catalog?.value;
  const selected = data?.cities.find(city => city.id === selectedCityId);
  const activeCityId = selected?.id;
  useEffect(() => { if (selected) onCityResolved(selected); }, [selected, onCityResolved]);
  const cityResult = cityAnalysis?.id === activeCityId ? cityAnalysis?.result : undefined;
  const matching = useMemo(() => {
    const needle = normalize(search.trim());
    return (data?.cities ?? []).filter(city => normalize(city.name).includes(needle));
  }, [data, search]);
  const nearbySites = activeCityId && data ? sites.filter(site => nearestCity(site, data.cities)?.id === activeCityId) : [];
  const pickCity = (city: TunisiaCity | null) => onCityChange(city,
    city && data ? sites.filter(site => nearestCity(site, data.cities)?.id === city.id).map(site => site.id) : []);

  useEffect(() => {
    const controller = new AbortController();
    getTunisia(controller.signal).then(value => {
      if (!controller.signal.aborted) setCatalog({ value });
    }).catch(() => {
      if (!controller.signal.aborted) setCatalog({ error: 'The national map service is unavailable.' });
    });
    return () => controller.abort();
  }, [catalogAttempt]);

  useEffect(() => {
    if (!activeCityId) return;
    const controller = new AbortController();
    getTunisiaCity(activeCityId, controller.signal).then(value => {
      if (!controller.signal.aborted) setCityAnalysis({ id: activeCityId, result: { value } });
    }).catch(() => {
      if (!controller.signal.aborted) setCityAnalysis({ id: activeCityId, result: { error: 'The city data could not be loaded.' } });
    });
    return () => controller.abort();
  }, [activeCityId, cityAttempt]);

  return <div className="tn-explorer">
    <header className="tn-heading">
      <div className="tn-kicker"><MapPin size={15} aria-hidden="true" /> National observatory</div>
      <h1><em>Explore</em> Tunisia</h1>
      <p>Select a city to explore local water and energy conditions. Open a nearby irrigation site to see which parcels can receive water on time.</p>
    </header>
    {!catalog && <div className="tn-unavailable" role="status">Loading Tunisia’s boundaries and cities…</div>}
    {catalog?.error && <div className="tn-unavailable" role="alert">
      <span>{catalog.error}</span><button type="button" className="button button-secondary" onClick={() => {
        setCatalog(undefined);
        retryCatalog(attempt => attempt + 1);
      }}>Retry map</button>
    </div>}
    {data && <>
      <div className="tn-map-grid">
        <NationalMap catalog={data} selected={selected} onPick={pickCity} />
        <aside className="tn-directory" aria-label="City directory">
          <header><div><h2>Cities</h2><p>{data.cities.length} available</p></div>
            {selected && <button type="button" className="tn-country-btn" onClick={() => {
              pickCity(null);
              setSearch('');
              directoryRef.current?.focus();
            }}><ArrowLeft size={15} aria-hidden="true" /> Back to Tunisia</button>}
          </header>
          <label className="tn-search"><Search size={17} aria-hidden="true" />
            <input ref={directoryRef} type="search" aria-label="Search cities" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search cities" />
          </label>
          {selected && <a className="tn-analysis-link" href="#tunisia-city-analysis" onClick={event => {
            event.preventDefault();
            const analysis = document.getElementById('tunisia-city-analysis');
            analysis?.focus({ preventScroll: true });
            analysis?.scrollIntoView({ block: 'start' });
          }}>{selected.name} analysis <ArrowDown size={16} aria-hidden="true" /></a>}
          {matching.length ? <ul className="tn-city-list">
            {matching.map(city => <li key={city.id}>
              <button type="button" aria-label={`View ${city.name}`} aria-pressed={city.id === activeCityId}
                onClick={() => pickCity(city)}>
                <MapPin size={16} aria-hidden="true" /><span>{city.name}</span><ArrowUpRight size={15} aria-hidden="true" />
              </button>
            </li>)}
          </ul> : <p role="status" className="tn-empty">No cities match your search.</p>}
        </aside>
      </div>
      <details className="tn-map-sources">
        <summary>Map sources</summary>
        <ul className="tn-sources">{data.sources.map(source => <SourceNote source={source} key={source.id} />)}</ul>
      </details>
      {selectedCityId && !selected && <div className="tn-unavailable" role="status">
        This city is absent from the current catalogue.
        <button type="button" className="button button-secondary" onClick={() => pickCity(null)}>Back to Tunisia</button>
      </div>}
      {selected && <CityAnalysis key={selected.id} city={selected} analysis={cityResult} sites={nearbySites}
        selectedPeriod={selectedPeriod} onPeriodChange={onPeriodChange} retry={() => {
        setCityAnalysis(undefined);
        retryCity(attempt => attempt + 1);
      }} />}
    </>}
  </div>;
}
