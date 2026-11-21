import type { CompareRequest, Plan, RegionPlanRequest } from './types.ts';

export type StressPlan = CompareRequest | RegionPlanRequest;
export type ShareRule = 'fixed' | 'fair' | 'urgent';
export type ReserveStatus = 'minimum' | 'unreachable' | 'unknown' | 'no_target';
export type Fault = 'physical_loss' | 'meter_error';

export interface OutageCell {
  start: number;
  duration: number;
  status: Plan['status'];
  coverage_bp: number | null;
  deficit_m3: number | null;
  reserve_m3: number | null;
  reserve_status: ReserveStatus;
}

export function coverageEvidence(cell: OutageCell, targetPercent: number) {
  if (cell.reserve_status === 'no_target') return 'no_target';
  if (cell.reserve_status === 'minimum') return 'reachable';
  if (cell.reserve_status === 'unreachable') return 'unreachable';
  if (cell.status === 'NO_SOLUTION' || cell.coverage_bp == null) return 'unknown';
  if (cell.coverage_bp >= targetPercent * 100) return 'reachable';
  return cell.status === 'OPTIMAL' ? 'unreachable' : 'unknown';
}

export function durationEvidence(cells: OutageCell[], targetPercent: number) {
  const passing: number[] = [], unresolved: number[] = [];
  let comparable = false;
  for (const cell of cells) {
    const proof = coverageEvidence(cell, targetPercent);
    if (proof === 'no_target') continue;
    comparable = true;
    if (proof === 'reachable') passing.push(cell.duration);
    if (proof === 'unknown') unresolved.push(cell.duration);
  }
  passing.sort((a,b) => a-b);
  unresolved.sort((a,b) => a-b);
  const longest = passing.at(-1);
  const ambiguous = unresolved.some(duration => longest == null || duration > longest);
  return { comparable, passing, unresolved, longest, ambiguous };
}
export interface OutageGrid {
  starts: number[];
  durations: number[];
  target_percent: number;
  cells: OutageCell[];
}
export interface CaseSettings {
  urgent_plot_id?: string;
  loss_m3: number;
  heat_percent: number;
  extra_tank_m3: number;
  backup_w: number;
}
export interface HeatDay {
  day: number;
  initial_stock_m3: number | null;
  initial_quota_m3: number | null;
  end_stock_m3: number | null;
  end_quota_m3: number | null;
  deficit_m3: number | null;
  status: Plan['status'];
  plan: Plan | null;
}
export interface OutageCase {
  site_id: string;
  start: number;
  duration: number;
  target_percent: number;
  urgent_plot_id: string;
  plots: { plot_id: string; demand_m3: number; minimum_m3: number; deadline_slot: number }[];
  rules: Record<ShareRule, Plan>;
  reserve_m3: number | null;
  reserve_status: ReserveStatus;
  without_prefill: Plan;
  upgrades: { id: 'current' | 'larger_tank' | 'backup'; plan: Plan; backup_wh: number | null }[];
  heat_days: HeatDay[];
  heat_reserved_days: HeatDay[];
  incidents: { kind: Fault; plan: Plan; readings: { slot: number; physical_stock_m3: number;
    reported_stock_m3: number; physical_loss_m3: number }[] }[];
  outage_slots: number[];
}

export function unmetMinimum(plan: Plan) {
  if (!plan.plot_results || plan.plot_results.some(plot => plot.minimum_m3 == null)) return null;
  return plan.plot_results.reduce((sum, plot) => sum + Math.max(0, plot.minimum_m3! - plot.delivered_on_time_m3), 0);
}
