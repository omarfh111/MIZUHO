import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, estimateRegionalDemand } from '../api.ts';
import { value } from '../format.ts';
import type { RegionalDemandBasis, RegionalDemandEstimate, RegionalWaterWeather, RegionSector } from '../types.ts';

type BasisKey = Exclude<keyof RegionalDemandBasis, 'date'>;
type Draft = Partial<Record<BasisKey, string>>;
const fields: { key: BasisKey; label: string; max: number }[] = [
  { key: 'area_m2', label: 'Irrigated area (m²)', max: 1e7 },
  { key: 'crop_coefficient', label: 'Crop coefficient (Kc)', max: 3 },
  { key: 'effective_rain_fraction', label: 'Effective share of rainfall (0–1)', max: 1 },
  { key: 'application_efficiency', label: 'Application efficiency (0–1)', max: 1 },
];

interface Props {
  siteId: string;
  date: string;
  weather: RegionalWaterWeather;
  applied: Partial<Record<RegionSector, RegionalDemandBasis>>;
  onApply: (sector: RegionSector, volume: number, basis: RegionalDemandBasis) => void;
  onDiscard: (sector: RegionSector) => void;
}

export default function RegionalDemandEstimator({ siteId, date, weather, applied, onApply, onDiscard }: Props) {
  const [sector, selectSector] = useState<RegionSector>('west');
  const [drafts, setDrafts] = useState<{ west: Draft; east: Draft }>({ west: {}, east: {} });
  const [preview, setPreview] = useState<{ result: RegionalDemandEstimate; basis: RegionalDemandBasis }>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  function clearPreview() {
    active.current?.abort();
    setPending(false);
    setPreview(undefined);
    setMessage('');
  }

  async function estimate(event: FormEvent) {
    event.preventDefault();
    clearPreview();
    const draft = drafts[sector];
    const basis = { date, area_m2: Number(draft.area_m2), crop_coefficient: Number(draft.crop_coefficient),
      effective_rain_fraction: Number(draft.effective_rain_fraction), application_efficiency: Number(draft.application_efficiency) };
    if (basis.area_m2 <= 0 || basis.crop_coefficient <= 0 || basis.application_efficiency <= 0) {
      setMessage('Irrigated area, crop coefficient and application efficiency must be greater than zero.');
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    try {
      const result = await estimateRegionalDemand(siteId, basis, controller.signal);
      if (!controller.signal.aborted) setPreview({ result, basis });
    } catch (err) {
      if (!controller.signal.aborted) setMessage(err instanceof ApiError && Object.keys(err.fields).length
        ? Object.values(err.fields).join(' ') : 'Demand estimation is unavailable. Retry or enter a manual demand.');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return <details className="region-estimator">
    <summary>Estimate sector demand from weather</summary>
    <p>Use the selected day’s estimated reference evapotranspiration and rainfall with your area, crop and irrigation assumptions.</p>
    <p><strong>FAO-56 reference ET₀ {value(weather.et0_mm)} mm · Gridded rainfall {value(weather.precipitation_mm)} mm</strong></p>
    <p>Reference ET₀ is calculated with the Penman–Monteith equation from archived meteorological inputs.
      {' '}<a href={weather.source.url} target="_blank" rel="noreferrer">NASA POWER weather inputs <ArrowUpRight size={12}/></a></p>
    <form onSubmit={estimate} aria-label="Weather-based demand estimator">
      <div className="region-inputs">
        <label className="field"><span>Target sector</span><select value={sector} onChange={event => {
          clearPreview(); selectSector(event.target.value as RegionSector);
        }}><option value="west">West sector</option><option value="east">East sector</option></select></label>
        {fields.map(({ key, label, max }) => <label key={key} className="field"><span>{label}</span>
          <input value={drafts[sector][key] ?? ''} onChange={event => {
            const raw = event.target.value;
            clearPreview(); onDiscard(sector);
            setDrafts(old => ({ ...old, [sector]: { ...old[sector], [key]: raw } }));
          }} type="number" required step="any" min="0" max={max} /></label>)}
      </div>
      <p className="muted small">Net depth is crop coefficient × reference ET₀ minus effective rain, floored at zero.
        Gross demand scales that depth by area and divides by application efficiency.
        This one-day estimate omits soil-water carryover and leaching requirements.</p>
      <button className="button button-secondary" type="submit" disabled={pending}>{pending ? 'Estimating…' : 'Estimate daily demand'}</button>
      {message && <p role="status">{message}</p>}
      {preview && <div className="region-estimate-result" role="group" aria-label="Estimated sector volume">
        <div><strong>{value(preview.result.demand_m3)} m³</strong>
          <span>{value(preview.result.effective_rain_mm)} mm effective rainfall · {value(preview.result.net_depth_mm)} mm net depth</span>
          <span>Gross demand {value(preview.result.gross_demand_m3)} m³, rounded up to the next whole m³ for planning.</span></div>
        {applied[sector] === preview.basis ? <span role="status">Applied to the {sector} sector.</span> :
          <button type="button" className="button button-secondary" onClick={() =>
            onApply(sector, preview.result.demand_m3, preview.basis)}>Use for {sector} sector</button>}
      </div>}
    </form>
  </details>;
}
