import { useEffect, useState } from 'react';
import { getRadiationDay } from '../api.ts';
import { hour } from '../format.ts';
import type { OperatingInputs } from '../operating.ts';
import type { Scenario } from '../types.ts';

function RadiationArchive() {
  const [day, setDay] = useState('2026-05-08');
  const [data, setData] = useState<Awaited<ReturnType<typeof getRadiationDay>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    if (day) void getRadiationDay(day, controller.signal).then((response) => {
      if (!controller.signal.aborted) setData(response);
    }).catch(() => { if (!controller.signal.aborted) setError('Weather archive unavailable.'); });
    return () => controller.abort();
  }, [day]);
  const readings = data?.observations.map((item) => item.radiation_w_m2) ?? [];
  return <div className="outage-block">
    <label className="field"><span>Bouhertma station archive</span>
      <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
    </label>
    <p className="muted small" aria-live="polite">{error || (data ? <>
      {readings.length ? `${readings.length} reported hours · Peak irradiance ${Math.max(...readings)} W/m².` : 'No observations on this date.'}
      {' '}Station timezone unspecified. PV production is modelled separately. <a href={data.source_url} target="_blank" rel="noreferrer">Station source</a>
    </> : day ? 'Loading station readings…' : 'Choose a date to inspect station observations.')}</p>
  </div>;
}

export default function OperatingEditor({ settings, scenario, weather, errors, change }: {
  settings: OperatingInputs; scenario: Scenario; weather: boolean; errors: Record<string, string>;
  change: (patch: Partial<OperatingInputs>) => void;
}) {
  const [open, setOpen] = useState(false);
  const field = (label: string, raw: string, placeholder: string, apply: (s: string) => void, key: string) =>
    <label className="field" key={key}><span>{label}</span>
      <input type="text" inputMode="numeric" value={raw} placeholder={placeholder} aria-invalid={Boolean(errors[key])}
        onChange={(e) => apply(e.target.value)} />
      {errors[key] && <small className="field-error">{errors[key]}</small>}
    </label>;
  const remaining = scenario.slots.filter((s) => s.slot >= scenario.state.current_slot);
  return <details className="outage-block what-if-controls" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>Operating constraints and incidents</summary>
    <p className="muted small">Both schedules use these assumptions. An incident preserves completed actions and recalculates the remaining hours.</p>
    <div className="simulation-fields">
      {field('Pump capacity (m³/h)', settings.pump, String(scenario.site.pump_max_m3_per_slot), (pump) => change({ pump }), 'overrides.pump_max_m3_per_slot')}
      {field('Pump power ceiling (W)', settings.power, 'Use pump capacity', (power) => change({ power }), 'overrides.pump_power_cap_w')}
      {field('Grid power ceiling (W)', settings.grid, 'Use hourly limits', (grid) => change({ grid }), 'overrides.grid_cap_w')}
      {field('Available solar production (%)', settings.solar, '100', (solar) => change({ solar }), 'overrides.solar_percent')}
      <label className="field"><span>Solar input</span>
        <select value={weather ? '' : settings.profile} disabled={weather} onChange={(e) => change({ profile: e.target.value as OperatingInputs['profile'] })}>
          <option value="">{weather ? 'Day-ahead weather pair' : 'Scenario or map selection'}</option>
          <option value="toiture">PVGIS · rooftop · 21 Jun 2023</option><option value="ombriere">PVGIS · canopy · 21 Jun 2023</option>
        </select>
      </label>
      <label className="field"><span>Gravity-fed distribution</span><select value={String(settings.gravity)}
        onChange={(e) => change({ gravity: e.target.value === 'true' })}><option value="true">Available</option><option value="false">Unavailable</option></select></label>
      {scenario.plots.map((plot) => field(`Plot ${plot.plot_id} demand (m³)`, settings.demand[plot.plot_id] ?? '',
        String(plot.demand_m3), (raw) => change({ demand: { ...settings.demand, [plot.plot_id]: raw } }), `overrides.demand_by_plot_m3.${plot.plot_id}`))}
    </div>
    <div className="simulation-fields">
      <label className="field"><span>Unexpected incident</span>
        <select disabled={weather || !remaining.length} value={weather ? 'none' : settings.event}
          onChange={(e) => change({ event: e.target.value as OperatingInputs['event'] })}>
          <option value="none">None</option><option value="unexpected_outage">Unexpected grid outage</option><option value="pump_shutdown">Pump shutdown</option>
        </select>
      </label>
      {!weather && settings.event !== 'none' && <>
        <label className="field"><span>Incident starts</span><select value={settings.start} onChange={(e) => {
          const start = Number(e.target.value);
          change({ start, duration: Math.min(settings.duration, scenario.slots.length - start) });
        }}>{remaining.map((s) => <option key={s.slot} value={s.slot}>{hour(s.slot)}</option>)}</select></label>
        <label className="field"><span>Incident duration</span><select value={settings.duration} onChange={(e) => change({ duration: Number(e.target.value) })}>
          {remaining.filter((s) => s.slot >= settings.start).map((s) => <option key={s.slot} value={s.slot - settings.start + 1}>{s.slot - settings.start + 1} h</option>)}
        </select></label>
      </>}
    </div>
    {errors.incident && <small className="field-error">{errors.incident}</small>}
    {open && <RadiationArchive />}
  </details>;
}
