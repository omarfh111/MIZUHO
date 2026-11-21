import type { Feature, Geometry, Position } from 'geojson';
import type {
  Evidence, Layer, LayerId, LayerProperties, Plot, Scenario, Sites, Slot, SolarOption,
} from '../types.ts';

export const demoDate = '2026-11-21';
export const demoSiteId = 'jendouba-pilote';
export const demoCenter = [8.7702, 36.5007];
export const weatherPair = 'jplus1-demo';
const weatherPairStable = 'jplus1-stable';

export const demoSites: Sites = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: { type: 'Point', coordinates: demoCenter },
    properties: {
      site_id: demoSiteId, label: 'Jendouba', locality: 'Nord-Ouest · Tunisie',
      source_id: 'demo-site', status: 'simulated', date: demoDate,
      description: 'Cinq parcelles desservies par un réservoir gravitaire.',
    },
  }],
};

const coordinates = ([x, z]: number[]): Position => [demoCenter[0] + x / 6800, demoCenter[1] - z / 8100];
const polygon = (points: number[][]): Geometry => ({
  type: 'Polygon', coordinates: [[...points, points[0]].map(coordinates)],
});
const point = (x: number, z: number): Geometry => ({ type: 'Point', coordinates: coordinates([x, z]) });
const feature = (geometry: Geometry, properties: LayerProperties): Feature<Geometry, LayerProperties> => ({
  type: 'Feature', geometry, properties,
});

const crops = ['Oliviers', 'Blé dur', 'Maraîchage', 'Agrumes', 'Fourrage'];
const polygons = [
  [[-31, -19], [-7, -24], [-3, -10], [-28, -6]],
  [[-3, -25], [22, -28], [25, -14], [2, -10]],
  [[-27, -1], [-6, -5], [-1, 13], [-23, 18]],
  [[1, -4], [27, -10], [32, 8], [6, 14]],
  [[-17, 23], [5, 18], [11, 30], [-11, 34]],
];

export const demoLayers: Record<LayerId, Layer> = {
  plots: {
    type: 'FeatureCollection', date: demoDate, status: 'simulated', source_id: 'wapor',
    features: polygons.map((points, index) => feature(polygon(points), {
      plot_id: String.fromCharCode(65 + index), label: `Parcelle ${String.fromCharCode(65 + index)}`,
      crop: crops[index], status: 'simulated', source_id: 'wapor', date: demoDate,
      signal: ['Besoin modéré', 'Besoin modéré', 'Besoin prioritaire', 'Besoin modéré', 'Besoin faible'][index],
      period: 'Journée de démonstration',
    })),
  },
  solar: {
    type: 'FeatureCollection', date: demoDate, status: 'simulated', source_id: 'solar',
    features: [
      feature(point(-44, -6), { option_id: 'toiture', label: 'Toiture de la station', source_id: 'solar' }),
      feature(point(34, -16), { option_id: 'ombriere', label: 'Ombrière agricole', source_id: 'solar' }),
    ],
  },
  wind: { type: 'FeatureCollection', status: 'unavailable', source_id: 'wind', features: [] },
  anomalies: {
    type: 'FeatureCollection', date: demoDate, status: 'simulated', source_id: 'telemetry',
    features: [feature(point(9, 25), {
      label: 'Compteur de distribution', signal: '13 m³ à expliquer', period: 'H09–H10',
      status: 'simulated', source_id: 'telemetry',
    })],
  },
};

export const demoEvidence: Record<string, Evidence> = {
  'demo-site': {
    title: 'Périmètre pilote de Jendouba', organization: 'Mizhuo', date: demoDate, page: null, url: null,
    limitation: 'Le groupement, ses parcelles et ses équipements sont fictifs. Les coordonnées situent la démonstration.',
  },
  wapor: {
    title: 'Essai WaPOR à Jendouba · ETa quotidienne à 10 m', organization: 'FAO', date: '2025', page: null,
    url: 'https://www.fao.org/in-action/remote-sensing-for-water-productivity/news-and-events/news/news-detail/testing-daily-10-m-wapor-data-for-improved-irrigation-in-jendouba--tunisia/en',
    limitation: 'Les parcelles et les signaux de cette carte sont simulés. L’ETa ne mesure pas le prélèvement au forage.',
  },
  solar: {
    title: 'Potentiel photovoltaïque tunisien', organization: 'ANME', date: null, page: null,
    url: 'https://anme.tn/en/content/solar-photovoltaic',
    limitation: 'Contexte régional. Les deux profils horaires de la démonstration sont synthétiques. Un relevé et une étude de raccordement restent nécessaires.',
  },
  wind: {
    title: 'Global Wind Atlas · Tunisie', organization: 'DTU', date: null, page: null,
    url: 'https://globalwindatlas.info/fr/area/Tunisia',
    limitation: 'Aucun extrait local ni modèle de turbine chargé. La production est indisponible.',
  },
  telemetry: {
    title: 'Relevés hydrauliques et énergétiques de démonstration', organization: 'Mizhuo', date: demoDate,
    page: null, url: null, limitation: 'Une hausse de consommation ou un résidu d’eau déclenche une vérification. La cause demande des mesures complémentaires.',
  },
  weather: {
    title: 'Prévisions d’ensemble et incertitude', organization: 'ECMWF', date: null, page: null,
    url: 'https://www.ecmwf.int/en/research/modelling-and-prediction/quantifying-forecast-uncertainty',
    limitation: 'Les deux profils horaires sont simulés. Aucun historique de prévisions locales à J+1 n’a été utilisé.',
  },
};

