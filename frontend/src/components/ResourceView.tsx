import { ArrowUpRight, CloudSun, Droplets, Gauge, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getFieldZone, getLayer, type DataMode } from '../api.ts';
import { dateLabel, value } from '../format.ts';
import type { FieldZone, Scenario, Site, TunisiaClimate } from '../types.ts';
import AgriculturePanel from './AgriculturePanel.tsx';
import RadiationArchive from './RadiationArchive.tsx';

interface Props {
  site: Site;
  sites: Site[];
  onMap: (siteId: string) => void;
  scenario?: Scenario;
  mode: DataMode;
  onCompare: (options: string[]) => void;
  onEvidence: (source: string) => void;
  onPlan: () => void;
}

type ZoneRow = { id: string; label: string; climate?: TunisiaClimate };

function CompareZones({ sites, selected, onMap }: Pick<Props, 'sites' | 'onMap'> & { selected: FieldZone }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ZoneRow[]>();
  const [attempt, retry] = useState(0);
  const [sort, setSort] = useState('rain');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;
    const load = async ({ properties }: Site): Promise<ZoneRow> => {
      const id = properties.site_id;
      const row = { id, label: properties.label };
      try {
        const zone = id === selected.site.properties.site_id ? selected : await getFieldZone(id, signal);
        return { ...row, climate: zone.climate };
      } catch { return row; }
    };
    Promise.all(sites.filter(s => s.properties.field_zone).map(load)).then(result => {
      if (!signal.aborted) setRows(result);
    });
    return () => controller.abort();
  }, [open, selected, sites, attempt]);
  const reference = selected.climate;
  const periodDays = (Date.parse(reference.end) - Date.parse(reference.start)) / 86400000 + 1;
  const comparable = (climate?: TunisiaClimate) => climate?.start === reference.start && climate.end === reference.end
    && climate.days === periodDays && climate.precipitation_mm != null && climate.irradiation_mean_kwh_m2_day != null;
  const rank = ({ climate }: ZoneRow) => comparable(climate)
    ? sort === 'rain' ? climate!.precipitation_mm! : -climate!.irradiation_mean_kwh_m2_day! : Infinity;
  return <details className="surface zone-comparison" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Compare regional water and solar resources</summary>
    {open && <div><p>Compare complete archives for {dateLabel(reference.start)} – {dateLabel(reference.end)}.
      Rainfall and sunlight can guide field visits. Local demand and allocations are needed to establish irrigation urgency.</p>
      <label className="field"><span>Order study areas by</span><select value={sort} onChange={e => setSort(e.target.value)}>
        <option value="rain">Lowest rainfall</option><option value="sun">Highest daily irradiation</option>
      </select></label>
      {!rows ? <p role="status">Loading regional archives…</p> : <><div className="survey-scroll"><table>
        <thead><tr><th scope="col">Study area</th><th scope="col">Rainfall</th><th scope="col">Mean daily irradiation</th></tr></thead>
        <tbody>{[...rows].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)).map(row =>
          <tr key={row.id}><th scope="row"><button className="text-button" onClick={() => onMap(row.id)}>{row.label} ↗</button></th>
            {comparable(row.climate) ? <><td>{value(row.climate?.precipitation_mm)} mm</td><td>{value(row.climate?.irradiation_mean_kwh_m2_day)} kWh/m²/day</td></>
              : <td colSpan={2}>{row.climate ? 'No matching complete period' : 'Archive unavailable'}</td>}</tr>)}</tbody>
      </table></div>{rows.some(row => !row.climate) && <button className="text-button" onClick={() => retry(n => n + 1)}>Retry missing archives</button>}</>}
    </div>}
  </details>;
}

