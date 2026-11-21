import { ArrowRight, BookOpenText, CheckCircle2, Circle, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { archiveSolarCompare, solarCompare, type DataMode } from '../api.ts';
import { provenanceLabel, value } from '../format.ts';
import type { SolarOption } from '../types.ts';
import { Modal } from './EvidencePanel.tsx';

interface Props {
  site: string;
  options: string[];
  mode: DataMode;
  selectedOption: SolarOption | null;
  close: () => void;
  onUse: (option: SolarOption) => void;
  onEvidence: (source: string) => void;
  startWithArchive?: boolean;
}

function Profile({ profile, max, label }: { profile: number[]; max: number; label: string }) {
  return <div className="profile">
    <div className="profile-chart" role="img" aria-label={`Hourly generation · ${label} · peak ${value(Math.max(...profile) / 1000)} kWh`}>
      {profile.map((wh, hour) => <div key={hour} className="profile-bar" title={`${hour} h · ${value(wh / 1000)} kWh`}
        style={{ height: `${Math.max(3, wh * 100 / max)}%` }} />)}
    </div>
    <div className="profile-axis"><span>00 h</span><span>12 h</span><span>23 h</span></div>
  </div>;
}

export default function SolarComparison({ site, options, mode, selectedOption, close, onUse, onEvidence, startWithArchive }: Props) {
  const [results, setResults] = useState<SolarOption[] | null>(null);
  const [selected, setSelected] = useState(selectedOption?.id ?? options[0]);
  const [price, setPrice] = useState('');
  const [appliedPrice, applyPrice] = useState<number>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [priceError, setPriceError] = useState('');
  const [compared, setCompared] = useState(options.slice(0, 2));
  const [archive, setArchive] = useState(selectedOption ? selectedOption.source_id === 'pvgis-sarah3-jendouba-2023' : Boolean(startWithArchive));
  useEffect(() => {
    const controller = new AbortController();
    const body = { site_id: site, option_ids: compared, price_tnd_per_kwh: appliedPrice };
    (archive ? archiveSolarCompare(body, controller.signal) : solarCompare(body, mode, controller.signal))
      .then((result) => {
        if (controller.signal.aborted) return;
        setResults(result);
        setSelected((previous) => result.some(({ id }) => id === previous) ? previous : result[0]?.id);
      })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [site, compared, mode, appliedPrice, refresh, archive]);

  const max = Math.max(1000, ...(results?.flatMap(({ profile_wh }) => profile_wh ?? []) ?? []));
  const selection = results?.find(({ id }) => id === selected);
  const update = () => {
    const parsed = price.trim() === '' ? undefined : Number(price.trim().replace(',', '.'));
    if (parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0)) {
      setPriceError('Enter a nonnegative tariff or leave the field blank.');
      return;
    }
    setPriceError('');
    setError('');
    setLoading(true);
    applyPrice(parsed);
    setRefresh((version) => version + 1);
  };

  return <Modal title="Compare solar options" icon={<Sun size={22} />} close={close} wide>
    <p className="modal-intro">Compare solar generation and grid use for the same pumping demand.</p>
    {mode === 'live' && <label className="field"><span>Production source</span><select value={archive ? 'archive' : 'scenario'}
      onChange={(e) => { setArchive(e.target.value === 'archive'); setLoading(true); setError(''); setResults(null); }}>
      <option value="scenario">Pilot scenario · simulated profiles</option><option value="archive">PVGIS archive · 21 June 2023</option>
    </select></label>}
    {options.length > 2 && <div className="solar-option-controls">
      {compared.map((option, index) => <label className="field" key={index}>
        <span>Configuration {index + 1}</span>
        <select value={option} onChange={(event) => {
          setLoading(true); setError('');
          setCompared(compared.map((id, position) => position === index ? event.target.value : id));
        }}>{options.filter((id) => id === option || !compared.includes(id)).map((id) => <option key={id}>{id}</option>)}</select>
      </label>)}
    </div>}
    <form className="price-form" onSubmit={(event) => { event.preventDefault(); update(); }}>
      <label className="field"><span>Grid tariff · optional</span><span className="unit-input">
        <input inputMode="decimal" placeholder="0.25" value={price} onChange={(event) => { setPrice(event.target.value); setPriceError(''); }}
          aria-invalid={Boolean(priceError)} aria-describedby={priceError ? 'price-error' : undefined} />
        <span>TND/kWh</span></span>
      </label>
      <button type="submit" className="button button-secondary" disabled={loading}>Update savings</button>
    </form>
    {priceError && <p className="field-error" id="price-error" role="alert">{priceError}</p>}
    {loading && <p className="muted" role="status">Loading profiles…</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {!loading && !error && !results?.length && <p className="muted">Insufficient data to compare these configurations.</p>}
    {results && results.length > 0 && <div className="solar-options" aria-busy={loading}>
      {results.map((option) => {
        const Icon = selected === option.id ? CheckCircle2 : Circle;
        return <article key={option.id} className={`solar-option ${selected === option.id ? 'option-selected' : ''}`}>
          <button type="button" className="option-select" aria-pressed={selected === option.id} onClick={() => setSelected(option.id)}>
            <div><small>{option.provenance ? provenanceLabel[option.provenance] : 'Source unavailable'}{option.period && ` · ${option.period}`}</small>
              <strong>{option.label}</strong></div><Icon size={21} />
          </button>
          {option.profile_wh?.length ? <Profile profile={option.profile_wh} max={max} label={option.label} />
            : <p className="muted small">Hourly profile unavailable</p>}
          <dl className="definition-table">
            <dt>Installed capacity</dt><dd>{value(option.capacity_kwp)} kWp</dd>
            <dt>Tilt / azimuth / losses</dt><dd>{value(option.tilt_deg)}° / {value(option.azimuth_deg)}° / {value(option.losses_pct)} %</dd>
            <dt>Generation for this period</dt><dd>{value(option.production_kwh)} kWh</dd>
            <dt>Annual generation</dt><dd>{value(option.annual_production_kwh)} kWh</dd>
            <dt>On-site solar use</dt><dd>{value(option.self_consumed_kwh)} kWh</dd>
            <dt>Grid energy avoided</dt><dd>{value(option.grid_avoided_kwh)} kWh</dd>
            <dt>Runtime during outage</dt><dd>{value(option.autonomy_hours)} h</dd>
            <dt>Gross savings for this period</dt><dd>{value(option.gross_savings_tnd)} TND</dd>
            <dt>Net savings / simple payback</dt><dd>{value(option.net_savings_tnd)} TND / {value(option.payback_years)} years</dd>
          </dl>
          {option.source_id && <button type="button" className="text-button" onClick={() => onEvidence(option.source_id!)}><BookOpenText size={15} /> Provenance</button>}
        </article>;
      })}
    </div>}
    <div className="modal-actions">
      <span className="muted small">Grid-tied solar shuts down during a power outage.</span>
      <button type="button" className="button button-primary" disabled={!selection || loading || Boolean(error)}
        onClick={() => { if (selection) onUse(selection); }}>Use in simulation <ArrowRight size={17} /></button>
    </div>
  </Modal>;
}
