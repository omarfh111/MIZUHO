import { useEffect, useState } from 'react';
import { getAgriculture } from '../api.ts';
import { dateLabel, value } from '../format.ts';
import type { AgriculturalSurvey } from '../types.ts';
import './agriculture.css';

export default function AgriculturePanel({ siteId, plotId, onEvidence }: {
  siteId: string; plotId?: string; onEvidence: (id: string) => void;
}) {
  const [survey, setSurvey] = useState<AgriculturalSurvey | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getAgriculture(siteId, controller.signal).then(data => {
      if (!controller.signal.aborted) setSurvey(data);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [siteId]);
  if (!survey) return <p role="status">{failed ? 'Agricultural survey unavailable.' : 'Loading agricultural survey…'}</p>;
  const parcels = plotId ? survey.parcels.filter(p => p.plot_id === plotId) : survey.parcels;
  const selected = plotId ? parcels[0] : undefined;
  return <section className="surface survey-panel" aria-label="Agricultural survey">
    <header><div><h2>Parcel water use</h2>
      <p>FAO WaPOR · {survey.period.split('/').map(dateLabel).join(' – ')} · {survey.resolution} AETI grid</p>
    </div><button className="text-button" onClick={() => onEvidence('wapor3-l2-aeti-2026-07-d2')}>WaPOR source ↗</button></header>
    <div className="survey-scroll"><table>
      <thead><tr><th scope="col">OSM parcel</th><th scope="col">Mapped area</th><th scope="col">AETI</th>
        <th scope="col">Gross rainfall</th><th scope="col">ET minus rain</th></tr></thead>
      <tbody>{parcels.map(p => <tr key={p.plot_id}><th scope="row"><a href={`https://www.openstreetmap.org/way/${p.osm_way_id}`}
        target="_blank" rel="noreferrer">{p.plot_id} ↗</a></th><td>{value(p.surface_m2)} m²</td>
        <td>{value(p.eta_mm_day)} mm/day</td><td>{value(p.precip_mm_day)} mm/day</td>
        <td>{value(p.et_minus_rain_m3_day)} m³/day</td></tr>)}</tbody>
    </table></div>
    <p>{survey.interpretation} Farmer identities, crops and delivery windows are unverified.</p>
    {selected && <p><strong>Temperature association.</strong> Adjusting for rainfall, the estimated AETI slope was
      {' '}{selected.temperature.slope_mm_day_per_c} mm/day per °C (p = {selected.temperature.p_value}) across
      {' '}{selected.temperature.samples} ten-day periods ({selected.temperature.period}). Temperature comes from coarse
      NASA POWER reanalysis. Seasonal trends and correlated observations limit causal interpretation.
      {' '}<button className="text-button" onClick={() => onEvidence('nasa-power-daily')}>Temperature source ↗</button></p>}
    <small>Boundaries © OpenStreetMap contributors, ODbL · WaPOR estimates © FAO, CC BY 4.0</small>
  </section>;
}
