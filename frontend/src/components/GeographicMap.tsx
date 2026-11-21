import { useEffect, useMemo } from 'react';
import { circleMarker, latLngBounds, type LatLngExpression } from 'leaflet';
import { GeoJSON, MapContainer, TileLayer, useMap } from 'react-leaflet';
import type { Layer, LayerId, LayerProperties, Site } from '../types.ts';
import type { MapControls } from './mapControls.ts';
import 'leaflet/dist/leaflet.css';

const colors: Record<LayerId, string> = { plots: '#c9ef86', solar: '#f7ce76', anomalies: '#f29285', wind: '#a9b9f4' };

function Controls({ center, controls }: { center: LatLngExpression; controls: React.RefObject<MapControls | null> }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, 15);
    controls.current = {
      zoom: (direction) => map.setZoom(map.getZoom() + direction),
      reset: () => map.setView(center, 15),
    };
    return () => { controls.current = null; };
  }, [center, controls, map]);
  return null;
}

interface Props {
  site: Site;
  layers: Partial<Record<LayerId, Layer>>;
  active: LayerProperties | null;
  select: (properties: LayerProperties | null) => void;
  controls: React.RefObject<MapControls | null>;
  tiles: boolean;
  onTileError: () => void;
}

export default function GeographicMap({ site, layers, active, select, controls, tiles, onTileError }: Props) {
  const center = useMemo<LatLngExpression>(() => [site.geometry.coordinates[1], site.geometry.coordinates[0]], [site]);
  const [lat, lon] = center as [number, number];
  return <MapContainer className="geographic-map" center={center} zoom={15} minZoom={11} maxZoom={19}
    zoomControl={false} scrollWheelZoom={false} attributionControl={tiles} maxBounds={latLngBounds([lat - .16, lon - .2], [lat + .16, lon + .2])}>
    <Controls center={center} controls={controls} />
    {tiles && <TileLayer
      url={import.meta.env.VITE_MAP_TILES_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'}
      attribution={import.meta.env.VITE_MAP_TILES_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}
      eventHandlers={{ tileerror: onTileError }}
    />}
    {site.outline && <GeoJSON key={`outline-${site.properties.site_id}`} data={site.outline}
      style={{ color: '#8ec3a9', weight: 2, fillOpacity: .07, dashArray: '7 5' }} />}
    {(Object.entries(layers) as [LayerId, Layer][]).map(([id, layer]) => <GeoJSON key={id} data={layer}
      style={(feature) => ({
        color: colors[id], weight: feature?.properties === active ? 3 : 1.5,
        fillColor: colors[id], fillOpacity: feature?.properties === active ? .38 : .2,
      })}
      pointToLayer={(_, location) => circleMarker(location, { radius: id === 'solar' ? 7 : 6 })}
      onEachFeature={(feature, leaf) => {
        const properties = feature.properties as LayerProperties;
        const tooltip = document.createElement('span');
        tooltip.textContent = properties.label ?? properties.plot_id ?? id;
        leaf.bindTooltip(tooltip);
        leaf.on('click', () => select(properties));
      }}
    />)}
    <GeoJSON key={site.properties.site_id} data={site} pointToLayer={(_, location) => circleMarker(location, {
      radius: 7, color: '#d1fff2', weight: 2, fillColor: '#5dd6b9', fillOpacity: .95,
    })} eventHandlers={{ click: () => select(null) }} />
  </MapContainer>;
}
