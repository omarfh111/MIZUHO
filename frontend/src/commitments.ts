import type { Plan, Plot } from './types.ts';

export type CommitmentPlot = Pick<Plot, 'plot_id' | 'deadline_slot' | 'allowed_slots'>;

export function parcelCommitments(plots: CommitmentPlot[], plan: Plan, fromSlot: number) {
  if (plan.status === 'NO_SOLUTION' || !plan.plot_results) return null;
  return plots.map(plot => {
    const result = plan.plot_results?.find(row => row.plot_id === plot.plot_id);
    const minimum = result?.minimum_m3;
    const timely = result?.delivered_on_time_m3;
    const eligible = plot.allowed_slots.filter(slot => slot <= plot.deadline_slot);
    const shortfall = minimum == null || timely == null ? null : Math.max(0, minimum - timely);
    const remaining = plan.actions?.filter(action => action.slot >= fromSlot).flatMap(action =>
      action.deliveries.filter(d => d.plot_id === plot.plot_id && d.delivered_m3 > 0)
        .map(d => ({ slot: action.slot, volume: d.delivered_m3 })));
    return { id: plot.plot_id, deadline: plot.deadline_slot, lastEligible: eligible.length ? Math.max(...eligible) : null,
      minimum, timely, shortfall, remaining };
  }).sort((a, b) => (a.lastEligible ?? a.deadline) - (b.lastEligible ?? b.deadline) || a.id.localeCompare(b.id));
}
