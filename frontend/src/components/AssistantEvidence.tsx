import { BookOpenText, ExternalLink } from 'lucide-react';
import { dateLabel, provenanceLabel } from '../format.ts';
import type { AssistantAnswer } from '../types.ts';

export function Metric({ fact }: { fact: AssistantAnswer['facts'][number] }) {
  return <div className="assistant-fact">
    <span className={`assistant-provenance provenance-${fact.provenance}`}>{fact.source_url ? 'Source data' : 'MIZUHO'} · {provenanceLabel[fact.provenance]}</span>
    <span>{fact.text}</span>
    {fact.source_url && <a href={fact.source_url} target="_blank" rel="noreferrer" className="text-button">
      Open dataset <ExternalLink size={14} />
    </a>}
  </div>;
}

export function SourceCitation({ citation }: { citation: AssistantAnswer['citations'][number] }) {
  return <details className="assistant-citation" open>
    <summary><BookOpenText size={15} /> {citation.organization} · {citation.title}</summary>
    <div>
      <p className="muted">{citation.section} · {dateLabel(citation.date)}
        {citation.page != null && ` · p. ${citation.page}`}</p>
      <p className="muted">Publisher excerpt</p>
      <blockquote translate="no">{citation.excerpt}</blockquote>
      <p><strong>MIZUHO assessment:</strong> {citation.limitation}</p>
      <a href={citation.url} target="_blank" rel="noreferrer" className="text-button">Read the source <ExternalLink size={14} /></a>
    </div>
  </details>;
}
