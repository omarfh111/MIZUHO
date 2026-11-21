import type { Feature, FeatureCollection, Geometry, Point } from 'geojson';

export type Provenance = 'observed' | 'estimated' | 'simulated' | 'unavailable';
export type LayerId = 'plots' | 'solar' | 'wind' | 'anomalies';

export interface SiteProperties {
  site_id: string;
  label: string;
  source_id: string;
  status: Provenance;
  locality?: string;
  description?: string;
  date?: string;
  relief?: 'jendouba-demo';
}

export type Site = Feature<Point, SiteProperties> & { outline?: Geometry };
export type Sites = FeatureCollection<Point, SiteProperties> & { features: Site[] };

export interface LayerProperties {
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
  status: 'available' | 'unavailable' | 'incomplete';
  configured: boolean;
  index: { indexed_chunks: number | null; documents: number };
}

export interface AssistantRequest {
  question: string;
  site_id: string;
  solar_option_id?: string;
  comparison?: CompareRequest;
  recent_questions?: string[];
}

export interface AssistantAnswer {
  paragraphs: { text: string; citation_ids: string[]; fact_ids: string[] }[];
  citations: Citation[];
  facts: { id: string; text: string; provenance: Provenance }[];
  missing_information: string[];
  tools_used: string[];
}
