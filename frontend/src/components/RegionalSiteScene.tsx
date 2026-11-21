import { useMemo } from 'react';
import type { FieldZone } from '../types.ts';
import type { SurfacePoint } from './surfaceSample.ts';
import CityRelief, { type ReliefMarker } from './CityRelief.tsx';
import { regionalLayout, type RegionalFrame } from './regionalLayout.ts';
import { siteImagery } from './siteImagery.ts';
import { value } from '../format.ts';

interface Props {
  profile: FieldZone;
  frame?: RegionalFrame;
  name?: string;
  markers?: ReliefMarker[];
  showLandCover?: boolean;
  satellite?: boolean;
  onInspect?: (p: SurfacePoint) => void;
}

export default function RegionalSiteScene({ profile, name, frame, markers, onInspect, showLandCover = false, satellite = true }: Props) {
  const geometry = useMemo(() => regionalLayout(profile), [profile]);
  const id = profile.site.properties.site_id;
  const image = siteImagery(id, profile.relief);
  const labels: ReliefMarker[] = geometry?.sectors.map(({ id, point }) => {
    const label = id === 'west' ? 'West' : 'East';
    const amount = frame?.deliveries.find(d => d.plot_id === id)?.delivered_m3 ?? 0;
    return { ...point, id, label: frame ? `${label} · ${value(amount)} m³` : `${label} sector` };
  }) ?? [];
  const pins = [...labels.filter(label => !markers?.some(m => m.id === label.id)), ...(markers ?? [])];
  if (geometry) pins.push({ id: 'station', ...geometry.station,
    label: frame ? `Reservoir · ${value(frame.tank_stock_m3)} m³` : 'Proposed station' });
  return <div className="regional-scene" data-site-scene={id}>
    <CityRelief name={name ?? profile.site.properties.label} relief={profile.relief} landCover={profile.land_cover}
      showLandCover={showLandCover} imagery={image?.src} satellite={satellite} layout={geometry} frame={frame}
      onInspect={onInspect} markers={pins} />
    <p className="scene-provenance">{satellite && image && <><a target="_blank" rel="noreferrer" href={image.original}>Sentinel-2 · 2021 composite ↗</a>{' · '}</>}
      <a href={profile.relief.source.url} target="_blank" rel="noreferrer">Copernicus elevation ↗</a>.
      {' '}Station and pipes illustrate a possible layout. Tree and settlement symbols follow mapped land-cover classes.
      {geometry?.sectors.some(s => s.path.length === 0) && ' A land connection could not be mapped for one or more sectors.'}
    </p>
    {image && satellite && <small className="scene-credit">© ESA WorldCover project 2021 · Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium.</small>}
  </div>;
}
