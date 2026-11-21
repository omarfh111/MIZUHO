import type { Provenance } from './types.ts';

const formatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const kiloFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 });
export const value = (amount: number | null | undefined) => amount == null ? '—' : formatter.format(amount);
export const hour = (slot: number) => `H${String(slot).padStart(2, '0')}`;
export const clockHour = (slot: number) => `${String(slot).padStart(2, '0')}:00`;
export const percent = (basisPoints: number | null | undefined) => basisPoints == null ? '—' : `${value(basisPoints / 100)} %`;
export const kilo = (amount: number | null | undefined) => amount == null ? '—' : kiloFormatter.format(amount / 1000);
export const provenanceLabel: Record<Provenance, string> = {
  simulated: 'Simulated', observed: 'Observed', estimated: 'Estimated', unavailable: 'Unavailable',
};

export function dateLabel(date?: string | null) {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return date ?? 'Date unavailable';
  const parsed = new Date(date);
  return Number.isNaN(parsed.valueOf()) ? date
    : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(parsed);
}
