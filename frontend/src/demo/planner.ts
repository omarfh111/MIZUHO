import type {
  Action, CompareRequest, Comparison, Delivery, Plan, Plot, PlotResult, Scenario, Slot, Warning,
} from '../types.ts';
import { demoSolar } from './catalog.ts';

type Strategy = (context: {
  slot: Slot; pumpLimit: number; stock: number; delivered: Record<string, number>;
  onTime: Record<string, number>;
}) => { pump: number; delivery?: Delivery };

const get = (amounts: Record<string, number>, id: string) => amounts[id] ?? 0;
const coverage = (onTime: number, minimum: number) => minimum > 0
  ? Math.min(10000, Math.floor(onTime * 10000 / minimum)) : null;

function operatingSlots(scenario: Scenario, request: CompareRequest): Slot[] {
  const outages = new Set(request.outage_slots);
  const profile = demoSolar.find(({ id }) => id === request.solar_option_id)?.profile_wh;

  return scenario.slots.map((slot) => {
    const restarting = outages.has(slot.slot - 1);
    return {
      ...slot,
      grid_available: !outages.has(slot.slot),
      grid_cap_w: restarting && request.restart_grid_cap_w !== undefined
        ? Math.min(slot.grid_cap_w, request.restart_grid_cap_w) : slot.grid_cap_w,
      solar_wh: scenario.weather_pair_id ? slot.solar_wh : profile?.[slot.slot] ?? slot.solar_wh,
    };
  });
}

function replay(scenario: Scenario, request: CompareRequest, slots: Slot[], strategy: Strategy): Plan {
  const { site, plots } = scenario;
  const delivered = { ...request.state.delivered_by_plot_m3 };
  const onTime = { ...request.state.delivered_on_time_by_plot_m3 };
  let stock = request.state.tank_stock_m3;
  let quota = request.state.quota_remaining_m3;
  let withdrawn = 0;
  let grid = 0;
  let peak = 0;
  const actions: Action[] = [];

  for (const slot of slots.filter(({ slot }) => slot >= request.state.current_slot)) {
    const pumpLimit = slot.grid_available ? Math.min(
      site.pump_max_m3_per_slot, quota, site.tank_capacity_m3 - stock,
      Math.floor((slot.solar_wh + slot.grid_cap_w) / site.pump_wh_per_m3),
    ) : 0;
    const { pump, delivery } = strategy({ slot, stock, delivered, onTime, pumpLimit });
    const pumped = Math.max(0, Math.min(pumpLimit, pump));
    const gridWh = Math.max(0, pumped * site.pump_wh_per_m3 - slot.solar_wh);
    stock += pumped;
    quota -= pumped;
    withdrawn += pumped;
    grid += gridWh;
    peak = Math.max(peak, gridWh);

    const deliveries: Delivery[] = [];
    const plot = plots.find((plot) => plot.plot_id === delivery?.plot_id && plot.allowed_slots.includes(slot.slot));
    if (delivery && plot) {
      const id = plot.plot_id;
      const volume = Math.max(0, Math.min(delivery.delivered_m3, stock, site.gravity_max_m3_per_slot,
        plot.demand_m3 - get(delivered, id)));
      if (volume > 0) {
        stock -= volume;
        delivered[id] = get(delivered, id) + volume;
        if (slot.slot <= plot.deadline_slot) onTime[id] = get(onTime, id) + volume;
        deliveries.push({ plot_id: id, delivered_m3: volume });
      }
    }
    actions.push({ slot: slot.slot, pump_m3: pumped, deliveries, tank_stock_m3: stock,
      quota_remaining_m3: quota, grid_wh: gridWh });
  }
  const plotResults: PlotResult[] = plots.map((plot) => {
    const amount = get(onTime, plot.plot_id);
    return {
      plot_id: plot.plot_id, farmer_id: plot.farmer_id, demand_m3: plot.demand_m3, minimum_m3: plot.minimum_m3,
      delivered_m3: get(delivered, plot.plot_id), delivered_on_time_m3: amount, coverage_bp: coverage(amount, plot.minimum_m3),
      reason: amount >= plot.minimum_m3 ? undefined : site.gravity_max_m3_per_slot === 0
        ? 'Distribution gravitaire indisponible' : quota === 0 ? 'Quota épuisé au cours du plan'
          : 'Minimum non couvert dans la fenêtre autorisée',
    };
  });
  const fractions = plotResults.flatMap(({ coverage_bp }) => coverage_bp == null ? [] : [coverage_bp]);
  const warnings: Warning[] = scenario.id === 'successive' ? [{
    type: 'efficiency', message: 'Vérifier le débit, la pression et le compteur de la pompe.',
    period: 'H09–H10 · relevés indépendants simulés', value: 0.7, reference: 0.5,
    unit: 'kWh/m³', source_id: 'telemetry',
  }] : [{ type: 'insufficient', message: 'Données insuffisantes pour établir le diagnostic kWh/m³.' }];

  return {
    status: 'FEASIBLE', actions, plot_results: plotResults, warnings,
    metrics: {
      withdrawn_m3: withdrawn, delivered_m3: plotResults.reduce((sum, plot) => sum + plot.delivered_m3, 0),
      delivered_on_time_m3: plotResults.reduce((sum, plot) => sum + plot.delivered_on_time_m3, 0),
      grid_wh: grid, pump_wh: withdrawn * site.pump_wh_per_m3, peak_grid_w: peak,
      worst_coverage_bp: fractions.length ? Math.min(...fractions) : null,
      tank_stock_m3: stock, quota_remaining_m3: quota,
    },
  };
}

