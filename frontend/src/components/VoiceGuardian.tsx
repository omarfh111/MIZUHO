import { AudioLines, BellRing, Check, Languages, MessageSquareText, Presentation, Send, ShieldCheck, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLanguage, type Language } from '../i18n/language.ts';
import type { Comparison, CompareRequest, RegionalPlanningResult, RegionPlanContext, RegionPlanRequest } from '../types.ts';
import type { ReplayContext } from '../twin.ts';
import { Modal } from './EvidencePanel.tsx';
import GuardianMicrophone from './GuardianMicrophone.tsx';
import './voice-guardian.css';

export interface GuardianContext {
  site_id?: string;
  city_id?: string;
  city_period?: { start: string; end: string };
  comparison?: CompareRequest;
  telemetry?: ReplayContext;
  zone_plan?: RegionPlanContext;
}
type Reason = 'emergency' | 'clarification' | 'accessibility';
export interface GuardianOffer { id: string; reason: Exclude<Reason, 'accessibility'>; context?: GuardianContext }
export type GuardianConfirmation =
  | { id: string; comparison: CompareRequest; result: Comparison }
  | { id: string; zone_inputs: RegionPlanRequest; zone_result: RegionalPlanningResult };
interface Proposal { id: string; quota_m3: number; previous_quota_m3: number; delivered_on_time_m3: number | null }
type SpeechLanguage = Language;
type Activity = 'ask' | 'present' | 'translate';
const languageNames = { en: 'English', ja: '日本語', aeb: 'تونسي' };
const languageTags = { en: 'en', ja: 'ja', aeb: 'aeb-TN' };
const speechLanguages: SpeechLanguage[] = ['en', 'ja', 'aeb'];
function languageOptions(exclude?: SpeechLanguage) {
  return speechLanguages.filter(id => id !== exclude).map(id =>
    <option key={id} value={id} lang={languageTags[id]} translate="no">{languageNames[id]}</option>);
}
interface Entry { speaker: 'guardian' | 'farmer'; text: string; language: SpeechLanguage; citations?: { title: string; url: string }[] }
interface Capabilities { stt: boolean; tts: boolean; llm: boolean }
type ServerMessage =
  | { type: 'ready'; text: string; voice: Capabilities; requires_manager_code?: boolean }
  | { type: 'language'; language: SpeechLanguage; voice: Capabilities }
  | { type: 'reply'; text: string; language?: SpeechLanguage; speech_available?: boolean; citations?: Entry['citations']; proposal?: Proposal }
  | { type: 'recorded' | 'transcript'; text: string }
  | { type: 'audio'; mime: string; data: string }
  | { type: 'error'; code: string; request_type?: string; text: string }
  | ({ type: 'confirmed' } & GuardianConfirmation);

interface Call { context: GuardianContext; reason: Reason; language: SpeechLanguage }
const reasonLabels: Record<Reason, string> = {
  accessibility: 'Voice assistant', clarification: 'Field clarification', emergency: 'Urgent replay alert',
};
const idleCapabilities = { stt: false, tts: false, llm: false };

