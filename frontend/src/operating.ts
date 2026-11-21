import type { CompareRequest, OperatingOverrides, Scenario } from './types.ts';

export interface OperatingInputs {
  pump: string;
  power: string;
  grid: string;
  solar: string;
  profile: '' | 'ombriere' | 'toiture';
  gravity: boolean;
  demand: Record<string, string>;
  event: 'none' | 'unexpected_outage' | 'pump_shutdown';
  start: number;
  duration: number;
}

export function defaultOperating(scenario: Scenario): OperatingInputs {
  const current = scenario.state.current_slot;
  const start = scenario.slots.find((s) => s.slot > current && s.grid_available)?.slot ?? current;
  return { pump: '', power: '', grid: '', solar: '100', profile: '', gravity: true, demand: {}, event: 'none', start, duration: 1 };
}

export function parseOperating(inputs: OperatingInputs, scenario: Scenario, weather: boolean, outages: number[]) {
  const errors: Record<string, string> = {};
  const overrides: OperatingOverrides = {};
  const number = (key: string, text: string, min = 0, max = 1_000_000_000) => {
    const value = Number(text);
    if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || value < min || value > max) {
      errors[key] = `Enter a whole number from ${min} to ${max}.`;
    }
    return value;
  };
  if (inputs.pump !== '') overrides.pump_max_m3_per_slot = number('overrides.pump_max_m3_per_slot', inputs.pump);
  if (inputs.power !== '') overrides.pump_power_cap_w = number('overrides.pump_power_cap_w', inputs.power);
  if (inputs.grid !== '') overrides.grid_cap_w = number('overrides.grid_cap_w', inputs.grid);
  if (inputs.solar !== '100') overrides.solar_percent = number('overrides.solar_percent', inputs.solar, 0, 100);
  if (inputs.profile && !weather) overrides.pvgis_option_id = inputs.profile;
  if (!inputs.gravity) overrides.gravity_available = false;
  for (const plot of scenario.plots) {
    const raw = inputs.demand[plot.plot_id];
    if (!raw) continue;
    const minimum = Math.max(plot.minimum_m3, scenario.state.delivered_by_plot_m3[plot.plot_id] ?? 0);
    (overrides.demand_by_plot_m3 ??= {})[plot.plot_id] = number(`overrides.demand_by_plot_m3.${plot.plot_id}`, raw, minimum);
  }
  const fields: Pick<CompareRequest, 'incident' | 'overrides'> = {};
  if (Object.keys(overrides).length) fields.overrides = overrides;
  if (inputs.event !== 'none' && !weather) {
    if (inputs.event === 'unexpected_outage' && outages.includes(inputs.start)) {
      errors.incident = 'Start an unexpected outage during an hour with grid supply.';
    }
    if (inputs.start < scenario.state.current_slot || inputs.start + inputs.duration > scenario.slots.length || inputs.duration < 1) {
      errors.incident = 'Choose an incident within the remaining simulation hours.';
    }
    fields.incident = { kind: inputs.event, start_slot: inputs.start, duration_slots: inputs.duration };
  }
  return { fields, errors };
}
