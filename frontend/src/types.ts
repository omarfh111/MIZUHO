import type { Feature, FeatureCollection, Geometry, MultiPolygon, Point, Polygon } from 'geojson';

export type Provenance = 'observed' | 'estimated' | 'simulated' | 'unavailable';
export type LayerId = 'plots' | 'solar' | 'wind' | 'anomalies' | 'wapor';

export interface SiteProperties {
  site_id: string;
  label: string;
  source_id: string;
  status: Provenance;
  locality?: string;
  description?: string;
  date?: string;
  relief?: 'jendouba-demo';
  survey_available?: boolean;
  field_zone?: boolean;
}

export type Site = Feature<Point, SiteProperties> & { outline?: Geometry };
export type Sites = FeatureCollection<Point, SiteProperties> & { features: Site[] };

export interface TunisiaSource {
  id: string;
  name: string;
  url: string;
  attribution: string;
  license: string;
  provenance: 'mapped' | 'estimated';
  retrieved_at: string;
  coverage: string;
  sha256?: string | null;
  assets?: string[];
}

export interface TunisiaCity {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  population: number | null;
}

export interface TunisiaRelief {
  rows: number;
  cols: number;
  bounds: [west: number, south: number, east: number, north: number];
  elevations: (number | null)[];
  source: TunisiaSource;
}

export interface TunisiaClimate {
  start: string;
  end: string;
  temperature_mean_c: number | null;
  precipitation_mm: number | null;
  irradiation_mean_kwh_m2_day: number | null;
  days: number;
  source: TunisiaSource;
}

export interface LandCoverGrid {
  rows: number;
  cols: number;
  classes: (number | null)[];
}

export interface FieldZone {
  site: Site;
  evidence: Evidence;
  relief: TunisiaRelief;
  land_cover: LandCoverGrid & { pixel_counts: Record<string, number>; source: TunisiaSource };
  climate: TunisiaClimate;
  location_source: TunisiaSource;
  water_question: string;
  missing_inputs: string[];
}

export interface RegionPlanRequest {
  date: string;
  tank_capacity_m3: number;
  initial_stock_m3: number;
  withdrawal_limit_m3: number;
  pump_flow_m3_h: number;
  pump_wh_per_m3: number;
  gravity_flow_m3_h: number;
  grid_cap_w: number;
  pv_capacity_kwp: number;
  pv_performance_ratio: number;
  demand_west_m3: number;
  demand_east_m3: number;
  delivery_start_hour: number;
  delivery_end_hour: number;
  outage_hours: number[];
  demand_basis?: Partial<Record<RegionSector, RegionalDemandBasis>>;
}

export type RegionSector = 'west' | 'east';

export interface RegionalDemandBasis {
  date: string;
  area_m2: number;
  crop_coefficient: number;
  effective_rain_fraction: number;
  application_efficiency: number;
}

export interface RegionalWaterWeather {
  et0_mm: number;
  precipitation_mm: number;
  source: TunisiaSource;
}

export interface RegionalDemandEstimate {
  date: string;
  demand_m3: number;
  et0_mm: number;
  precipitation_mm: number;
  net_depth_mm: number;
  effective_rain_mm: number;
  gross_demand_m3: number;
  source: TunisiaSource;
}

export interface RegionalPlanningContext {
  site_id: string;
  days: { date: string; irradiation_wh_m2: number[]; source: TunisiaSource; weather?: RegionalWaterWeather | null }[];
  anchors: { plot_id: 'west' | 'east'; longitude: number; latitude: number; cover_class: 40 }[];
  missing_inputs: string[];
}

export interface RegionalPlanningResult {
  site_id: string;
  date: string;
  comparison_id: string;
  source: TunisiaSource;
  solar_wh: number[];
  comparison: Comparison;
}

export interface RegionPlanContext {
  inputs: RegionPlanRequest;
  comparison_id: string;
}

export interface TunisiaCatalog {
  boundary: FeatureCollection<Polygon | MultiPolygon>;
  cities: TunisiaCity[];
  sources: TunisiaSource[];
}

export interface TunisiaCityAnalysis {
  city: TunisiaCity;
  relief: TunisiaRelief | null;
  climate: TunisiaClimate | null;
}

export interface TunisiaPeriod {
  start: string;
  end: string;
}

export interface LayerProperties {
  equipment?: 'pump' | 'grid';
  eta_mm_day?: number;
  label?: string;
  plot_id?: string;
  crop?: string;
  signal?: string;
  option_id?: string;
  source_id?: string;
  status?: Provenance;
  date?: string;
  period?: string;
  resolution?: string;
  unit?: string;
}

export type Layer = FeatureCollection<Geometry, LayerProperties> & {
  date?: string;
  source_id?: string;
  status?: Provenance;
};

export interface AgriculturalSurvey {
  site_id: string;
  relief?: TunisiaRelief | null;
  period: string;
  resolution: string;
  interpretation: string;
  optimizer_ready: false;
  parcels: {
    plot_id: string;
    osm_way_id: number;
    surface_m2: number;
    eta_mm_day: number;
    precip_mm_day: number;
    ref_et_mm_day: number;
    et_minus_rain_m3_day: number;
    temperature: {period: string; slope_mm_day_per_c: number; samples: number; p_value: number};
  }[];
}

export interface SiteCapacity {
  tank_capacity_m3: number;
  pump_max_m3_per_slot: number;
  pump_wh_per_m3: number;
  gravity_max_m3_per_slot: number;
}

export interface State {
  current_slot: number;
  tank_stock_m3: number;
  quota_remaining_m3: number;
  delivered_by_plot_m3: Record<string, number>;
  delivered_on_time_by_plot_m3: Record<string, number>;
}