function GuardianCall({ call, close, onConfirm }: {
  call: Call; close: () => void; onConfirm?: (value: GuardianConfirmation) => void;
}) {
  const [connection, setConnection] = useState<'connecting' | 'active' | 'closed'>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [capabilities, setCapabilities] = useState(idleCapabilities);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [activity, setActivity] = useState<Activity>('ask');
  const [language, setLanguage] = useState<SpeechLanguage>(call.language);
  const [target, setTarget] = useState<SpeechLanguage>(call.language === 'en' ? 'ja' : 'en');
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const ignoreAudio = useRef(false);
  const sourceLanguage = useRef(call.language);
  const [observation, setObservation] = useState('');
  const [quota, setQuota] = useState('');
  const [pending, setPending] = useState(false);
  const [proposal, setProposal] = useState<Proposal>();
  const [audioSrc, setAudioSrc] = useState('');
  const [muted, setMuted] = useState(false);
  const [recordingObservation, setRecordingObservation] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [requiresManagerCode, setRequiresManagerCode] = useState(false);
  const managerCode = useRef<HTMLInputElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const speaker = useRef<HTMLAudioElement>(null);
  const approval = useRef('');
  const confirmHandler = useRef(onConfirm);
  const mute = useRef(false);
  const capturing = useRef(false);
  const duplicateTurn = useRef(false);
  const [deviceVoices, setDeviceVoices] = useState<SpeechSynthesisVoice[]>([]);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const active = connection === 'active';
  const busy = pending || !active;
  const currentQuota = call.context.comparison?.state.quota_remaining_m3 ?? call.context.zone_plan?.inputs.withdrawal_limit_m3;
  const lastReply = entries.filter(entry => entry.speaker === 'guardian').at(-1);
  const deviceVoice = lastReply && deviceVoices.find(voice => {
    const locale = voice.lang.toLowerCase();
    return voice.localService && (lastReply.language === 'aeb' ? locale.startsWith('aeb') || locale === 'ar-tn' :
      locale.split('-')[0] === lastReply.language);
  });
  const lastFarmer = entries.filter(entry => entry.speaker === 'farmer').at(-1);
  useEffect(() => { confirmHandler.current = onConfirm; }, [onConfirm]);

  const stopPlayback = () => {
    speaker.current?.pause();
    if (utterance.current) { window.speechSynthesis?.cancel(); utterance.current = null; }
  };
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const refresh = () => setDeviceVoices(synth.getVoices());
    refresh();
    synth.addEventListener('voiceschanged', refresh);
    return () => synth.removeEventListener('voiceschanged', refresh);
  }, []);
  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [entries]);

  useEffect(() => {
    const address = new URL('/api/guardian/call', location.href);
    address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const channel = new WebSocket(address);
    socket.current = channel;
    let alive = true;
    let tts = false;
    let ready = false;
    const connectDeadline = setTimeout(() => { if (!ready) channel.close(); }, 25_000);
    const append = (entry: Entry) => setEntries(previous => [...previous.slice(-59), entry]);
    function settle() { duplicateTurn.current = false; setPending(false); }
    function readAloud(available: boolean) {
      setAudioSrc('');
      setSpeechAvailable(available);
      ignoreAudio.current = false;
      if (available && !mute.current && !capturing.current && channel.readyState === WebSocket.OPEN) channel.send(JSON.stringify({ type: 'speak' }));
    }
    channel.onopen = () => {
      if (alive) channel.send(JSON.stringify({ type: 'start', ...call.context, reason: call.reason, language: sourceLanguage.current }));
    };
    channel.onmessage = event => {
      if (!alive || typeof event.data !== 'string') return;
      let reply: ServerMessage;
      try { reply = JSON.parse(event.data); } catch { setError('The assistant received an unreadable response.'); return; }
      if (reply.type === 'ready') {
        ready = true;
        clearTimeout(connectDeadline);
        setConnection('active');
        setCapabilities(reply.voice);
        setRequiresManagerCode(reply.requires_manager_code === true);
        tts = reply.voice.tts;
        append({ speaker: 'guardian', text: reply.text, language: sourceLanguage.current });
        setSpeechAvailable(tts);
        if (call.reason !== 'accessibility') readAloud(tts);
      } else if (reply.type === 'language') {
        settle();
        sourceLanguage.current = reply.language;
        setLanguage(reply.language);
        setTarget(previous => previous === reply.language ? (reply.language === 'en' ? 'ja' : 'en') : previous);
        setCapabilities(reply.voice);
        tts = reply.voice.tts;
        setSpeechAvailable(false);
      } else if (reply.type === 'transcript') {
        append({ speaker: 'farmer', text: reply.text, language: sourceLanguage.current });
      } else if (reply.type === 'reply' || reply.type === 'recorded') {
        settle();
        append({ speaker: 'guardian', text: reply.text, language: reply.type === 'reply' && reply.language || sourceLanguage.current,
          citations: reply.type === 'reply' ? reply.citations : undefined });
        if (reply.type === 'reply' && reply.proposal) setProposal(reply.proposal);
        if (reply.type === 'recorded') { setProposal(undefined); approval.current = ''; }
        readAloud(reply.type === 'reply' ? reply.speech_available ?? tts : tts);
      } else if (reply.type === 'audio') {
        if (!ignoreAudio.current && !mute.current && !capturing.current && typeof reply.data === 'string' && /^audio\/(wav|x-wav|wave|mpeg|mp3|ogg|webm|mp4)(;|$)/i.test(reply.mime)) {
          setAudioSrc(`data:${reply.mime};base64,${reply.data}`);
        }
      } else if (reply.type === 'error') {
        if (reply.request_type === 'speak' || reply.code === 'tts_unavailable') {
          setSpeechAvailable(false);
        } else {
          settle();
          approval.current = '';
          if (reply.code === 'stale_proposal') setProposal(undefined);
        }
        setError(reply.text);
      } else if (reply.type === 'confirmed' && approval.current === reply.id) {
        approval.current = '';
        settle();
        setConfirmed(true);
        setProposal(undefined);
        confirmHandler.current?.(reply);
      }
    };
    channel.onclose = channel.onerror = () => {
      if (!alive) return;
      setConnection('closed');
      settle();
      stopPlayback();
      setAudioSrc('');
      setError(current => current || 'The assistant disconnected. Reconnect to start a new session.');
    };
    return () => {
      alive = false;
      clearTimeout(connectDeadline);
      approval.current = '';
      socket.current = null;
      if (channel.readyState === WebSocket.OPEN) channel.send(JSON.stringify({ type: 'end' }));
      channel.close();
      stopPlayback();
    };
  }, [call, attempt]);

  function post(message: object, wait = true) {
    if (!active || !socket.current || socket.current.readyState !== WebSocket.OPEN || (wait && duplicateTurn.current)) return false;
    setError('');
    if (wait) { duplicateTurn.current = true; setPending(true); }
    socket.current.send(JSON.stringify(message));
    return true;
  }
  function mutePlayback() {
    mute.current = !mute.current;
    setMuted(mute.current);
    if (mute.current) { stopPlayback(); setAudioSrc(''); } else post({ type: 'speak' }, false);
  }
  function reconnect() {
    setProposal(undefined); setEntries([]); setConfirmed(false); setError('');
    setObservation(''); setRecordingObservation(false); setDraft(''); setQuota('');
    setConnection('connecting'); setCapabilities(idleCapabilities); setRequiresManagerCode(false); setAttempt(value => value + 1);
  }
  function changeLanguage(next: SpeechLanguage) {
    if (next === language || !post({ type: 'language', language: next })) return;
    ignoreAudio.current = true;
    stopPlayback(); setAudioSrc('');
  }
  const turn = { mode: activity, ...(activity === 'translate' && { target_language: target }) };
  const inputLabel = activity === 'translate' ? 'Text to translate' : activity === 'present' ? 'Presentation focus (optional)' : 'Message';
  const submitLabel = activity === 'translate' ? 'Translate text' : activity === 'present' ? 'Prepare my presentation' : 'Send message';
  return <Modal title="Voice Guardian" icon={<AudioLines size={24} />} close={close} kind="guardian-modal">
    {(call.reason !== 'accessibility' || call.context.telemetry) && <div className="guardian-call-meta">
      {call.reason !== 'accessibility' && <span className="guardian-chip">{reasonLabels[call.reason]}</span>}
      {call.context.telemetry && <span>{String(call.context.telemetry.selected_slot).padStart(2, '0')}:00</span>}</div>}
    <div className="guardian-call-body">
      {connection === 'connecting' && <p role="status" className="guardian-status">Opening the assistant…</p>}
      {active && !capabilities.llm && <p className="guardian-note">Guided mode uses verified simulator data. Open conversation needs the AI service.</p>}
      {active && <>
        <div className="guardian-modes" role="group" aria-label="Assistant tools">
          {([{ id: 'ask', label: 'Ask', Icon: MessageSquareText }, { id: 'present', label: 'Present', Icon: Presentation },
            { id: 'translate', label: 'Translate', Icon: Languages }] as const).map(({ id, label, Icon }) =>
            <button type="button" key={id} aria-pressed={activity === id} disabled={busy} onClick={() => setActivity(id)}>
              <Icon size={16} aria-hidden="true"/>{label}</button>)}
        </div>
        <div className="guardian-languages">
          <label className="field"><span>Speaking language</span>
            <select value={language} disabled={busy} onChange={event => changeLanguage(event.target.value as SpeechLanguage)}>{languageOptions()}</select></label>
          {activity === 'translate' && <label className="field"><span>Translate into</span>
            <select value={target} disabled={busy} onChange={event => setTarget(event.target.value as SpeechLanguage)}>{languageOptions(language)}</select></label>}
        </div>
        {(language === 'aeb' || activity === 'translate' && target === 'aeb') && <p className="guardian-note">Tunisian speech is experimental. Check the transcript, especially names and numbers.</p>}
      </>}
      <div className="guardian-transcript" ref={transcript} role="log" aria-label="Conversation" aria-live="polite">
        {entries.map((entry, index) => <div className={`guardian-turn ${entry.speaker}`} key={index}>
          <strong>{entry.speaker === 'guardian' ? 'Voice Guardian' : 'You'}</strong>
          <p lang={languageTags[entry.language]} dir="auto" translate="no">{entry.text}</p>
          {entry.citations?.filter(source => /^https?:\/\//i.test(source.url)).map(source =>
            <a href={source.url} key={source.url} target="_blank" rel="noreferrer" translate="no">{source.title} ↗</a>)}
        </div>)}
      </div>
      {error && <p role="alert" className="guardian-notice">{error}</p>}
      {active && <div className="guardian-playback">
        {speechAvailable && !muted && !audioSrc && lastReply && entries.length === 1 && call.reason === 'accessibility' &&
          <button type="button" className="text-button" disabled={busy} onClick={() => post({ type: 'speak' }, false)}>
            <Volume2 size={15} />Listen to introduction</button>}
        {speechAvailable ? <button type="button" className="text-button" aria-pressed={!muted} onClick={mutePlayback}>
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}{muted ? 'Enable voice replies' : 'Mute voice replies'}</button>
          : deviceVoice && lastReply ? <button type="button" className="text-button" onClick={() => {
            stopPlayback();
            const speech = new SpeechSynthesisUtterance(lastReply.text);
            speech.voice = deviceVoice; speech.lang = deviceVoice.lang; utterance.current = speech;
            window.speechSynthesis.speak(speech);
          }}><Volume2 size={15} />Read aloud with device voice</button> : lastReply && !ignoreAudio.current ? <p className="guardian-note">Voice playback is unavailable for this reply.</p> : null}
        {audioSrc && <audio key={audioSrc} ref={speaker} src={audioSrc} autoPlay controls aria-label="Spoken reply" />}
      </div>}
      {active && <>
        {capabilities.stt ? <GuardianMicrophone key={`${language}/${activity}/${activity === 'translate' ? target : ''}`} disabled={busy || (activity === 'translate' && !capabilities.llm)} onCapture={enabled => {
          capturing.current = enabled;
          if (enabled) stopPlayback();
        }} onSend={(mime, data) => post({ type: 'audio', mime, data, ...turn })} />
          : <p className="guardian-note">Voice transcription is unavailable. Type your message below.</p>}
        <form className="guardian-compose" onSubmit={e => {
          e.preventDefault();
          const text = draft.trim();
          if ((text || activity === 'present') && post({ type: 'message', text, ...turn })) {
            if (text) setEntries(previous => [...previous.slice(-59), { speaker: 'farmer', text, language }]);
            setDraft('');
          }
        }}><label className="field"><span>{inputLabel}</span><textarea maxLength={1200} rows={2} value={draft} dir="auto"
          placeholder={activity === 'present' ? 'What would you like the audience to remember?' : activity === 'translate' ? 'Speak or paste your passage here.' : 'What would you like me to explain?'}
          onChange={e => setDraft(e.target.value)} /></label>
          {activity === 'translate' && !capabilities.llm && <small className="guardian-note">Translation needs a connected language model.</small>}
          <button type="submit" className="button button-primary" disabled={busy || (!draft.trim() && activity !== 'present') || (activity === 'translate' && !capabilities.llm)}><Send size={15} />{submitLabel}</button>
        </form>
        {pending && <p role="status" className="guardian-note">Checking your request…</p>}
        {activity === 'ask' && call.context.site_id && <button type="button" className="text-button" aria-expanded={recordingObservation} onClick={() => setRecordingObservation(!recordingObservation)}>
          <MessageSquareText size={15} />Record observation</button>}
        {activity === 'ask' && call.context.site_id && recordingObservation && <form className="guardian-review" onSubmit={e => {
          e.preventDefault(); if (observation.trim() && post({ type: 'observation', text: observation.trim() })) {
            setEntries(previous => [...previous.slice(-59), { speaker: 'farmer', text: observation.trim(), language }]);
            setObservation(''); setRecordingObservation(false);
          }
        }}><label className="field"><span>Field observation</span><textarea value={observation} maxLength={1200} rows={2} onChange={e => setObservation(e.target.value)} /></label>
          <p className="guardian-note">Your observation stays in this session. Field measurements need separate verification.</p>
          {lastFarmer && <button type="button" className="text-button" onClick={() => setObservation(lastFarmer.text)}>Use my last message</button>}
          <button type="submit" className="button button-secondary" disabled={busy || !observation.trim()}>Save observation</button>
        </form>}
        {activity === 'ask' && currentQuota !== undefined && currentQuota > 0 && !confirmed && <details className="guardian-review">
          <summary>Review a new quota</summary>
          <form onSubmit={e => { e.preventDefault(); if (quota !== '' && post({ type: 'propose', quota_m3: Number(quota) })) setProposal(undefined); }}>
            <label className="field"><span>Proposed withdrawal limit (m³)</span><input type="number" min={0} max={Math.ceil(currentQuota) - 1} step={1}
              value={quota} required onChange={e => { setQuota(e.target.value); setProposal(undefined); }} /></label>
            <button type="submit" className="button button-secondary" disabled={busy || quota.trim() === ''}>Calculate proposal</button>
          </form></details>}
        {activity === 'ask' && proposal && <section className="guardian-proposal" aria-label="Proposed simulated plan">
          <h3><ShieldCheck size={17} />Manager review</h3>
          <dl><div><dt>Withdrawal limit</dt><dd>{proposal.previous_quota_m3} → {proposal.quota_m3} m³</dd></div>
            <div><dt>Delivered on time</dt><dd>{proposal.delivered_on_time_m3 ?? '—'} m³</dd></div></dl>
          <p className="guardian-note">Only the responsible manager should confirm this simulated change.</p>
          {onConfirm && <form key={proposal.id} className="guardian-approval" autoComplete="off" onSubmit={e => {
            e.preventDefault();
            const input = managerCode.current;
            if (requiresManagerCode && !input?.value) return;
            if (post({ type: 'confirm', id: proposal.id, ...(requiresManagerCode && { manager_code: input?.value }) })) approval.current = proposal.id;
            if (input) input.value = '';
          }}>
            {requiresManagerCode && <label className="field"><span>Manager approval code</span><input required ref={managerCode} type="password"
              autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} /></label>}
            <button type="submit" className="button button-primary" disabled={busy}><Check size={16} />Confirm simulated plan</button>
          </form>}
        </section>}
        {confirmed && <p role="status">Simulated plan confirmed.</p>}
      </>}
      {connection === 'closed' && <button type="button" className="button button-secondary" onClick={reconnect}>Reconnect</button>}
    </div>
    <div className="guardian-call-footer"><button type="button" className="button button-secondary" onClick={close}>Done</button></div>
  </Modal>;
}

