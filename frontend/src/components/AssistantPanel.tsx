import { ArrowUp, BookOpenText, ExternalLink, LoaderCircle, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, askAssistant, getAssistantHealth, type DataMode } from '../api.ts';
import { dateLabel, provenanceLabel } from '../format.ts';
import type { AssistantAnswer, AssistantHealth, AssistantSimulationContext, Site, SolarOption } from '../types.ts';
import { Modal } from './EvidencePanel.tsx';

const suggestions = [
  'Why did grower A receive only 5 m³ in the A/B demo?',
  'What does ANME say about photovoltaic potential in northwest Tunisia?',
  'Which site data are simulated?',
];

function createSessionId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function Metric({ fact }: { fact: AssistantAnswer['facts'][number] }) {
  return <div className="assistant-fact">
    <span className={`assistant-provenance provenance-${fact.provenance}`}>MIZUHO · {provenanceLabel[fact.provenance]}</span>
    <span>{fact.text}</span>
  </div>;
}

function SourceCitation({ citation }: { citation: AssistantAnswer['citations'][number] }) {
  return <details className="assistant-citation" open>
    <summary><BookOpenText size={15} /> {citation.organization} · {citation.title}</summary>
    <div>
      <p className="muted">{citation.section} · {dateLabel(citation.date)}
        {citation.page != null && ` · p. ${citation.page}`}</p>
      <p className="muted">Publisher excerpt</p>
      <blockquote>{citation.excerpt}</blockquote>
      <p><strong>MIZUHO assessment:</strong> {citation.limitation}</p>
      <a href={citation.url} target="_blank" rel="noreferrer" className="text-button">Read the source <ExternalLink size={14} /></a>
    </div>
  </details>;
}

