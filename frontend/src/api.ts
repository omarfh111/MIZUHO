import type { FeatureCollection, Geometry, Position } from 'geojson';
import type { Replay, ReplayBody } from './twin.ts';
import type { CaseSettings, OutageCase, OutageGrid, StressPlan } from './resilience.ts';
import type { FieldZone, RegionalDemandBasis, RegionalDemandEstimate, RegionalPlanningContext, RegionPlanRequest,
  RegionalPlanningResult, TunisiaCatalog, TunisiaCityAnalysis, TunisiaPeriod } from './types.ts';
import { demoEvidence, demoLayers, demoScenarios, demoSiteId, demoSites, demoSolar } from './demo/catalog.ts';
import { demoCompare } from './demo/planner.ts';
import type { AssistantAnswer, AssistantHealth, AssistantRequest, Citation, CompareRequest, Comparison, Evidence, Layer, LayerId, Plan, Scenario, SiteProperties, Sites, SolarOption, SolarRequest } from './types.ts';

export type DataMode = 'live' | 'demo';
export type FieldErrors = Record<string, string>;

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly fields: FieldErrors = {}) {
    super(message);
    this.name = 'ApiError';
  }
}

function validationFields(payload: unknown): FieldErrors {
  const response = payload as { detail?: { loc: (string | number)[]; msg: string }[] };
  if (!Array.isArray(response?.detail)) return {};
  return Object.fromEntries(response.detail.filter((item) => Array.isArray(item.loc)).map(({ loc, msg }) => [
    loc.slice(loc[0] === 'body' ? 1 : 0).join('.'), msg,
  ]));
}

async function request<T>(path: string, signal: AbortSignal, body?: unknown, timeout = 30000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError('Service unavailable. Check the API connection.', 503);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 422) {
    throw new ApiError('Check the inputs before recalculating.', 422, validationFields(payload));
  }
  if (!response.ok || payload === null) {
    throw new ApiError('Service unavailable. Try again in a moment.', response.ok ? 503 : response.status);
  }
  return payload as T;
}

export function getReplay(body: ReplayBody, signal: AbortSignal): Promise<Replay> {
  return request('telemetry/replay', signal, body);
}

export function getOutageGrid(siteId: string, plan: StressPlan, target: number, signal: AbortSignal,
  starts?: number[], durations?: number[]) {
  return request<OutageGrid>(`sites/${encodeURIComponent(siteId)}/resilience/grid`, signal,
    { plan, target_percent: target, starts, durations }, 120000);
}

export function getOutageCase(siteId: string, plan: StressPlan, target: number, start: number, duration: number,
  settings: CaseSettings, signal: AbortSignal) {
  return request<OutageCase>(`sites/${encodeURIComponent(siteId)}/resilience/case`, signal,
    { plan, target_percent: target, start, duration, ...settings }, 120000);
}

export interface HouseholdInputs {
  start_hour: number; duration_hours: number; households: number; essential_w_per_home: number;
  lighting_w_per_home: number; lights_from_hour: number; lights_until_hour: number;
  available_ac_wh: number; island_output_w: number;
}

export interface HouseholdResult {
  provenance: 'simulated'; demand_wh: number; supplied_wh: number; unserved_wh: number;
  minimum_island_output_w: number; first_shortfall_after_minutes: number | null;
  hours: { day_offset: number; hour: number; demand_wh: number; supplied_wh: number; unserved_wh: number; remaining_ac_wh: number }[];
}

export function runHouseholdContinuity(inputs: HouseholdInputs, signal: AbortSignal) {
  return request<HouseholdResult>('resilience/households', signal, inputs);
}

export function getForecast(siteId: string, signal: AbortSignal) {
  return request<{
    status: 'ok' | 'insufficient_history'; points: { timestamp: string; load_kw: number }[];
    test: { regression_mae_kw: number; same_hour_last_week_mae_kw: number; hours: number } | null;
  }>('telemetry/forecast', signal, { site_id: siteId, as_of: '2026-11-20T18:00:00+01:00' });
}

function unreadable() {
  return new ApiError('The API response could not be read.', 502);
}

let nationalCatalog: { value: TunisiaCatalog; expiresAt: number } | undefined;

