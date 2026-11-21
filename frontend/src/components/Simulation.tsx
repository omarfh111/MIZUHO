import {
  BadgeCheck, CalendarClock, CircleAlert, CloudSun, Droplets, Gauge, Play, Radio, RotateCcw, Settings2, Sun, TriangleAlert, Zap,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, compare, type DataMode, type FieldErrors } from '../api.ts';
import { hour, percent, value } from '../format.ts';
import type { AssistantSimulationContext, CompareRequest, Comparison, Plan, Scenario, SolarOption } from '../types.ts';
import Planning from './Planning.tsx';

interface Inputs {
  scenarioId: string;
  stock: string;
  quota: string;
  restartCap: string;
  outages: number[];
  weather: boolean;
}

interface Calculated {
  revision: number;
  request: CompareRequest;
  scenario: Scenario;
  comparison: Comparison;
}

const storageKey = 'mizu-m7-validation';

function initialInputs(scenario: Scenario): Inputs {
  return {
    scenarioId: scenario.id, stock: String(scenario.state.tank_stock_m3),
    quota: String(scenario.state.quota_remaining_m3), restartCap: '3',
    outages: scenario.slots.filter(({ grid_available }) => !grid_available).map(({ slot }) => slot),
    weather: Boolean(scenario.weather_pair_id),
  };
}

