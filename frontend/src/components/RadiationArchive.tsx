import { useEffect, useState } from 'react';
import { getRadiationDay } from '../api.ts';
import { value } from '../format.ts';

export default function RadiationArchive({ chart = false }: { chart?: boolean }) {
  const [day, setDay] = useState('2026-05-08');
  const [data, setData] = useState<Awaited<ReturnType<typeof getRadiationDay>>>();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    setError(false);
    if (day) getRadiationDay(day, controller.signal).then(response => {
      if (!controller.signal.aborted) setData(response);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [day, attempt]);
  const observations = data?.observations ?? [];
  const peak = Math.max(0, ...observations.map(item => item.radiation_w_m2));
  const byHour = new Map(observations.map(item => [Number(item.reported_at.slice(11, 13)), item.radiation_w_m2]));
  return <div className="outage-block">
    <label className="field"><span>Bouhertma station archive</span>
      <input type="date" value={day} onChange={event => setDay(event.target.value)} />
    </label>
    {chart && observations.length > 0 && <figure className="resource-profile">
      <div className="resource-bars" aria-hidden="true">{Array.from({ length: 24 }, (_, i) => {
        const reading = byHour.get(i);
        return <i key={i} className={reading === undefined ? 'hour-gap' : undefined}
          style={reading === undefined ? {} : { height: `${Math.max(2, reading / (peak || 1) * 100)}%` }}
          title={`${i}:00 · ${reading === undefined ? 'Missing' : value(reading) + ' W/m²'}`} />;
      })}</div>
      <figcaption><span>00 h</span>Reported solar radiation<span>23 h</span></figcaption>
      <details><summary>Hourly readings</summary><dl className="definition-table">
        {observations.map(item => <div key={item.reported_at}><dt>{item.reported_at.slice(11, 16)}</dt><dd>{value(item.radiation_w_m2)} W/m²</dd></div>)}
      </dl></details>
    </figure>}
    <p className="muted small" aria-live="polite">{error ? 'Weather archive unavailable.' : data ? <>
      {observations.length ? `${observations.length} reported hours · Peak irradiance ${peak} W/m².` : 'No observations on this date.'}
      {' '}Station timezone unspecified. PV production is modelled separately. <a href={data.source_url} target="_blank" rel="noreferrer">Station source ↗</a>
    </> : day ? 'Loading station readings…' : 'Choose a date to inspect station observations.'}</p>
    {error && <button className="text-button" onClick={() => setAttempt(n => n + 1)}>Retry observations</button>}
  </div>;
}
