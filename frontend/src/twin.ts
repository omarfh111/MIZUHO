import type { Action, CompareRequest, Provenance } from './types.ts';

export interface ReplaySelection {
  plan: 'baseline' | 'optimized';
  weather_profile: 'central' | 'adverse';
  actions: Pick<Action, 'slot' | 'pump_m3' | 'deliveries'>[];
  missing_flow_slots: number[];
  balance_anomaly_slots: number[];
}

export type ReplayContext = ReplaySelection & { selected_slot: number };
export interface TwinFrame {
  slot: number;
  timestamp: string;
  tank_stock_m3: number;
  tank_capacity_m3: number;
  quota_remaining_m3: number;
  pump_m3: number;
  delivered_m3: number;
  grid_available: boolean;
  grid_wh: number;
  solar_potential_wh: number;
  solar_wh: number;
  pump_wh: number;
  parcels: { plot_id: string; farmer_id: string; delivered_m3: number; minimum_m3: number;
    delivered_on_time_m3: number; demand_m3: number; coverage_bp: number | null }[];
}
export interface Measurement {
  sensor_id: string; simulation_slot: number; timestamp: string; equipment_id: string;
  metric: string; value: number | boolean | null; unit: string; quality: string; source: string;
}
export interface TwinEvent {
  simulation_slot: number; timestamp: string; equipment_id: string; type: string;
  message: string; unit: string; value: number | boolean | null; provenance: Provenance;
}
export interface Replay {
  frames: TwinFrame[]; measurements: Measurement[]; events: TwinEvent[]; alerts: TwinEvent[];
}
export type ReplayBody = ReplaySelection & { comparison: CompareRequest };
