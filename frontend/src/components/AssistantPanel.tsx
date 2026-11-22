import { ArrowUp, LoaderCircle, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, askAssistant, assistantSolarContext, getAssistantHealth, type DataMode } from '../api.ts';
import { dateLabel } from '../format.ts';
import type { AssistantAnswer, AssistantHealth, AssistantSimulationContext, RegionPlanContext, Site, SolarOption, TunisiaCity, TunisiaPeriod } from '../types.ts';
import { Metric, SourceCitation } from './AssistantEvidence.tsx';
import { Modal } from './EvidencePanel.tsx';
import { translate, useLanguage } from '../i18n/language.ts';

const suggestions = [
  'Why did grower A receive only 5 m³ in the A/B demo?',
  'What does ANME say about photovoltaic potential in northwest Tunisia?',
  'Which site data are simulated?',
];
const surveySuggestions = [
  'What does WaPOR estimate for parcel P-01?',
  'Which measurements are missing before these parcels can be scheduled?',
  'Does the temperature analysis establish a cause for changes in water use?',
];
const fieldZoneSuggestions = [
  'What do the local land-cover, elevation, and climate archives show?',
  'Which field measurements are needed before planning irrigation here?',
];
const citySuggestions = [
  'What do the archived climate and elevation estimates show for this city?',
  'Which field measurements are needed to plan irrigation here?',
];

function createSessionId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
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

export default function AssistantPanel({ site, city, period, mode, solar, simulation, zonePlan, open, close }: {
  site?: Site; city?: TunisiaCity; period?: TunisiaPeriod; mode: DataMode; solar: SolarOption | null; simulation?: AssistantSimulationContext;
  zonePlan?: RegionPlanContext;
  open: boolean; close: () => void;
}) {
  const language = useLanguage();
  const [sessionId] = useState(createSessionId);
  const [health, setHealth] = useState<AssistantHealth['status'] | 'checking'>('checking');
  const [healthAttempt, setHealthAttempt] = useState(0);
  const [nvidia, setNvidia] = useState<string | null>(null);
  const [provider, setProvider] = useState<'openai' | 'nvidia'>('openai');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const request = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  const last = turns.at(-1);
  const pending = Boolean(last && !last.answer && !last.error);
  const available = mode !== 'demo' && (health === 'available' || health === 'incomplete');
  const scope = JSON.stringify([site?.properties.site_id, city?.id, period, solar?.id, solar?.source_id, simulation, zonePlan]);

  useEffect(() => {
    if (!open || mode === 'demo') return;
    const controller = new AbortController();
    setHealth('checking');
    getAssistantHealth(controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setHealth(result.status);
        setNvidia(result.nvidia_model ?? null);
        if (!result.nvidia_model) setProvider('openai');
      }
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
      provider, language, question: prompt, site_id: site?.properties.site_id, city_id: city?.id, city_period: period, session_id: sessionId,
      ...assistantSolarContext(solar),
      comparison: simulation?.comparison, selected_scenario_id: simulation?.scenarioId,
      simulation_revision: simulation?.revision, simulation_pending: simulation?.pending,
      telemetry: simulation?.telemetry, zone_plan: zonePlan,
    }, controller.signal).then((answer) => finish({ ...turn, answer })).catch((error) => {
      const message = error instanceof ApiError && error.status === 429
        ? 'The assistant is busy. Try again shortly.' : 'The assistant could not answer. Try again in a moment.';
      finish({ ...turn, error: message });
    });
  };

  if (!open) return null;
  return <Modal title="Mizuho assistant" icon={<Sparkles size={23} />} close={close} kind="assistant-modal">
    <div className="assistant-header">
      <span className="assistant-site">{city?.name ?? site?.properties.label}</span>
      <span className="assistant-context">{city ? 'City archive and evidence' : zonePlan ? 'Regional comparison available' :
        simulation?.comparison ? 'Current comparison available' : 'Site and evidence'}</span>
      {period && <span className="assistant-context">{dateLabel(period.start)} – {dateLabel(period.end)}</span>}
      {available && health === 'incomplete' && <span className="assistant-context">Evidence index incomplete</span>}
      {available && nvidia && <label className="field"><span>Answer model</span>
        <select disabled={pending} value={provider} onChange={(e) => setProvider(e.target.value === 'nvidia' ? 'nvidia' : 'openai')}>
          <option value="openai">OpenAI · GPT-6 Luna</option><option value="nvidia">NVIDIA · Nemotron 3.5 Lightning</option>
        </select></label>}
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
          <h3>{city || site?.properties.field_zone ? `Ask about ${city?.name ?? site?.properties.label}` : 'Ask about a plan or its evidence'}</h3>
          <p>{city || site?.properties.field_zone ? 'Explore archived climate, sampled terrain, and the data needed to plan irrigation.' :
            'Explore the assumptions, official sources, or trade-offs behind an irrigation decision.'}</p>
          <div className="assistant-suggestions">{(city ? citySuggestions : zonePlan ? ['Why did the two sectors receive these volumes?', ...fieldZoneSuggestions] : site?.properties.field_zone ? fieldZoneSuggestions :
            site?.properties.survey_available ? surveySuggestions : suggestions).map((suggestion) =>
            <button key={suggestion} type="button" onClick={() => send(translate(suggestion, language))}>{suggestion}</button>)}</div>
        </div>}
      {turns.map((turn, index) => <article key={index} className="assistant-turn">
          <p className="assistant-question" translate="no">{turn.question}</p>
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