export async function getTunisia(signal: AbortSignal): Promise<TunisiaCatalog> {
  signal.throwIfAborted();
  if (nationalCatalog && nationalCatalog.expiresAt > Date.now()) return nationalCatalog.value;
  const value = await request<TunisiaCatalog>('tunisia', signal);
  if (value.boundary?.type !== 'FeatureCollection' || !Array.isArray(value.boundary.features) ||
      !Array.isArray(value.cities) || !Array.isArray(value.sources)) throw unreadable();
  signal.throwIfAborted();
  nationalCatalog = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}

export function getFieldZone(siteId: string, signal: AbortSignal): Promise<FieldZone> {
  return request(`sites/${encodeURIComponent(siteId)}/field-zone`, signal);
}

export function getRegionalPlanning(siteId: string, signal: AbortSignal): Promise<RegionalPlanningContext> {
  return request(`sites/${encodeURIComponent(siteId)}/planning`, signal);
}

export function runRegionalPlanning(siteId: string, inputs: RegionPlanRequest, signal: AbortSignal): Promise<RegionalPlanningResult> {
  return request(`sites/${encodeURIComponent(siteId)}/planning`, signal, inputs, 60000);
}

export function estimateRegionalDemand(siteId: string, basis: RegionalDemandBasis, signal: AbortSignal) {
  return request<RegionalDemandEstimate>(`sites/${encodeURIComponent(siteId)}/demand-estimate`, signal, basis);
}

export function getTunisiaCity(cityId: string, signal: AbortSignal, period?: TunisiaPeriod): Promise<TunisiaCityAnalysis> {
  const query = period ? `?${new URLSearchParams({ start: period.start, end: period.end })}` : '';
  return request(`tunisia/cities/${encodeURIComponent(cityId)}${query}`, signal);
}

export function getRadiationDay(day: string, signal: AbortSignal) {
  return request<{ source_url: string; observations: { reported_at: string; radiation_w_m2: number }[] }>(
    `weather/bouhertma?day=${encodeURIComponent(day)}`, signal);
}

function centerOf(geometry: Geometry): Position | undefined {
  const coordinates: Position[] = [];
  const collect = (parts: unknown) => {
    if (!Array.isArray(parts)) return;
    if (typeof parts[0] === 'number' && typeof parts[1] === 'number') coordinates.push(parts);
    else parts.forEach(collect);
  };
  if ('coordinates' in geometry) collect(geometry.coordinates);
  if (!coordinates.length) return;
  const range = (index: number) => coordinates.reduce(([min, max], point) =>
    [Math.min(min, point[index]), Math.max(max, point[index])], [Infinity, -Infinity]);
  return [0, 1].map((index) => {
    const [min, max] = range(index);
    return (min + max) / 2;
  });
}

export interface Catalog {
  mode: DataMode;
  sites: Sites;
  scenarios: Scenario[];
}

export async function getCatalog(signal: AbortSignal): Promise<Catalog> {
  const mode = import.meta.env.VITE_DATA_MODE;
  const demo: Catalog = { mode: 'demo', sites: demoSites, scenarios: demoScenarios };
  if (mode === 'demo' || new URLSearchParams(window.location.search).get('mode') === 'demo') return demo;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
  try {
    const [sites, scenarios] = await Promise.all([
      request<FeatureCollection<Geometry, SiteProperties>>('sites', deadline),
      request<Scenario[] | { scenarios: Scenario[] }>('scenarios', deadline),
    ]);
    const list = Array.isArray(scenarios) ? scenarios : scenarios.scenarios;
    if (sites.type !== 'FeatureCollection' || !Array.isArray(sites.features) || !Array.isArray(list)
      || list.some(({ id, site, state, slots, plots }) => !id || !site || !state || !Array.isArray(slots) || !Array.isArray(plots))) {
      throw unreadable();
    }
    const markers: Sites = {
      type: 'FeatureCollection',
      features: sites.features.flatMap((feature) => {
        if (!feature.geometry || !feature.properties?.site_id) return [];
        const coordinates = centerOf(feature.geometry);
        return coordinates ? [{
          ...feature, geometry: { type: 'Point', coordinates },
          outline: feature.geometry.type === 'Point' ? undefined : feature.geometry,
        }] : [];
      }),
    };
    return { mode: 'live', sites: markers, scenarios: list };
  } catch (error) {
    if (signal.aborted || mode === 'live') throw error;
    return demo;
  }
}