function Field({ id, label, unit, input, error, change }: {
  id: string; label: string; unit: string; input: string; error?: string; change: (input: string) => void;
}) {
  return <label className="field" htmlFor={id}>
    <span>{label}</span>
    <span className="unit-input">
      <input type="text" inputMode={unit === 'kW' ? 'decimal' : 'numeric'} id={id} value={input}
        onChange={(event) => change(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
      <span>{unit}</span>
    </span>
    {error && <small className="field-error" id={`${id}-error`}>{error}</small>}
  </label>;
}

function readDecimal(input: string) {
  const normalized = input.trim().replace(',', '.');
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}

function parseInputs(inputs: Inputs, scenario: Scenario, solar: SolarOption | null) {
  const errors: FieldErrors = {};
  const stock = readDecimal(inputs.stock);
  const quota = readDecimal(inputs.quota);
  const rawCap = readDecimal(inputs.restartCap) * 1000;
  const cap = Math.round(rawCap);
  if (!Number.isSafeInteger(stock) || stock < 0 || stock > scenario.site.tank_capacity_m3) {
    errors['state.tank_stock_m3'] = `Enter a whole number between 0 and ${scenario.site.tank_capacity_m3}.`;
  }
  if (!Number.isSafeInteger(quota) || quota < 0) errors['state.quota_remaining_m3'] = 'Enter a whole number of zero or greater.';
  if (inputs.restartCap.trim() !== '' && (!Number.isSafeInteger(cap) || cap < 0 || Math.abs(rawCap - cap) > 1e-8)) {
    errors.restart_grid_cap_w = 'Enter a nonnegative power to the nearest watt.';
  }
  const request: CompareRequest = {
    scenario_id: scenario.id,
    state: { ...scenario.state, tank_stock_m3: stock, quota_remaining_m3: quota },
    outage_slots: [...inputs.outages].sort((a, b) => a - b),
    solar_option_id: solar?.id ?? null,
    restart_grid_cap_w: inputs.restartCap.trim() ? cap : undefined,
    planning_mode: inputs.weather ? 'weather_buffer' : 'nominal',
    weather_pair_id: inputs.weather ? scenario.weather_pair_id : undefined,
  };
  return { request, errors };
}

function statusText(calculated: Calculated, mode: DataMode) {
  if (calculated.request.planning_mode === 'weather_buffer' && !calculated.comparison.weather_comparison) {
    return 'Insufficient data for the weather reserve plan';
  }
  const proposed = calculated.comparison.weather_comparison?.buffer_on_adverse ?? calculated.comparison.optimized;
  if (proposed.status === 'NO_SOLUTION' || !proposed.metrics || !proposed.actions) return 'Calculation interrupted · fixed schedule available';
  if (mode === 'live' && proposed.status === 'FEASIBLE') return 'Calculation interrupted · feasible plan available';
  if ((proposed.metrics.worst_coverage_bp ?? 10000) < 10000) return 'Partial plan · minimum targets unmet';
  return mode === 'demo' ? 'Simulated plan available' : 'Plan ready';
}

interface Validation {
  time: string;
  request: CompareRequest;
  actions: Plan['actions'];
}

function saveValidation(entry: Validation | null) {
  try {
    if (entry) sessionStorage.setItem(storageKey, JSON.stringify(entry));
    else sessionStorage.removeItem(storageKey);
  } catch { /* The active session still retains its in-memory timestamp. */ }
}

function readValidation(request: CompareRequest, actions: Plan['actions']) {
  try {
    const entry = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Validation | null;
    return entry && JSON.stringify(entry.request) === JSON.stringify(request) && JSON.stringify(entry.actions) === JSON.stringify(actions)
      ? entry.time : null;
  } catch { return null; }
}

interface Props {
  onAssistantContext?: (simulation: AssistantSimulationContext | undefined) => void;
  scenarios: Scenario[];
  mode: DataMode;
  solar: SolarOption | null;
  onClearSolar: () => void;
  onEvidence: (source: string) => void;
}

export default function Simulation({ scenarios, mode, solar, onClearSolar, onEvidence, onAssistantContext }: Props) {
  const [inputs, setInputs] = useState(() => initialInputs(scenarios[0]));
  const [calculated, setCalculated] = useState<Calculated | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [validation, setValidation] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const initialSolar = useRef(solar?.id);
  const scenario = scenarios.find(({ id }) => id === inputs.scenarioId) ?? scenarios[0];

  useEffect(() => () => inFlight.current?.abort(), []);

  const invalidate = () => {
    inFlight.current?.abort();
    setLoading(false);
    setRevision((version) => version + 1);
    setError('');
    setErrors({});
    setValidation(null);
    saveValidation(null);
  };

  useEffect(() => {
    if (initialSolar.current === solar?.id) return;
    initialSolar.current = solar?.id;
    invalidate();
  }, [solar?.id]);

  const update = (change: Partial<Inputs>) => {
    setInputs((previous) => ({ ...previous, ...change }));
    invalidate();
  };
  const current = calculated?.revision === revision && calculated?.request.solar_option_id === (solar?.id ?? null) && !loading && !error;
  const stale = Boolean(calculated && !current);
  const displayed = calculated?.comparison.weather_comparison?.buffer_on_adverse ?? calculated?.comparison.optimized;
  const missingWeather = calculated?.request.planning_mode === 'weather_buffer' && !calculated.comparison.weather_comparison;
  const assistantContext = current && displayed?.metrics && !missingWeather ? calculated.request : undefined;
  const assistantPending = !assistantContext && (revision > 0 || loading || Boolean(error));
  useEffect(() => {
    onAssistantContext?.({
      scenarioId: scenario.id, revision, pending: assistantPending, comparison: assistantContext,
    });
    return () => onAssistantContext?.(undefined);
  }, [assistantContext, assistantPending, onAssistantContext, revision, scenario.id]);
  const canValidate = current && !missingWeather && displayed?.status !== 'NO_SOLUTION' && Boolean(displayed?.actions && displayed.metrics);
  const reset = () => { invalidate(); setInputs(initialInputs(scenario)); };
  const toggle = (slot: number) => update({ outages: inputs.outages.includes(slot)
    ? inputs.outages.filter((entry) => entry !== slot) : [...inputs.outages, slot] });
  const fieldError = (...keys: string[]) => Object.entries(errors).find(([field]) =>
    keys.some((key) => field === key || field.startsWith(`${key}.`)))?.[1];
  const run = async () => {
    setError('');
    setValidation(null);
    const { request, errors } = parseInputs(inputs, scenario, solar);
    setErrors(errors);
    if (Object.keys(errors).length) {
      setError('Correct the highlighted inputs.');
      return;
    }
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    try {
      const result = await compare(request, scenario, mode, controller.signal);
      if (controller.signal.aborted) return;
      setCalculated({ scenario, request, revision, comparison: result });
      setValidation(readValidation(request, (result.weather_comparison?.buffer_on_adverse ?? result.optimized).actions));
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : 'Service unavailable.');
      if (failure instanceof ApiError) setErrors(failure.fields);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const validate = () => {
    if (!canValidate || !calculated || !displayed) return;
    const time = new Date().toISOString();
    setValidation(time);
    saveValidation({ time, request: calculated.request, actions: displayed.actions });
  };
  const before = calculated?.comparison.weather_comparison?.reference_on_adverse ?? calculated?.comparison.baseline;
  const delta = displayed?.metrics?.worst_coverage_bp != null && before?.metrics?.worst_coverage_bp != null
    ? (displayed.metrics.worst_coverage_bp - before.metrics.worst_coverage_bp) / 100 : null;
  let outcome: ReactNode = 'Enter the site conditions and calculate the schedules.';
  if (loading) outcome = 'Calculating…';
  else if (error) outcome = error;
  else if (stale) outcome = 'Result out of date · recalculate to continue.';
  else if (calculated) outcome = statusText(calculated, mode);

  return <>
    <form className="surface simulation-controls" noValidate onSubmit={(event) => { event.preventDefault(); void run(); }}>
      <div className="panel-heading">
        <div className="title-with-icon"><div className="section-icon"><Settings2 size={18} /></div><div>
          <h2>Scenario settings</h2><p className="muted small">{scenario.description ?? 'Site conditions at the start of the calculation'}
            {mode === 'live' && scenario.provenance === 'simulated' && ' · Simulated data'}</p>
        </div></div>
        <button type="button" className="text-button" onClick={reset}><RotateCcw size={15} /> Reset</button>
      </div>
      <div className="simulation-fields">
        <label className="field"><span>Scenario</span>
          <select value={scenario.id} onChange={(event) => {
            const selected = scenarios.find(({ id }) => id === event.target.value);
            if (selected) { invalidate(); setInputs(initialInputs(selected)); }
          }}>{scenarios.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}</select>
          {fieldError('scenario_id') && <small className="field-error">{fieldError('scenario_id')}</small>}
        </label>
        <Field id="tank-stock" label="Measured water stock" unit="m³" input={inputs.stock}
          error={fieldError('state.tank_stock_m3')} change={(stock) => update({ stock })} />
        <Field id="remaining-quota" label="Remaining quota" unit="m³" input={inputs.quota}
          error={fieldError('state.quota_remaining_m3')} change={(quota) => update({ quota })} />
        <Field id="restart-cap" label="Restart power cap" unit="kW" input={inputs.restartCap}
          error={fieldError('restart_grid_cap_w')} change={(restartCap) => update({ restartCap })} />
      </div>
      <div className="outage-block">
        <div className="outage-heading"><span><Radio size={16} /> Outage hours</span>
          <small>Calculation starts · {hour(scenario.state.current_slot)}</small>
        </div>
        <div className="outage-buttons" aria-label="Outage hours">
          {scenario.slots.map(({ slot }) => <button type="button" key={slot} className="hour-toggle"
            disabled={slot < scenario.state.current_slot} aria-pressed={inputs.outages.includes(slot)}
            aria-label={`${hour(slot)} · outage`} onClick={() => toggle(slot)}>
            {inputs.outages.includes(slot) && <TriangleAlert size={12} />} {hour(slot)}
          </button>)}
        </div>
        {fieldError('outage_slots') && <p className="field-error">{fieldError('outage_slots')}</p>}
      </div>
      <div className="simulation-actions">
        <div className="simulation-options">
          <span className="selection-chip"><Sun size={15} /> {inputs.weather
            ? 'Scenario weather profiles' : solar?.label ?? 'No solar option selected'}
            {solar && <button type="button" className="text-button" onClick={onClearSolar}>Remove</button>}
          </span>
          {fieldError('solar_option_id') && <small className="field-error">{fieldError('solar_option_id')}</small>}
          {scenario.weather_pair_id && <label className="weather-toggle"><input type="checkbox" checked={inputs.weather}
            onChange={(event) => update({ weather: event.target.checked })} /><CloudSun size={15} /> Day-ahead weather reserve</label>}
          {fieldError('weather_pair_id', 'planning_mode', 'state.current_slot') &&
            <small className="field-error">{fieldError('weather_pair_id', 'planning_mode', 'state.current_slot')}</small>}
        </div>
        <button type="submit" className="button button-primary" disabled={loading}><Play size={16} /> {calculated ? 'Recalculate' : 'Calculate schedules'}</button>
      </div>
    </form>
    <div className={`result-status ${error || stale ? 'attention' : ''}`} role={error ? 'alert' : 'status'}>
      {error || stale ? <CircleAlert size={18} /> : loading ? <Gauge className="loading-icon" size={18} /> : <CalendarClock size={18} />}
      <strong>{outcome}</strong>
      {calculated && stale && <span>Previous result · {calculated.scenario.label}</span>}
      {calculated && current && delta != null && <span>{delta >= 0 ? '+' : '−'}{value(Math.abs(delta))} pts minimum coverage · {percent(displayed?.metrics?.worst_coverage_bp)}</span>}
    </div>
    {calculated && <>
      <Planning key={`${calculated.scenario.id}-${calculated.revision}`} comparison={calculated.comparison}
        scenario={calculated.scenario} input={calculated.request} stale={stale} onEvidence={onEvidence} />
      <section className="surface validation-panel">
        <div className="title-with-icon"><div className="section-icon"><BadgeCheck size={19} /></div><div>
          <h2>Irrigation decision</h2>
          <p className="muted small">{current && validation
            ? `Simulated plan approved at ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Tunis', timeStyle: 'medium' }).format(new Date(validation))} · Tunis time`
            : 'Save the approval for this session.'}</p>
        </div></div>
        <button type="button" className="button button-primary" onClick={validate} disabled={!canValidate || Boolean(validation)}>
          <BadgeCheck size={17} /> {current && validation ? 'Plan approved' : 'Approve simulated plan'}
        </button>
      </section>
    </>}
    {!calculated && <section className="simulation-empty surface">
      <div><Droplets size={22} /><Zap size={16} /></div>
      <h2>Fixed schedule and proposed plan</h2>
      <p>The schedules show hourly deliveries, grower coverage and energy use.</p>
    </section>}
  </>;
}
