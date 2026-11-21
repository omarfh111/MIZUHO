import { ClipboardList } from 'lucide-react';
import { parcelCommitments, type CommitmentPlot } from '../commitments.ts';
import { clockHour, value } from '../format.ts';
import type { Plan } from '../types.ts';
import type { ReplaySelection } from '../twin.ts';
import './commitment-register.css';

type Choice = ReplaySelection['plan'];

interface Props {
  plan: Plan;
  selected: Choice;
  labels: Record<Choice, string>;
  onSelect: (choice: Choice) => void;
  plots: CommitmentPlot[];
  fromSlot: number;
  unavailable?: string;
  sectors?: boolean;
}

const volume = (n: number | null | undefined) => n == null ? 'Unavailable' : `${value(n)} m³`;

export default function CommitmentRegister({ plan, selected, labels, onSelect, plots, fromSlot, unavailable, sectors }: Props) {
  const rows = unavailable ? null : parcelCommitments(plots, plan, fromSlot);
  const name = (id: string) => sectors ? `${id[0].toUpperCase()}${id.slice(1)} sector` : `Plot ${id}`;
  const short = rows?.filter(row => row.shortfall != null && row.shortfall > 0) ?? [];
  const first = short[0];
  const firstSlot = first?.lastEligible ?? first?.deadline;
  const firstGroup = short.filter(row => (row.lastEligible ?? row.deadline) === firstSlot);
  const checked = Boolean(rows?.length && rows.every(row => row.shortfall != null));
  const hasMinimum = rows?.some(row => row.minimum != null && row.minimum > 0);
  return <section className="surface commitment-register" aria-label="Daily delivery commitments">
    <header><div className="title-with-icon"><div className="section-icon"><ClipboardList size={19} /></div><div>
      <h2>Daily delivery commitments</h2><p className="muted small">Simulated schedule · Tunis time</p></div></div>
      {!unavailable && <label className="field"><span>Schedule to inspect</span>
        <select value={selected} onChange={event => onSelect(event.target.value as Choice)}>
          <option value="baseline">{labels.baseline}</option><option value="optimized">{labels.optimized}</option>
        </select></label>}</header>
    {!rows ? <p role="status">{unavailable ?? 'No verified parcel results are available for this schedule.'}</p> : <>
      <p role="status" className={`commitment-outcome${first ? ' commitment-shortfall' : ''}`}>
        {first && firstSlot != null ? <><strong>{firstSlot < fromSlot ? 'Review the earliest missed commitment' : 'First known shortfall to flag'}</strong>
          {firstGroup.map(row => `${name(row.id)} falls ${volume(row.shortfall)} short${row.lastEligible == null
            ? ` with no eligible slot by ${clockHour(row.deadline)}` : ` by the ${clockHour(row.lastEligible)} slot`}`).join(' · ')}.
          {!checked && ' Some parcel results are unavailable.'}</> : !checked ? 'Parcel results are incomplete. Verify the missing entries before confirming deliveries.'
          : hasMinimum ? 'This schedule meets every positive parcel minimum by its deadline.' : 'This schedule has no positive parcel minimum.'}
      </p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Delivery commitments by parcel">
        <table><thead><tr><th scope="col">{sectors ? 'Sector' : 'Parcel'}</th><th scope="col">Last on-time slot</th>
          <th scope="col">Minimum</th><th scope="col">Delivered on time</th><th scope="col">Shortfall</th><th scope="col">Scheduled deliveries from {clockHour(fromSlot)}</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}><th scope="row">{name(row.id)}</th>
            <td>{row.lastEligible == null ? 'No eligible slot' : clockHour(row.lastEligible)}{row.lastEligible !== row.deadline && <small>Deadline slot {clockHour(row.deadline)}</small>}</td>
            <td>{volume(row.minimum)}</td><td>{volume(row.timely)}</td><td className={row.shortfall ? 'commitment-deficit' : undefined}>{volume(row.shortfall)}</td>
            <td>{row.remaining == null ? 'Unavailable' : row.remaining.length ? <ul>{row.remaining.map(delivery => <li key={delivery.slot}>
              {clockHour(delivery.slot)} · {volume(delivery.volume)}{delivery.slot > row.deadline ? ' · late' : ''}</li>)}</ul> : 'None scheduled'}</td>
          </tr>)}</tbody></table></div>
      <p className="muted small">The last on-time slot counts in full. Daily totals include credited deliveries before the start of the remaining schedule.</p>
    </>}
  </section>;
}
