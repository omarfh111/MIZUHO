/**
 * Schematic geography used by the cinematic entrance.
 *
 * Everything here is deliberately coarse: outlines are hand-simplified and
 * positions are approximate (±5 km). The scene is an illustration of the
 * territory, never a survey or a live measurement.
 */

export type LonLat = readonly [lon: number, lat: number];

/** World units per degree. One unit ≈ 4.6 km of latitude. */
export const SCALE = 24;
export const ORIGIN: LonLat = [9.6, 34.0];

/** Bounds of the rendered map plane (Tunisia plus surrounding sea). */
export const MAP_BOUNDS = { west: 5.6, east: 13.6, south: 29.4, north: 38.6 } as const;

export const toWorld = ([lon, lat]: LonLat): { x: number; z: number } => ({
  x: (lon - ORIGIN[0]) * SCALE,
  z: -(lat - ORIGIN[1]) * SCALE,
});

export const toLonLat = (x: number, z: number): LonLat => [x / SCALE + ORIGIN[0], -z / SCALE + ORIGIN[1]];

export const MAP_SIZE = {
  width: (MAP_BOUNDS.east - MAP_BOUNDS.west) * SCALE,
  depth: (MAP_BOUNDS.north - MAP_BOUNDS.south) * SCALE,
  centerX: ((MAP_BOUNDS.east + MAP_BOUNDS.west) / 2 - ORIGIN[0]) * SCALE,
  centerZ: -((MAP_BOUNDS.north + MAP_BOUNDS.south) / 2 - ORIGIN[1]) * SCALE,
};

/** Simplified mainland outline (clockwise from the Algerian border on the north coast). */
export const TUNISIA_OUTLINE: LonLat[] = [
  [8.62, 36.94], [8.76, 36.96], [8.98, 37.02], [9.22, 37.23], [9.52, 37.25], [9.85, 37.34],
  [9.88, 37.25], [10.05, 37.26], [10.18, 37.19], [10.22, 37.07], [10.27, 36.93], [10.31, 36.82],
  [10.36, 36.72], [10.5, 36.71], [10.64, 36.86], [10.88, 37.02], [11.05, 37.08], [11.12, 36.86],
  [10.98, 36.66], [10.73, 36.45], [10.58, 36.37], [10.52, 36.08], [10.57, 35.92], [10.64, 35.83],
  [10.83, 35.77], [11.0, 35.62], [11.06, 35.5], [11.13, 35.24], [11.02, 35.03], [10.84, 34.83],
  [10.74, 34.71], [10.5, 34.53], [10.25, 34.36], [10.1, 34.27], [10.05, 34.08], [10.1, 33.89],
  [10.32, 33.7], [10.47, 33.6], [10.75, 33.48], [11.11, 33.47], [11.2, 33.24], [11.56, 33.17],
  [11.5, 32.66], [11.48, 32.38], [11.03, 32.17], [10.7, 32.02], [10.43, 31.6], [10.28, 31.22],
  [10.1, 30.86], [9.86, 30.54], [9.53, 30.23], [9.36, 30.74], [9.18, 31.5], [9.05, 32.1],
  [8.33, 32.53], [8.08, 32.95], [7.75, 33.25], [7.53, 33.75], [7.52, 34.12], [7.82, 34.25],
  [8.25, 34.65], [8.28, 34.95], [8.31, 35.3], [8.42, 35.73], [8.31, 35.98], [8.36, 36.22],
  [8.4, 36.45], [8.2, 36.5], [8.4, 36.77], [8.62, 36.94],
];

export const DJERBA: LonLat[] = [
  [10.76, 33.88], [10.98, 33.86], [11.07, 33.78], [11.05, 33.66], [10.9, 33.62], [10.75, 33.68], [10.72, 33.8],
];

export const KERKENNAH: LonLat[] = [[11.05, 34.68], [11.28, 34.8], [11.35, 34.74], [11.12, 34.62]];

/** Schematic course of the Medjerda, from the Algerian border to the Gulf of Tunis. */
export const MEDJERDA: LonLat[] = [
  [8.36, 36.43], [8.55, 36.46], [8.78, 36.49], [8.95, 36.56], [9.08, 36.62], [9.25, 36.6],
  [9.4, 36.58], [9.5, 36.6], [9.61, 36.66], [9.75, 36.76], [9.86, 36.83], [9.98, 36.9],
  [10.08, 37.0], [10.17, 37.06],
];

export interface PlaceMarker {
  id: string;
  label: string;
  kind: 'dam' | 'city';
  at: LonLat;
}

/** Real reservoirs and towns, at approximate positions. */
export const PLACES: PlaceMarker[] = [
  { id: 'sidi-salem', label: 'Sidi Salem Dam', kind: 'dam', at: [9.41, 36.58] },
  { id: 'bou-heurtma', label: 'Bou Heurtma Dam', kind: 'dam', at: [8.74, 36.63] },
  { id: 'mellegue', label: 'Mellègue Dam', kind: 'dam', at: [8.73, 36.3] },
  { id: 'sidi-el-barrak', label: 'Sidi El Barrak Dam', kind: 'dam', at: [9.07, 37.03] },
  { id: 'nebhana', label: 'Nebhana Dam', kind: 'dam', at: [10.02, 35.95] },
  { id: 'tunis', label: 'Tunis', kind: 'city', at: [10.18, 36.8] },
  { id: 'jendouba', label: 'Jendouba', kind: 'city', at: [8.78, 36.5] },
];

export interface EnergySite {
  id: string;
  label: string;
  kind: 'wind' | 'solar';
  at: LonLat;
}

/** Operating renewable plants, at approximate positions. */
export const ENERGY_SITES: EnergySite[] = [
  { id: 'sidi-daoud', label: 'Sidi Daoud wind farm', kind: 'wind', at: [10.9, 37.02] },
  { id: 'bizerte', label: 'Bizerte wind farms', kind: 'wind', at: [9.72, 37.2] },
  { id: 'tozeur', label: 'Tozeur solar plant', kind: 'solar', at: [8.13, 33.92] },
];

/** Centre of the illustrative irrigated perimeter (Medjerda valley near Jendouba). */
export const VALLEY_CENTER: LonLat = [8.77, 36.545];
export const VALLEY_RADIUS = 3.4;

export const formatLatLon = ([lon, lat]: LonLat) =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
