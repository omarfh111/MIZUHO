import type { FeatureCollection, Geometry, Position } from 'geojson';
import { demoEvidence, demoLayers, demoScenarios, demoSiteId, demoSites, demoSolar } from './demo/catalog.ts';
import { demoCompare } from './demo/planner.ts';
import type { CompareRequest, Comparison, Evidence, Layer, LayerId, Plan, Scenario, SiteProperties, Sites, SolarOption, SolarRequest } from './types.ts';

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

async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError('Service indisponible. Vérifiez la connexion à l’API.', 503);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 422) {
    throw new ApiError('Vérifiez les paramètres avant de relancer le calcul.', 422, validationFields(payload));
  }
  if (!response.ok || payload === null) {
    throw new ApiError('Service indisponible. Réessayez dans un instant.', response.ok ? 503 : response.status);
  }
  return payload as T;
}

function unreadable() {
  return new ApiError('La réponse de l’API est illisible.', 502);
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

export async function getLayer(site: string, layer: LayerId, mode: DataMode, signal: AbortSignal): Promise<Layer> {
  if (mode === 'demo' && site === demoSiteId) return demoLayers[layer];
  const data = await request<Layer>(`layers/${encodeURIComponent(site)}/${layer}`, signal);
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
  return { ...record, title: record.title ?? record.titre ?? 'Source documentaire',
    organization: record.organization ?? record.organisme ?? '', limitation: record.limitation ?? record.limite ?? '' };
}
