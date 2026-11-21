import { BookOpenText, ExternalLink } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { getEvidence, getPassages, type DataMode } from '../api.ts';
import { dateLabel } from '../format.ts';
import type { Citation, Evidence } from '../types.ts';

export function Modal({ title, icon, children, close, wide = false, kind = '' }: {
  title: string; icon: ReactNode; children: ReactNode; close: () => void; wide?: boolean; kind?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); };
  }, []);
  return <dialog ref={dialog} className={`modal ${wide ? 'modal-wide' : ''} ${kind}`}
    aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal-content">
      <div className="modal-head">
        <div className="title-with-icon">{icon}<h2 id={titleId}>{title}</h2></div>
        <button type="button" className="icon-button" onClick={close} aria-label="Close" autoFocus><X size={20} /></button>
      </div>
      {children}
    </div>
  </dialog>;
}

export default function EvidencePanel({ source, mode, close }: { source: string; mode: DataMode; close: () => void }) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [passages, setPassages] = useState<Citation[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getEvidence(source, mode, controller.signal).then(setEvidence).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    if (mode === 'live') {
      getPassages(source, controller.signal).then(setPassages).catch(() => {});
    }
    return () => controller.abort();
  }, [source, mode]);
  return <Modal title="Data source" icon={<BookOpenText size={22} />} close={close}>
    {failed ? <p role="alert" className="muted">This source is unavailable.</p> : !evidence
      ? <p role="status" className="muted">Loading the source…</p> : <div className="evidence">
        <h3>{evidence.title}</h3>
        <p className="evidence-meta">{evidence.organization} · {dateLabel(evidence.date)}
          {evidence.page != null && ` · p. ${evidence.page}`}</p>
        <p>{evidence.limitation}</p>
        {passages.map((passage) => <div key={passage.id} className="evidence-passage">
          <p><strong>{passage.section}</strong> · {dateLabel(passage.date)}
            {passage.page != null && ` · p. ${passage.page}`}</p>
          <blockquote>{passage.excerpt}</blockquote>
        </div>)}
        {evidence.url && <a className="button button-secondary" href={evidence.url} target="_blank" rel="noreferrer">
          Open source <ExternalLink size={15} /></a>}
      </div>}
  </Modal>;
}