export function getAgriculture(site: string, signal: AbortSignal): Promise<import('./types.ts').AgriculturalSurvey> {
  return request(`sites/${encodeURIComponent(site)}/agriculture`, signal);
}

export async function getLayer(site: string, layer: LayerId, mode: DataMode, signal: AbortSignal): Promise<Layer> {
  if (mode === 'demo' && site === demoSiteId) {
    if (layer === 'wapor') throw new Error('No satellite survey for the demonstration site.');
    return demoLayers[layer];
  }
  const path = `layers/${encodeURIComponent(site)}/${layer}`;
  const data = await request<Layer>(path, signal).catch((error) => {
    if (signal.aborted || !(error instanceof ApiError) || ![500, 502, 503, 504].includes(error.status)) throw error;
    return request<Layer>(path, signal);
  });
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw unreadable();
  return { ...data, features: data.features.filter((feature) => feature.geometry && feature.properties) };
}

export async function solarCompare(input: SolarRequest, mode: DataMode, signal: AbortSignal): Promise<SolarOption[]> {
  if (mode === 'demo') {
    return demoSolar.filter((option) => input.option_ids.includes(option.id)).map((option) => {
      const profile = option.profile_wh ?? [];
      const demand = profile.map((_, hour) => hour >= 7 && hour <= 19 ? 2500 : 0);
      const production = profile.reduce((sum, wh) => sum + wh, 0) / 1000;
      const used = profile.reduce((sum, wh, hour) => sum + Math.min(wh, demand[hour]), 0) / 1000;
      return {
        ...option, production_kwh: production, self_consumed_kwh: used, grid_avoided_kwh: used,
        autonomy_hours: 0, gross_savings_tnd: input.price_tnd_per_kwh === undefined ? null : used * input.price_tnd_per_kwh,
      };
    });
  }
  const response = await request<SolarOption[] | { options: SolarOption[] }>('solar/compare', signal, input);
  const options = Array.isArray(response) ? response : response.options;
  if (!Array.isArray(options)) throw unreadable();
  return options;
}

export async function archiveSolarCompare(input: SolarRequest, signal: AbortSignal): Promise<SolarOption[]> {
  const archive = await request<{ day: string; options: (SolarOption & { compass_azimuth_deg: number })[] }>('solar/compare-archive', signal, input);
  return archive.options.map((option) => ({ ...option, azimuth_deg: option.compass_azimuth_deg,
    period: archive.day + ' · PVGIS potential, simulated load', autonomy_hours: 0 }));
}

function isPlan(plan?: Plan) {
  return plan && ['OPTIMAL', 'FEASIBLE', 'NO_SOLUTION'].includes(plan.status)
    && (plan.actions === null || Array.isArray(plan.actions))
    && (plan.plot_results === null || Array.isArray(plan.plot_results)) && Array.isArray(plan.warnings);
}

export async function compare(input: CompareRequest, scenario: Scenario, mode: DataMode, signal: AbortSignal): Promise<Comparison> {
  if (mode === 'demo') return demoCompare(scenario, input);
  const result = await request<Comparison>('compare', signal, input);
  const weather = result.weather_comparison;
  if (!isPlan(result.baseline) || !isPlan(result.optimized)
    || (weather && (!isPlan(weather.reference_on_adverse) || !isPlan(weather.buffer_on_adverse)))) throw unreadable();
  return result;
}

export async function getEvidence(source: string, mode: DataMode, signal: AbortSignal): Promise<Evidence> {
  if (mode === 'demo' && demoEvidence[source]) return demoEvidence[source];
  const record = await request<Evidence & { titre?: string; organisme?: string; limite?: string }>(`evidence/${encodeURIComponent(source)}`, signal);
  return { ...record, title: record.title ?? record.titre ?? 'Reference source',
    organization: record.organization ?? record.organisme ?? '', limitation: record.limitation ?? record.limite ?? '' };
}

export function getPassages(source: string, signal: AbortSignal): Promise<Citation[]> {
  return request(`evidence/${encodeURIComponent(source)}/passages`, signal);
}

export function getAssistantHealth(signal: AbortSignal): Promise<AssistantHealth> {
  return request('assistant/health', signal, undefined, 12000);
}

export function askAssistant(body: AssistantRequest, signal: AbortSignal): Promise<AssistantAnswer> {
  return request('assistant/chat', signal, body, 50000);
}
