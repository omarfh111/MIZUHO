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
      site_id: demoSiteId, label: 'Jendouba', locality: 'Nord-Ouest · Tunisia',
      source_id: 'demo-site', status: 'simulated', date: demoDate,
      description: 'Five plots supplied by a gravity-fed reservoir.',
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

const crops = ['Olive trees', 'Durum wheat', 'Vegetables', 'Citrus', 'Forage'];
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
      plot_id: String.fromCharCode(65 + index), label: `Plot ${String.fromCharCode(65 + index)}`,
      crop: crops[index], status: 'simulated', source_id: 'wapor', date: demoDate,
      signal: ['Moderate water demand', 'Moderate water demand', 'Priority water demand', 'Moderate water demand', 'Low water demand'][index],
      period: 'Demo day',
    })),
  },
  solar: {
    type: 'FeatureCollection', date: demoDate, status: 'simulated', source_id: 'solar',
    features: [
      feature(point(-44, -6), { option_id: 'toiture', label: 'Pump station rooftop', source_id: 'solar' }),
      feature(point(34, -16), { option_id: 'ombriere', label: 'Solar canopy', source_id: 'solar' }),
    ],
  },
  wind: { type: 'FeatureCollection', status: 'unavailable', source_id: 'wind', features: [] },
  anomalies: {
    type: 'FeatureCollection', date: demoDate, status: 'simulated', source_id: 'telemetry',
    features: [feature(point(9, 25), {
      label: 'Distribution meter', signal: '13 m³ unaccounted for', period: 'H09–H10',
      status: 'simulated', source_id: 'telemetry',
    })],
  },
};

export const demoEvidence: Record<string, Evidence> = {
  'demo-site': {
    title: 'Jendouba pilot site', organization: 'Mizhuo', date: demoDate, page: null, url: null,
    limitation: 'The irrigation group, plots and equipment are fictional. The coordinates locate the demo.',
  },
  wapor: {
    title: 'WaPOR trial in Jendouba · daily ETa at 10 m resolution', organization: 'FAO', date: '2025', page: null,
    url: 'https://www.fao.org/in-action/remote-sensing-for-water-productivity/news-and-events/news/news-detail/testing-daily-10-m-wapor-data-for-improved-irrigation-in-jendouba--tunisia/en',
    limitation: 'The plots and indicators are simulated. ETa measures evapotranspiration. Well withdrawals require meter readings.',
  },
  solar: {
    title: 'Solar PV potential in Tunisia', organization: 'ANME', date: null, page: null,
    url: 'https://anme.tn/en/content/solar-photovoltaic',
    limitation: 'Regional context. Both hourly demo profiles are synthetic. The site needs a survey and a grid connection study.',
  },
  wind: {
    title: 'Global Wind Atlas · Tunisia', organization: 'DTU', date: null, page: null,
    url: 'https://globalwindatlas.info/fr/area/Tunisia',
    limitation: 'Local wind data and a turbine model are needed to estimate production.',
  },
  telemetry: {
    title: 'Demo water and energy readings', organization: 'Mizhuo', date: demoDate,
    page: null, url: null, limitation: 'Higher consumption or unaccounted-for water warrants a check. Further measurements are needed to establish the cause.',
  },
  weather: {
    title: 'Ensemble forecasts and uncertainty', organization: 'ECMWF', date: null, page: null,
    url: 'https://www.ecmwf.int/en/research/modelling-and-prediction/quantifying-forecast-uncertainty',
    limitation: 'Both hourly profiles are simulated. Local day-ahead forecast records are unavailable.',
  },
};

const solarProfiles = [
  [0, 0, 0, 0, 0, 0, 0, 400, 1200, 2400, 3500, 4200, 4500, 4000, 3200, 1900, 800, 200],
  [0, 0, 0, 0, 0, 0, 100, 700, 1600, 2800, 3800, 4100, 4200, 3900, 3100, 2200, 1300, 450],
];

export const demoSolar: SolarOption[] = ['toiture', 'ombriere'].map((id, index) => ({
  id, label: index === 0 ? 'Pump station rooftop' : 'Solar canopy', source_id: 'solar', provenance: 'simulated',
  capacity_kwp: 10, tilt_deg: index === 0 ? 24 : 30, azimuth_deg: index === 0 ? 195 : 180, losses_pct: 14,
  period: 'Simulated day · 24 hours', profile_wh: Array.from({ length: 24 }, (_, slot) => solarProfiles[index][slot] ?? 0),
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
  makeScenario('normal', 'Normal day', 'The grid is available for all 24 hours.', slots(24), pilotPlots, 12, 65, 35, pilotFixed),
  makeScenario('announced', 'Scheduled outage', 'A pumping window is available before the morning outage.', slots(24, [8, 9, 10, 11]), pilotPlots, 0, 58, 35, pilotFixed),
  makeScenario('successive', 'Successive outages', 'Two outages followed by a capped restart.', slots(24, [9, 10, 11, 14, 15]), pilotPlots, 10, 48, 35, pilotFixed, 7),
  makeScenario('mini', 'A/B demo', 'Two plots, three hours and 10 m³ to share.', slots(3, [1, 2], { 0: 5000 }),
    [makePlot(0, 10, 10, [1, 2], 2), makePlot(1, 10, 10, [1, 2], 2)], 10, 0, 10, [1, 2], 1),
  makeScenario('jplus1', 'Day-ahead weather reserve', 'Solar generation falls from 11:00.', weatherSlots, weatherPlots, 1, 7, 8, [13], 0, weatherPair),
  makeScenario('jplus1-stable', 'Day-ahead reserve · Stable profile', 'The adverse and baseline profiles support the same pumping volume.', weatherSlots, weatherPlots, 1, 7, 8, [13], 0, weatherPairStable),
];