export default function VoiceGuardian({ context, incoming, onConfirm }: {
  context: GuardianContext; incoming?: GuardianOffer | null; onConfirm?: (value: GuardianConfirmation) => void;
}) {
  const [call, setCall] = useState<Call>();
  const language: SpeechLanguage = useLanguage();
  const [handled, setHandled] = useState<string[]>([]);
  const offer = incoming && !handled.includes(incoming.id) ? incoming : null;
  function handleOffer(accept: boolean) {
    if (!offer) return;
    setHandled(previous => [...previous.slice(-99), offer.id]);
    if (accept) setCall({ context: offer.context ?? context, reason: offer.reason, language });
  }
  return <>
    {!call && <button type="button" className="guardian-launch button button-secondary" aria-haspopup="dialog"
      onClick={() => setCall({ context, reason: 'accessibility', language })}><AudioLines size={17} aria-hidden="true"/><span>Voice assistant</span></button>}
    {!call && offer && <section className="guardian-incoming" aria-label="Guardian alert">
      <div className="guardian-incoming-head"><span className="guardian-phone-mark"><BellRing size={21} /></span>
        <div><small>Voice Guardian</small><h2 role="status">{reasonLabels[offer.reason]}</h2></div></div>
      <p>{offer.reason === 'emergency' ? 'The simulator flagged an event. We can check what happened together.'
        : 'A reading or planning input is missing. Can you help check it?'}</p>
      <div className="guardian-actions"><button type="button" className="button button-primary" onClick={() => handleOffer(true)}>Explain alert</button>
        <button type="button" className="button button-secondary" onClick={() => handleOffer(false)}>Dismiss</button></div>
    </section>}
    {call && <GuardianCall call={call} close={() => setCall(undefined)} onConfirm={onConfirm} />}
  </>;
}
