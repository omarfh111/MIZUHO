import { ArrowRight, BookOpenText, CheckCircle2, Circle, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { solarCompare, type DataMode } from '../api.ts';
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
}

function Profile({ profile, max, label }: { profile: number[]; max: number; label: string }) {
  return <div className="profile">
    <div className="profile-chart" role="img" aria-label={`Production horaire · ${label} · pic ${value(Math.max(...profile) / 1000)} kWh`}>
      {profile.map((wh, hour) => <div key={hour} className="profile-bar" title={`${hour} h · ${value(wh / 1000)} kWh`}
        style={{ height: `${Math.max(3, wh * 100 / max)}%` }} />)}
    </div>
    <div className="profile-axis"><span>00 h</span><span>12 h</span><span>23 h</span></div>
  </div>;
}

export default function SolarComparison({ site, options, mode, selectedOption, close, onUse, onEvidence }: Props) {
  const [results, setResults] = useState<SolarOption[] | null>(null);
  const [selected, setSelected] = useState(selectedOption?.id ?? options[0]);
  const [price, setPrice] = useState('');
  const [appliedPrice, applyPrice] = useState<number>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [priceError, setPriceError] = useState('');
  const [compared, setCompared] = useState(options.slice(0, 2));
  useEffect(() => {
    const controller = new AbortController();
    solarCompare({ site_id: site, option_ids: compared, price_tnd_per_kwh: appliedPrice }, mode, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setResults(result);
        setSelected((previous) => result.some(({ id }) => id === previous) ? previous : result[0]?.id);
      })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [site, compared, mode, appliedPrice, refresh]);

  const max = Math.max(1000, ...(results?.flatMap(({ profile_wh }) => profile_wh ?? []) ?? []));
  const selection = results?.find(({ id }) => id === selected);
  const update = () => {
    const parsed = price.trim() === '' ? undefined : Number(price.trim().replace(',', '.'));
    if (parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0)) {
      setPriceError('Saisissez un tarif positif ou laissez le champ vide.');
      return;
    }
    setPriceError('');
    setError('');
    setLoading(true);
    applyPrice(parsed);
    setRefresh((version) => version + 1);
  };

  return <Modal title="Comparer les options solaires" icon={<Sun size={22} />} close={close} wide>
    <p className="modal-intro">Comparez la production et l’appel au réseau à service de pompage équivalent.</p>
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
      <label className="field"><span>Tarif réseau · facultatif</span><span className="unit-input">
        <input inputMode="decimal" placeholder="0,25" value={price} onChange={(event) => { setPrice(event.target.value); setPriceError(''); }}
          aria-invalid={Boolean(priceError)} aria-describedby={priceError ? 'price-error' : undefined} />
        <span>TND/kWh</span></span>
      </label>
      <button type="submit" className="button button-secondary" disabled={loading}>Actualiser les gains</button>
    </form>
    {priceError && <p className="field-error" id="price-error" role="alert">{priceError}</p>}
    {loading && <p className="muted" role="status">Chargement des profils…</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {!loading && !error && !results?.length && <p className="muted">Données insuffisantes pour comparer ces configurations.</p>}
    {results && results.length > 0 && <div className="solar-options" aria-busy={loading}>
      {results.map((option) => {
        const Icon = selected === option.id ? CheckCircle2 : Circle;
        return <article key={option.id} className={`solar-option ${selected === option.id ? 'option-selected' : ''}`}>
          <button type="button" className="option-select" aria-pressed={selected === option.id} onClick={() => setSelected(option.id)}>
            <div><small>{option.provenance ? provenanceLabel[option.provenance] : 'Provenance indisponible'}{option.period && ` · ${option.period}`}</small>
              <strong>{option.label}</strong></div><Icon size={21} />
          </button>
          {option.profile_wh?.length ? <Profile profile={option.profile_wh} max={max} label={option.label} />
            : <p className="muted small">Profil horaire indisponible</p>}
          <dl className="definition-table">
            <dt>Puissance installée</dt><dd>{value(option.capacity_kwp)} kWc</dd>
            <dt>Inclinaison / azimut / pertes</dt><dd>{value(option.tilt_deg)}° / {value(option.azimuth_deg)}° / {value(option.losses_pct)} %</dd>
            <dt>Production sur la période</dt><dd>{value(option.production_kwh)} kWh</dd>
            <dt>Production annuelle</dt><dd>{value(option.annual_production_kwh)} kWh</dd>
            <dt>Autoconsommation</dt><dd>{value(option.self_consumed_kwh)} kWh</dd>
            <dt>Énergie réseau évitée</dt><dd>{value(option.grid_avoided_kwh)} kWh</dd>
            <dt>Autonomie en coupure</dt><dd>{value(option.autonomy_hours)} h</dd>
            <dt>Gain brut sur la période</dt><dd>{value(option.gross_savings_tnd)} TND</dd>
            <dt>Gain net / retour simple</dt><dd>{value(option.net_savings_tnd)} TND / {value(option.payback_years)} ans</dd>
          </dl>
          {option.source_id && <button type="button" className="text-button" onClick={() => onEvidence(option.source_id!)}><BookOpenText size={15} /> Provenance</button>}
        </article>;
      })}
    </div>}
    <div className="modal-actions">
      <span className="muted small">Le solaire raccordé s’arrête pendant une coupure.</span>
      <button type="button" className="button button-primary" disabled={!selection || loading || Boolean(error)}
        onClick={() => { if (selection) onUse(selection); }}>Utiliser dans la simulation <ArrowRight size={17} /></button>
    </div>
  </Modal>;
}
