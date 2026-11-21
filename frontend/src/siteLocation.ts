import type { Site, TunisiaCity } from './types.ts';

export function siteFromLocation(sites: Site[], query: URLSearchParams) {
  const explicit = query.get('site');
  if (explicit !== null) return sites.find(site => site.properties.site_id === explicit)?.properties.site_id ?? '';
  return query.get('city') ? '' : sites[0]?.properties.site_id ?? '';
}

// The national atlas links each study window to its nearest governorate capital within 35 km.
export function nearestSiteCity(coordinates: readonly number[], cities: TunisiaCity[]) {
  const radians = Math.PI / 180;
  const [longitude, latitude] = coordinates;
  const lat = latitude * radians;
  let closest: TunisiaCity | undefined;
  let closestKm = Infinity;
  for (const city of cities) {
    const cityLat = city.latitude * radians;
    const halfDeltaLon = (longitude - city.longitude) * radians / 2;
    const sine = Math.sin((lat - cityLat) / 2) ** 2 + Math.cos(lat) * Math.cos(cityLat) * Math.sin(halfDeltaLon) ** 2;
    const km = 12_742 * Math.asin(Math.sqrt(Math.min(1, sine)));
    if (km <= 35 && km < closestKm) {
      closest = city;
      closestKm = km;
    }
  }
  return closest?.id;
}