function compareNominal(scenario: Scenario, request: CompareRequest, slots: Slot[]): Comparison {
  const baseline = replay(scenario, request, slots, ({ slot }) => ({
    pump: scenario.fixed_pump_m3?.[slot.slot] ?? 0,
    delivery: scenario.fixed_deliveries?.[slot.slot]?.[0],
  }));
  const feasiblePlans = [baseline];
  // Replay a small ladder of coverage targets. This demo produces feasible examples for arbitrary inputs.
  for (let target = 100; target >= 0; target -= 5) {
    feasiblePlans.push(replay(scenario, request, slots, ({ slot, delivered, onTime, stock, pumpLimit }) => {
      const need = (plot: Plot) => Math.max(0, Math.ceil(plot.minimum_m3 * target / 100) - get(onTime, plot.plot_id));
      const available = scenario.plots.filter((plot) => plot.allowed_slots.includes(slot.slot)
        && get(delivered, plot.plot_id) < plot.demand_m3);
      const priority = (plot: Plot) => slot.slot <= plot.deadline_slot && need(plot) > 0;
      available.sort((a, b) => Number(priority(b)) - Number(priority(a))
        || a.deadline_slot - b.deadline_slot || b.past_deferrals - a.past_deferrals);
      const plot = available[0];
      const nextOutage = slots.find((entry) => entry.slot === slot.slot + 1 && !entry.grid_available);
      let reserve = 0;
      if (nextOutage && slot.grid_available) {
        const nextReturn = slots.find((entry) => entry.slot > slot.slot && entry.grid_available)?.slot ?? Infinity;
        reserve = scenario.plots.filter((entry) => entry.allowed_slots.some((time) =>
          time > slot.slot && time < nextReturn && time <= entry.deadline_slot))
          .reduce((sum, entry) => sum + need(entry), 0);
      }
      const remaining = plot ? plot.demand_m3 - get(delivered, plot.plot_id) : 0;
      const competing = scenario.plots.some((entry) => entry !== plot && entry.deadline_slot >= slot.slot && need(entry) > 0);
      const desired = plot && target < 100 && competing && (priority(plot) || !slot.grid_available)
        ? (priority(plot) ? Math.min(remaining, need(plot)) : 0) : remaining;
      const delivery = Math.min(desired, scenario.site.gravity_max_m3_per_slot);
      const pump = Math.min(pumpLimit, Math.max(0, delivery + reserve - stock));
      return { pump, delivery: plot ? { plot_id: plot.plot_id, delivered_m3: delivery } : undefined };
    }));
  }
  const score = (plan: Plan) => {
    const metrics = plan.metrics!;
    const deficits = (plan.plot_results ?? []).reduce((sum, result, index) => sum
      + Math.max(0, (result.minimum_m3 ?? 0) - result.delivered_on_time_m3) * (1 + scenario.plots[index].past_deferrals), 0);
    return [metrics.worst_coverage_bp ?? 0, -deficits, metrics.delivered_m3,
      -metrics.peak_grid_w, -metrics.grid_wh, -metrics.withdrawn_m3];
  };
  feasiblePlans.sort((a, b) => {
    const right = score(b);
    return score(a).map((value, index) => right[index] - value).find((difference) => difference !== 0) ?? 0;
  });
  return { baseline, optimized: feasiblePlans[0] };
}

function compareWeather(scenario: Scenario, request: CompareRequest, slots: Slot[]): Comparison {
  const before = 11;
  const plot = scenario.plots[0];
  const riskSlot = plot.allowed_slots[0];
  const adverse = slots.map((slot) => slot.slot === riskSlot && request.weather_pair_id === 'jplus1-demo'
    ? { ...slot, solar_wh: 2500 } : slot);
  const plan = (early: number) => replay(scenario, request, adverse, ({ slot, stock, delivered }) => {
    if (slot.slot === before - 1) return { pump: early };
    if (slot.slot !== riskSlot) return { pump: 0 };
    const remaining = Math.max(0, plot.demand_m3 - get(delivered, plot.plot_id));
    return { pump: Math.max(0, remaining - stock), delivery: { plot_id: plot.plot_id, delivered_m3: remaining } };
  });
  const reference = plan(0);
  const maxEarly = Math.floor((slots.find(({ slot }) => slot === before - 1)?.solar_wh ?? 0) / scenario.site.pump_wh_per_m3);
  let best = reference;
  let earlyPump = 0;
  for (let early = 1; early <= maxEarly; early++) {
    const candidate = plan(early);
    if ((candidate.metrics?.delivered_on_time_m3 ?? 0) > (best.metrics?.delivered_on_time_m3 ?? 0)) {
      best = candidate;
      earlyPump = candidate.actions?.find(({ slot }) => slot === before - 1)?.pump_m3 ?? 0;
    }
  }
  return {
    baseline: reference, optimized: best,
    weather_comparison: {
      reference_on_adverse: reference, buffer_on_adverse: best, early_pump_m3: earlyPump, before_slot: before,
      expected_stock_m3: best.actions?.find(({ slot }) => slot === before - 1)?.tank_stock_m3 ?? request.state.tank_stock_m3,
      remaining_deficit_m3: Math.max(0, plot.minimum_m3 - (best.plot_results?.[0].delivered_on_time_m3 ?? 0)),
      quota_remaining_m3: best.metrics?.quota_remaining_m3,
      reason: request.weather_pair_id === 'jplus1-demo'
        ? 'Le profil défavorable réduit la production solaire après 11 h.'
        : 'Les deux profils permettent le même pompage sur la fenêtre à risque.',
      source_id: 'weather', provenance: 'simulated',
    },
  };
}

export function demoCompare(scenario: Scenario, request: CompareRequest): Comparison {
  const slots = operatingSlots(scenario, request);
  return request.planning_mode === 'weather_buffer' && scenario.weather_pair_id
    ? compareWeather(scenario, request, slots) : compareNominal(scenario, request, slots);
}