export default function ResourceView({ site, sites, scenario, mode, onCompare, onEvidence, onPlan, onMap }: Props) {
  const { site_id: id, survey_available: survey, field_zone: regional } = site.properties;
  const [profile, setProfile] = useState<FieldZone>();
  const [optionIds, setOptionIds] = useState<string[]>();
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const failed = () => { if (!signal.aborted) setFailure(true); };
    if (regional) getFieldZone(id, signal).then(result => { if (!signal.aborted) setProfile(result); }).catch(failed);
    else if (scenario) getLayer(id, 'solar', mode, signal).then(layer => {
      if (!signal.aborted) setOptionIds([...new Set(layer.features.flatMap(f => f.properties.option_id ?? []))]);
    }).catch(failed);
    return () => controller.abort();
  }, [id, regional, scenario, mode, attempt]);

  const climate = profile?.climate;
  const retry = <button className="text-button" onClick={() => { setFailure(false); setAttempt(n => n + 1); }}>Retry resource data</button>;
  if (survey) return <div className="resource-layout">
    <AgriculturePanel siteId={id} onEvidence={onEvidence} />
    <section className="surface resource-card"><h2><Sun /> Energy and water allocation</h2>
      <p>Local pump specifications, electricity consumption and authorized withdrawals are unavailable for this survey.
        The dated evapotranspiration and rainfall estimates describe parcel water use.</p>
      <a href="#map" className="text-button">Explore mapped parcels <ArrowUpRight size={15} /></a>
    </section>
  </div>;
  if (regional) return <div className="resource-layout">
    <section className="surface resource-card"><h2><CloudSun /> Regional water and sunlight</h2>
      {climate ? <><p>{dateLabel(climate.start)} – {dateLabel(climate.end)} · {climate.days} days of gridded estimates</p>
        <dl className="resource-metrics">
          <div><dt>Total precipitation</dt><dd>{value(climate.precipitation_mm)} <small>mm</small></dd></div>
          <div><dt>Mean daily irradiation</dt><dd>{value(climate.irradiation_mean_kwh_m2_day)} <small>kWh/m²/day</small></dd></div>
        </dl><a className="text-button" href={climate.source.url} target="_blank" rel="noreferrer">{climate.source.name} <ArrowUpRight size={15} /></a></>
        : failure ? <p role="alert">Climate profile unavailable. {retry}</p> : <p role="status">Loading climate estimates…</p>}
    </section>
    <section className="surface resource-card"><h2><Droplets /> Water allocation</h2>
      {profile && <p>{profile.water_question}</p>}
      <p>The regional planner combines archived hourly sunlight with the equipment, water limit and demand you specify.</p>
      <button className="button button-primary" onClick={onPlan}>Set planning assumptions <ArrowUpRight size={16} /></button>
    </section>
    {profile && <CompareZones sites={sites} selected={profile} onMap={onMap} />}
  </div>;
  return <div className="resource-layout">
    {mode === 'live' && id === 'jendouba-pilote' && <section className="surface resource-card"><h2><Sun /> Station irradiance</h2>
      <p>Archived instrument readings from GDA Bouhertma in Jendouba.</p><RadiationArchive chart />
    </section>}
    <section className="surface resource-card"><h2><Gauge /> Pumping resources</h2>
      {scenario && <><p>{scenario.label} · {scenario.provenance} operating assumptions</p>
        <dl className="resource-metrics">
          <div><dt>Starting reservoir stock</dt><dd>{value(scenario.state.tank_stock_m3)} <small>m³</small></dd></div>
          <div><dt>Withdrawal limit</dt><dd>{value(scenario.state.quota_remaining_m3)} <small>m³</small></dd></div>
          <div><dt>Pumping energy intensity</dt><dd>{value(scenario.site.pump_wh_per_m3)} <small>Wh/m³</small></dd></div>
        </dl></>}
      <p>{mode === 'live' ? 'Compare archived PVGIS production estimates against the same modelled pumping load.' :
        'Compare simulated solar configurations for the same pumping load.'}</p>
      {failure ? <p role="alert">Solar configuration data unavailable. {retry}</p> :
        <button className="button button-primary" disabled={!optionIds || optionIds.length < 2}
          onClick={() => optionIds && onCompare(optionIds)}>Compare solar options <ArrowUpRight size={16} /></button>}
      {scenario && <button className="text-button" onClick={onPlan}>Edit operating assumptions <ArrowUpRight size={15} /></button>}
    </section>
  </div>;
}