function Answer({ answer }: { answer: AssistantAnswer }) {
  const referencedFacts = new Set(answer.paragraphs.flatMap((paragraph) => paragraph.fact_ids));
  const referencedCitations = new Set(answer.paragraphs.flatMap((paragraph) => paragraph.citation_ids));
  return <div className="assistant-answer">
    {answer.paragraphs.map((paragraph, index) => <section key={index} className="assistant-paragraph">
      <p>{paragraph.text}</p>
      {paragraph.fact_ids.map((id) => {
        const fact = answer.facts.find((item) => item.id === id);
        return fact && <Metric key={id} fact={fact} />;
      })}
      {paragraph.citation_ids.map((id) => {
        const citation = answer.citations.find((item) => item.id === id);
        return citation && <SourceCitation key={id} citation={citation} />;
      })}
    </section>)}
    {answer.facts.filter((fact) => !referencedFacts.has(fact.id)).map((fact) => <Metric key={fact.id} fact={fact} />)}
    {answer.citations.filter((citation) => !referencedCitations.has(citation.id))
      .map((citation) => <SourceCitation key={citation.id} citation={citation} />)}
    {answer.missing_information.length > 0 && <div className="assistant-missing">
      <strong>Missing information</strong>
      <ul>{answer.missing_information.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>}
  </div>;
}

interface Turn {
  question: string;
  scope: string;
  answer?: AssistantAnswer;
  error?: string;
}

export default function AssistantPanel({ site, mode, solar, simulation, open, close }: {
  site: Site; mode: DataMode; solar: SolarOption | null; simulation?: AssistantSimulationContext;
  open: boolean; close: () => void;
}) {
  const [sessionId] = useState(createSessionId);
  const [health, setHealth] = useState<AssistantHealth['status'] | 'checking'>('checking');
  const [healthAttempt, setHealthAttempt] = useState(0);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const request = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  const last = turns.at(-1);
  const pending = Boolean(last && !last.answer && !last.error);
  const available = mode !== 'demo' && (health === 'available' || health === 'incomplete');
  const scope = JSON.stringify([site.properties.site_id, solar?.id, simulation]);

  useEffect(() => {
    if (!open || mode === 'demo') return;
    const controller = new AbortController();
    setHealth('checking');
    getAssistantHealth(controller.signal).then((result) => {
      if (!controller.signal.aborted) setHealth(result.status);
    }).catch(() => {
      if (!controller.signal.aborted) setHealth('unavailable');
    });
    return () => controller.abort();
  }, [mode, open, healthAttempt]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (open && turns.length) end.current?.scrollIntoView({ block: 'nearest' });
  }, [open, turns]);

  const send = (input: string) => {
    const prompt = input.trim();
    if (!available || request.current || prompt.length < 3) return;
    const controller = new AbortController();
    request.current = controller;
    setQuestion('');
    const turn = { question: prompt, scope };
    setTurns((previous) => [...previous.slice(-9), turn]);
    const finish = (entry: Turn) => {
      if (!controller.signal.aborted) setTurns((previous) => [...previous.slice(0, -1), entry]);
      request.current = null;
    };
    askAssistant({
      question: prompt, site_id: site.properties.site_id, solar_option_id: solar?.id, session_id: sessionId,
      comparison: simulation?.comparison, selected_scenario_id: simulation?.scenarioId,
      simulation_revision: simulation?.revision, simulation_pending: simulation?.pending,
    }, controller.signal).then((answer) => finish({ ...turn, answer })).catch((error) => {
      const message = error instanceof ApiError && error.status === 429
        ? 'The assistant is busy. Try again shortly.' : 'The assistant could not answer. Try again in a moment.';
      finish({ ...turn, error: message });
    });
  };

  if (!open) return null;
  return <Modal title="Mizhuo assistant" icon={<Sparkles size={23} />} close={close} kind="assistant-modal">
    <div className="assistant-header">
      <span className="assistant-site">{site.properties.label}</span>
      <span className="assistant-context">{simulation?.comparison ? 'Current comparison available' : 'Site and evidence'}</span>
      {available && health === 'incomplete' && <span className="assistant-context">Evidence index incomplete</span>}
    </div>
    <div className="assistant-thread" aria-live="polite" aria-relevant="additions text">
      {mode === 'demo' || health === 'unavailable'
        ? <div className="assistant-notice">
          <p>The assistant needs a connected evidence service. Site maps and simulations remain available.</p>
          {mode !== 'demo' && <button type="button" className="text-button" onClick={() => setHealthAttempt((attempt) => attempt + 1)}>
            Retry evidence connection
          </button>}
        </div>
        : health === 'checking' && <p className="assistant-notice" role="status"><LoaderCircle size={16} /> Checking evidence access…</p>}
      {available && turns.length === 0 && <div className="assistant-welcome">
          <h3>Ask about a plan or its evidence</h3>
          <p>Explore the assumptions, official sources, or trade-offs behind an irrigation decision.</p>
          <div className="assistant-suggestions">{suggestions.map((suggestion) =>
            <button key={suggestion} type="button" onClick={() => send(suggestion)}>{suggestion}</button>)}</div>
        </div>}
      {turns.map((turn, index) => <article key={index} className="assistant-turn">
          <p className="assistant-question">{turn.question}</p>
          {turn.scope !== scope && Boolean(turn.answer?.facts.length) &&
            <span className="assistant-context">Historical result · earlier inputs</span>}
          {turn.answer ? <Answer answer={turn.answer} /> : turn.error
            ? <p className="assistant-notice" role="alert">{turn.error}</p>
            : <p className="assistant-notice" role="status"><LoaderCircle size={16} /> Checking results and evidence…</p>}
        </article>)}
      <div ref={end} />
    </div>
    {available && <form className="assistant-input" onSubmit={(event) => { event.preventDefault(); send(question); }}>
      <label htmlFor="assistant-question" className="assistant-input-label">Your question</label>
      <textarea id="assistant-question" maxLength={1600} rows={2} placeholder="Ask about irrigation, solar options, or evidence…"
        value={question} onChange={(event) => setQuestion(event.target.value)} />
      <button type="submit" className="button button-primary" aria-label="Send question" disabled={pending || question.trim().length < 3}>
        <ArrowUp size={20} />
      </button>
    </form>}
  </Modal>;
}