export interface Slot {
  slot: number;
  grid_available: boolean;
  grid_cap_w: number;
  solar_wh: number;
}

export interface Plot {
  plot_id: string;
  farmer_id: string;
  crop: string;
  surface_m2: number;
  demand_m3: number;
  minimum_m3: number;
  deadline_slot: number;
  allowed_slots: number[];
  past_deferrals: number;
}

export interface Delivery {
  plot_id: string;
  delivered_m3: number;
}

export interface Scenario {
  id: string;
  label: string;
  site_id: string;
  provenance: Provenance;
  site: SiteCapacity;
  state: State;
  slots: Slot[];
  plots: Plot[];
  fixed_pump_m3?: number[];
  fixed_deliveries?: Delivery[][];
  weather_pair_id?: string;
  description?: string;
}

export interface CompareRequest {
  scenario_id: string;
  state: State;
  outage_slots: number[];
  solar_option_id: string | null;
  restart_grid_cap_w?: number;
  planning_mode?: 'nominal' | 'weather_buffer';
  weather_pair_id?: string;
  overrides?: OperatingOverrides;
  incident?: {
    kind: 'unexpected_outage' | 'pump_shutdown'; start_slot: number; duration_slots: number;
    previous_actions?: Pick<Action, 'slot' | 'pump_m3' | 'deliveries'>[];
  };
}

export interface OperatingOverrides {
  pump_max_m3_per_slot?: number;
  pump_power_cap_w?: number;
  grid_cap_w?: number;
  gravity_available?: boolean;
  solar_percent?: number;
  pvgis_option_id?: 'ombriere' | 'toiture';
  demand_by_plot_m3?: Record<string, number>;
}

export interface Action {
  slot: number;
  pump_m3: number;
  deliveries: Delivery[];
  tank_stock_m3?: number;
  quota_remaining_m3?: number;
  grid_wh?: number;
}

export interface PlotResult {
  plot_id: string;
  farmer_id?: string;
  demand_m3?: number;
  minimum_m3?: number;
  delivered_m3: number;
  delivered_on_time_m3: number;
  coverage_bp?: number | null;
  reason?: string;
}

export interface Metrics {
  withdrawn_m3: number;
  delivered_m3: number;
  delivered_on_time_m3?: number;
  grid_wh: number;
  pump_wh: number;
  peak_grid_w: number;
  worst_coverage_bp: number | null;
  tank_stock_m3?: number;
  quota_remaining_m3?: number;
}

export interface Warning {
  message: string;
  type?: string;
  source_id?: string;
  period?: string;
  value?: number;
  reference?: number;
  unit?: string;
}

export interface Plan {
  status: 'OPTIMAL' | 'FEASIBLE' | 'NO_SOLUTION';
  actions: Action[] | null;
  metrics: Metrics | null;
  plot_results: PlotResult[] | null;
  warnings: (Warning | string)[];
}

export interface WeatherComparison {
  reference_on_adverse: Plan;
  buffer_on_adverse: Plan;
  early_pump_m3: number;
  additional_early_pump_m3?: number | null;
  before_slot: number;
  expected_stock_m3: number;
  remaining_deficit_m3: number;
  quota_remaining_m3?: number;
  reason?: string;
  source_id?: string;
  provenance?: Provenance;
}

export interface Comparison {
  incident_checkpoint?: State | null;
  baseline: Plan;
  optimized: Plan;
  weather_comparison?: WeatherComparison | null;
}

export interface SolarOption {
  id: string;
  label: string;
  source_id?: string;
  provenance?: Provenance;
  capacity_kwp?: number;
  tilt_deg?: number;
  azimuth_deg?: number;
  losses_pct?: number;
  period?: string;
  profile_wh?: number[];
  production_kwh?: number | null;
  annual_production_kwh?: number | null;
  self_consumed_kwh?: number | null;
  grid_avoided_kwh?: number | null;
  autonomy_hours?: number | null;
  gross_savings_tnd?: number | null;
  net_savings_tnd?: number | null;
  payback_years?: number | null;
}

export interface SolarRequest {
  site_id: string;
  option_ids: string[];
  price_tnd_per_kwh?: number;
}

export interface Evidence {
  title: string;
  organization: string;
  date: string | null;
  page: string | number | null;
  url: string | null;
  limitation: string;
}

export interface Citation {
  id: string;
  source_id: string;
  title: string;
  organization: string;
  date: string | null;
  page: string | number | null;
  url: string;
  section: string;
  excerpt: string;
  limitation: string;
}

export interface AssistantHealth {
  nvidia_model?: string | null;
  status: 'available' | 'unavailable' | 'incomplete';
  configured: boolean;
  index: { indexed_chunks: number | null; documents: number };
}

export interface AssistantRequest {
  language?: 'en' | 'ja' | 'aeb';
  zone_plan?: RegionPlanContext;
  provider?: 'openai' | 'nvidia';
  telemetry?: import('./twin.ts').ReplayContext;
  question: string;
  site_id?: string;
  city_id?: string;
  city_period?: TunisiaPeriod;
  solar_option_id?: string;
  pvgis_option_id?: 'ombriere' | 'toiture';
  comparison?: CompareRequest;
  recent_questions?: string[];
  session_id?: string;
  selected_scenario_id?: string;
  simulation_revision?: number;
  simulation_pending?: boolean;
}

export interface AssistantSimulationContext {
  telemetry?: import('./twin.ts').ReplayContext;
  scenarioId: string;
  revision: number;
  pending: boolean;
  comparison?: CompareRequest;
}

export interface AssistantAnswer {
  paragraphs: { text: string; citation_ids: string[]; fact_ids: string[] }[];
  citations: Citation[];
  facts: { id: string; text: string; provenance: Provenance; source_url?: string | null }[];
  missing_information: string[];
  tools_used: string[];
}