const solarProfiles = [
  [0, 0, 0, 0, 0, 0, 0, 400, 1200, 2400, 3500, 4200, 4500, 4000, 3200, 1900, 800, 200],
  [0, 0, 0, 0, 0, 0, 100, 700, 1600, 2800, 3800, 4100, 4200, 3900, 3100, 2200, 1300, 450],
];

export const demoSolar: SolarOption[] = ['toiture', 'ombriere'].map((id, index) => ({
  id, label: index === 0 ? 'Toiture de la station' : 'Ombrière agricole', source_id: 'solar', provenance: 'simulated',
  capacity_kwp: 10, tilt_deg: index === 0 ? 24 : 30, azimuth_deg: index === 0 ? 195 : 180, losses_pct: 14,
  period: 'Journée simulée · 24 h', profile_wh: Array.from({ length: 24 }, (_, slot) => solarProfiles[index][slot] ?? 0),
  annual_production_kwh: null, net_savings_tnd: null, payback_years: null,
}));

const slots = (count: number, outages: number[] = [], solar: Record<number, number> = {}): Slot[] =>
  Array.from({ length: count }, (_, slot) => ({
    slot, grid_available: !outages.includes(slot), grid_cap_w: 5000, solar_wh: solar[slot] ?? 0,
  }));

const makePlot = (index: number, demand: number, minimum: number, allowed: number[], deadline: number): Plot => ({
  plot_id: String.fromCharCode(65 + index), farmer_id: `EXP-${String(index + 1).padStart(2, '0')}`,
  crop: crops[index], surface_m2: 500 + index * 100, demand_m3: demand, minimum_m3: minimum,
  allowed_slots: allowed, deadline_slot: deadline, past_deferrals: index === 2 ? 1 : 0,
});

const makeScenario = (
  id: string, label: string, description: string, horizon: Slot[], plots: Plot[], stock: number, quota: number,
  tank: number, fixedSlots: number[], currentSlot = 0, pair?: string,
): Scenario => ({
  id, label, description, site_id: demoSiteId, provenance: 'simulated', slots: horizon, plots,
  site: { tank_capacity_m3: tank, pump_max_m3_per_slot: 10, pump_wh_per_m3: 500, gravity_max_m3_per_slot: 10 },
  state: { current_slot: currentSlot, tank_stock_m3: stock, quota_remaining_m3: quota,
    delivered_by_plot_m3: {}, delivered_on_time_by_plot_m3: {} },
  fixed_pump_m3: horizon.map(({ slot }) => fixedSlots.includes(slot) ? 10 : 0),
  fixed_deliveries: horizon.map(({ slot }) => plots.flatMap((plot, index) =>
    fixedSlots[index] === slot ? [{ plot_id: plot.plot_id, delivered_m3: plot.demand_m3 }] : [])),
  weather_pair_id: pair,
});

const pilotPlots = [
  makePlot(0, 14, 10, [7, 8, 9, 10, 11, 12], 11),
  makePlot(1, 15, 10, [9, 10, 11, 12, 13, 14], 13),
  makePlot(2, 18, 12, [11, 12, 13, 14, 15, 16], 15),
  makePlot(3, 16, 10, [14, 15, 16, 17, 18, 19], 18),
  makePlot(4, 12, 8, [16, 17, 18, 19, 20, 21], 20),
];
const pilotFixed = [8, 11, 13, 16, 18];
const weatherSlots = slots(24, [], { 10: 1000, 13: 3500 }).map((slot) => ({ ...slot, grid_cap_w: 0 }));
const weatherPlots = [makePlot(0, 8, 8, [13], 13)];

export const demoScenarios: Scenario[] = [
  makeScenario('normal', 'Journée normale', 'Réseau disponible sur les 24 créneaux.', slots(24), pilotPlots, 12, 65, 35, pilotFixed),
  makeScenario('announced', 'Coupure annoncée', 'Une fenêtre de pompage avant la coupure du matin.', slots(24, [8, 9, 10, 11]), pilotPlots, 0, 58, 35, pilotFixed),
  makeScenario('successive', 'Coupures successives', 'Deux interruptions suivies d’une reprise sous plafond.', slots(24, [9, 10, 11, 14, 15]), pilotPlots, 10, 48, 35, pilotFixed, 7),
  makeScenario('mini', 'Cas miniature A/B', 'Deux parcelles, trois heures et 10 m³ à partager.', slots(3, [1, 2], { 0: 5000 }),
    [makePlot(0, 10, 10, [1, 2], 2), makePlot(1, 10, 10, [1, 2], 2)], 10, 0, 10, [1, 2], 1),
  makeScenario('jplus1', 'Réserve météo J+1', 'Production solaire réduite à partir de 11 h.', weatherSlots, weatherPlots, 1, 7, 8, [13], 0, weatherPair),
  makeScenario('jplus1-stable', 'Réserve J+1 · Profil stable', 'Le profil défavorable permet le même pompage que le profil central.', weatherSlots, weatherPlots, 1, 7, 8, [13], 0, weatherPairStable),
];
