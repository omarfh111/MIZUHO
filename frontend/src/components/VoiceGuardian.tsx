import { AudioLines, BellRing, BookOpen, Check, Languages, MessageSquareText, Mic, MicOff, Presentation, Send, ShieldCheck, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useLanguage, type Language } from '../i18n/language.ts';
import type { AssistantAnswer, Citation, Comparison, CompareRequest, RegionalPlanningResult, RegionPlanContext, RegionPlanRequest } from '../types.ts';
import type { ReplayContext } from '../twin.ts';
import { Modal } from './EvidencePanel.tsx';
import GuardianMicrophone from './GuardianMicrophone.tsx';
import GuardianOrb, { type GuardianOrbState } from './GuardianOrb.tsx';
import { useGuardianLiveVoice, type GuardianActivity } from './useGuardianLiveVoice.ts';
import { Metric, SourceCitation } from './AssistantEvidence.tsx';
import './voice-guardian.css';

export interface GuardianContext {
  site_id?: string;
  city_id?: string;
  city_period?: { start: string; end: string };
  comparison?: CompareRequest;
  telemetry?: ReplayContext;
  zone_plan?: RegionPlanContext;
  solar_option_id?: string;
  pvgis_option_id?: 'ombriere' | 'toiture';
  selected_scenario_id?: string;
  simulation_pending?: boolean;
}
type Reason = 'emergency' | 'clarification' | 'accessibility';
export interface GuardianOffer { id: string; reason: Exclude<Reason, 'accessibility'>; context?: GuardianContext }
export type GuardianConfirmation =
  | { id: string; comparison: CompareRequest; result: Comparison }
  | { id: string; zone_inputs: RegionPlanRequest; zone_result: RegionalPlanningResult };
interface Proposal { id: string; quota_m3: number; previous_quota_m3: number; delivered_on_time_m3: number | null }
type SpeechLanguage = Language;
const activities = {
  ask: { label: 'Chat', Icon: MessageSquareText, input: 'Message', submit: 'Send message', placeholder: 'What would you like to work on?' },
  present: { label: 'Present', Icon: Presentation, input: 'Presentation focus (optional)', submit: 'Prepare my presentation', placeholder: 'What would you like the audience to remember?' },
  translate: { label: 'Translate', Icon: Languages, input: 'Text to translate', submit: 'Translate text', placeholder: 'Speak or paste your passage here.' },
  evidence: { label: 'Sources', Icon: BookOpen, input: 'Research question', submit: 'Find sources', placeholder: 'Which claim would you like to check?' },
} satisfies Record<GuardianActivity, { label: string; Icon: typeof BookOpen; input: string; submit: string; placeholder: string }>;
const activityOrder: GuardianActivity[] = ['ask', 'present', 'translate', 'evidence'];
const languageNames = { en: 'English', ja: '日本語', aeb: 'تونسي' };
const languageTags = { en: 'en', ja: 'ja', aeb: 'aeb-TN' };
const speechLanguages: SpeechLanguage[] = ['en', 'ja', 'aeb'];
function languageOptions(exclude?: SpeechLanguage) {
  return speechLanguages.filter(id => id !== exclude).map(id =>
    <option key={id} value={id} lang={languageTags[id]} translate="no">{languageNames[id]}</option>);
}
type Source = Pick<Citation, 'title' | 'url'> & Partial<Citation>;
interface Entry {
  speaker: 'guardian' | 'farmer'; text: string; language: SpeechLanguage;
  citations?: Source[]; facts?: AssistantAnswer['facts']; gaps?: string[];
}
interface Capabilities { stt: boolean; tts: boolean; llm: boolean }
type ServerMessage =
  | { type: 'ready'; text: string; voice: Capabilities; requires_manager_code?: boolean }
  | { type: 'language'; language: SpeechLanguage; voice: Capabilities }
  | { type: 'reply'; text: string; language?: SpeechLanguage; speech_available?: boolean; citations?: Source[];
      facts?: Entry['facts']; missing_information?: string[]; proposal?: Proposal }
  | { type: 'recorded' | 'transcript'; text: string }
  | { type: 'progress'; text: string }
  | { type: 'audio'; mime: string; data: string; phase?: 'preview' | 'final' }
  | { type: 'audio_chunk'; data: string; sample_rate: number }
  | { type: 'audio_end'; phase: 'preview' | 'final'; partial?: boolean }
  | { type: 'error'; code: string; request_type?: string; text: string }
  | ({ type: 'confirmed' } & GuardianConfirmation);

interface Call { context: GuardianContext; reason: Reason; language: SpeechLanguage }
const reasonLabels: Record<Reason, string> = {
  accessibility: 'Voice assistant', clarification: 'Field clarification', emergency: 'Urgent replay alert',
};
const idleCapabilities = { stt: false, tts: false, llm: false };

function GuardianCall({ call, close, onConfirm, liveLaunch }: {
  call: Call; close: () => void; onConfirm?: (value: GuardianConfirmation) => void; liveLaunch: Ref<() => void>;
}) {
  const [connection, setConnection] = useState<'connecting' | 'active' | 'closed'>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [capabilities, setCapabilities] = useState(idleCapabilities);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [activity, setActivity] = useState<GuardianActivity>('ask');
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
  const [manualRecording, setManualRecording] = useState(false);
  const [manualSpeaking, setManualSpeaking] = useState(false);
  const duplicateTurn = useRef(false);
  const [deviceVoices, setDeviceVoices] = useState<SpeechSynthesisVoice[]>([]);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const active = connection === 'active';
  const live = useGuardianLiveVoice(socket, activity, target, setError);
  const isLive = live.phase !== 'off';
  const busy = pending || !active || (isLive && live.phase !== 'listening');
  function orbState(): GuardianOrbState {
    if (connection === 'closed') return 'unavailable';
    if (connection === 'connecting' || live.phase === 'permission') return 'connecting';
    if (live.phase !== 'off') return live.phase;
    if (manualRecording) return 'hearing';
    if (pending) return 'thinking';
    if (manualSpeaking) return 'speaking';
    return live.paused ? 'paused' : 'idle';
  }
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
    setManualSpeaking(false);
    if (utterance.current) { window.speechSynthesis?.cancel(); utterance.current = null; }
  };
  function startLive() {
    stopPlayback();
    ignoreAudio.current = true;
    mute.current = false;
    setMuted(false);
    setAudioSrc('');
    live.start();
  }
  useImperativeHandle(liveLaunch, () => startLive);
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
      let reply: ServerMessage & { turn_id?: number };
      try { reply = JSON.parse(event.data); } catch { setError('The assistant received an unreadable response.'); return; }
      const id = reply.turn_id;
      if (id !== undefined && !live.accepts(id)) return;
      if (reply.type === 'ready') {
        ready = true;
        clearTimeout(connectDeadline);
        setConnection('active');
        setCapabilities(reply.voice);
        setRequiresManagerCode(reply.requires_manager_code === true);
        tts = reply.voice.tts;
        live.ready(reply.voice.stt);
        append({ speaker: 'guardian', text: reply.text, language: sourceLanguage.current });
        setSpeechAvailable(tts);
        if (call.reason !== 'accessibility') readAloud(tts);
      } else if (reply.type === 'language') {
        settle();
        sourceLanguage.current = reply.language;
        setLanguage(reply.language);
        setTarget(previous => previous === reply.language ? (reply.language === 'en' ? 'ja' : 'en') : previous);
        setCapabilities(reply.voice);
        live.ready(reply.voice.stt);
        tts = reply.voice.tts;
        setSpeechAvailable(false);
      } else if (reply.type === 'transcript') {
        append({ speaker: 'farmer', text: reply.text, language: sourceLanguage.current });
      } else if (reply.type === 'progress' && id !== undefined) {
        live.setPreview(reply.text);
      } else if (reply.type === 'audio_chunk' && id !== undefined && reply.sample_rate === 24_000) {
        live.chunk(id, reply.data);
      } else if (reply.type === 'audio_end' && id !== undefined) {
        if (reply.partial) setError('Part of the audio was interrupted. The answer is available in the transcript.');
        live.endAudio(id, reply.phase === 'preview');
      } else if (reply.type === 'reply' || reply.type === 'recorded') {
        settle();
        append({ speaker: 'guardian', text: reply.text, language: reply.type === 'reply' && reply.language || sourceLanguage.current,
          ...(reply.type === 'reply' && { citations: reply.citations, facts: reply.facts, gaps: reply.missing_information }) });
        if (reply.type === 'reply' && reply.proposal) setProposal(reply.proposal);
        if (reply.type === 'recorded') { setProposal(undefined); approval.current = ''; }
        const available = reply.type === 'reply' ? reply.speech_available ?? tts : tts;
        if (id !== undefined) { setSpeechAvailable(available); live.read(id, available && !mute.current); }
        else readAloud(available);
      } else if (reply.type === 'audio') {
        if (id !== undefined) {
          if (!mute.current) live.play(id, reply.mime, reply.data, reply.phase === 'preview');
          else live.finished(id);
        } else if (!live.controller.current && !ignoreAudio.current && !mute.current && !capturing.current && typeof reply.data === 'string' && /^audio\/(wav|x-wav|wave|mpeg|mp3|ogg|webm|mp4)(;|$)/i.test(reply.mime)) {
          setAudioSrc(`data:${reply.mime};base64,${reply.data}`);
        }
      } else if (reply.type === 'error') {
        if (id !== undefined) live.finished(id);
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
      live.disconnect();
      stopPlayback();
      setAudioSrc('');
      setError(current => current || 'The assistant disconnected. Reconnect to start a new session.');
    };
    return () => {
      alive = false;
      clearTimeout(connectDeadline);
      approval.current = '';
      live.disconnect();
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
    setActivity('ask');
    setObservation(''); setRecordingObservation(false); setDraft(''); setQuota('');
    setConnection('connecting'); setCapabilities(idleCapabilities); setRequiresManagerCode(false); setAttempt(value => value + 1);
  }
  function changeLanguage(next: SpeechLanguage) {
    if (next === language || !post({ type: 'language', language: next })) return;
    ignoreAudio.current = true;
    stopPlayback(); setAudioSrc('');
  }
  const turn = { mode: activity, ...(activity === 'translate' && { target_language: target }) };
  const { input: inputLabel, submit: submitLabel, placeholder } = activities[activity];
  return <Modal title="Voice Guardian" icon={<AudioLines size={24} />} close={close} kind="guardian-modal">
    {(call.reason !== 'accessibility' || call.context.telemetry) && <div className="guardian-call-meta">
      {call.reason !== 'accessibility' && <span className="guardian-chip">{reasonLabels[call.reason]}</span>}
      {call.context.telemetry && <span>{String(call.context.telemetry.selected_slot).padStart(2, '0')}:00</span>}</div>}
    <div className="guardian-call-body">
      <GuardianOrb state={orbState()} levelRef={live.level} />
      {live.preview && <p className="guardian-live-preview" lang={languageTags[language]} dir="auto" translate="no">{live.preview}</p>}
      {(isLive || active && capabilities.stt) && <div className="guardian-live-controls">
        {isLive ? <button type="button" className="button button-secondary" onClick={live.stop}>
          <MicOff size={16} />Pause microphone</button> : <button type="button" className="button button-primary" disabled={busy || manualRecording}
          onClick={startLive}><Mic size={16} />{live.paused ? 'Resume live voice' : 'Start live voice'}</button>}
        <p className="guardian-note">{isLive ? 'Speak freely. Pause for an answer, or interrupt by speaking again.'
          : 'Live voice sends each phrase for transcription after you pause.'}</p>
      </div>}
      {connection === 'connecting' && <p role="status" className="guardian-status">Opening the assistant…</p>}
      {active && <>
        <div className="guardian-modes" role="group" aria-label="Assistant tools">
          {activityOrder.map(id => {
            const { label, Icon } = activities[id];
            return <button type="button" key={id} aria-pressed={activity === id} disabled={busy} onClick={() => setActivity(id)}>
              <Icon size={16} aria-hidden="true"/>{label}</button>;
          })}
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
            source.id && source.excerpt && source.organization
              ? <SourceCitation citation={source as Citation} key={source.id} />
              : <a href={source.url} key={source.id ?? source.url} target="_blank" rel="noreferrer" translate="no">{source.title} ↗</a>)}
          {!!entry.facts?.length && <details className="guardian-facts"><summary>Supporting data</summary>
            {entry.facts.map(fact => <Metric fact={fact} key={fact.id} />)}</details>}
          {!!entry.gaps?.length && <details className="guardian-facts"><summary>Missing information</summary>
            <ul>{entry.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></details>}
        </div>)}
      </div>
      {error && <p role="alert" className="guardian-notice">{error}</p>}
      {active && !isLive && <div className="guardian-playback">
        {speechAvailable && !muted && !audioSrc && lastReply && entries.length === 1 && call.reason === 'accessibility' &&
          <button type="button" className="text-button" disabled={busy} onClick={() => post({ type: 'speak' }, false)}>
            <Volume2 size={15} />Listen to introduction</button>}
        {speechAvailable ? <button type="button" className="text-button" aria-pressed={!muted} onClick={mutePlayback}>
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}{muted ? 'Enable voice replies' : 'Mute voice replies'}</button>
          : deviceVoice && lastReply ? <button type="button" className="text-button" onClick={() => {
            stopPlayback();
            const speech = new SpeechSynthesisUtterance(lastReply.text);
            speech.voice = deviceVoice; speech.lang = deviceVoice.lang; utterance.current = speech;
            speech.onstart = () => setManualSpeaking(true);
            speech.onend = speech.onerror = () => setManualSpeaking(false);
            window.speechSynthesis.speak(speech);
          }}><Volume2 size={15} />Read aloud with device voice</button> : lastReply && !ignoreAudio.current ? <p className="guardian-note">Voice playback is unavailable for this reply.</p> : null}
        {audioSrc && <audio key={audioSrc} ref={speaker} src={audioSrc} autoPlay controls aria-label="Spoken reply"
          onPlaying={() => setManualSpeaking(true)} onPause={() => setManualSpeaking(false)} onEnded={() => setManualSpeaking(false)} />}
      </div>}
      {active && <>
        {!isLive && (capabilities.stt ? <GuardianMicrophone key={`${language}/${activity}/${activity === 'translate' ? target : ''}`} disabled={busy || (activity === 'translate' && !capabilities.llm)} onCapture={enabled => {
          capturing.current = enabled;
          setManualRecording(enabled);
          if (enabled) stopPlayback();
        }} onSend={(mime, data) => post({ type: 'audio', mime, data, ...turn })} />
          : <p className="guardian-note">Voice transcription is unavailable. Type your message below.</p>)}
        {!isLive && <form className="guardian-compose" onSubmit={e => {
          e.preventDefault();
          const text = draft.trim();
          if ((text || activity === 'present') && post({ type: 'message', text, ...turn })) {
            if (text) setEntries(previous => [...previous.slice(-59), { speaker: 'farmer', text, language }]);
            setDraft('');
          }
        }}><label className="field"><span>{inputLabel}</span><textarea maxLength={1200} rows={2} value={draft} dir="auto"
          placeholder={placeholder}
          onChange={e => setDraft(e.target.value)} /></label>
          {activity === 'translate' && !capabilities.llm && <small className="guardian-note">Translation needs a connected language model.</small>}
          <button type="submit" className="button button-primary" disabled={busy || (!draft.trim() && activity !== 'present') || (activity === 'translate' && !capabilities.llm)}><Send size={15} />{submitLabel}</button>
        </form>}
        {pending && <p role="status" className="guardian-note">Checking your request…</p>}
        {!isLive && activity === 'ask' && call.context.site_id && <button type="button" className="text-button" aria-expanded={recordingObservation} onClick={() => setRecordingObservation(!recordingObservation)}>
          <MessageSquareText size={15} />Record observation</button>}
        {!isLive && activity === 'ask' && call.context.site_id && recordingObservation && <form className="guardian-review" onSubmit={e => {
          e.preventDefault(); if (observation.trim() && post({ type: 'observation', text: observation.trim() })) {
            setEntries(previous => [...previous.slice(-59), { speaker: 'farmer', text: observation.trim(), language }]);
            setObservation(''); setRecordingObservation(false);
          }
        }}><label className="field"><span>Field observation</span><textarea value={observation} maxLength={1200} rows={2} onChange={e => setObservation(e.target.value)} /></label>
          <p className="guardian-note">Your observation stays in this session. Field measurements need separate verification.</p>
          {lastFarmer && <button type="button" className="text-button" onClick={() => setObservation(lastFarmer.text)}>Use my last message</button>}
          <button type="submit" className="button button-secondary" disabled={busy || !observation.trim()}>Save observation</button>
        </form>}
        {!isLive && activity === 'ask' && currentQuota !== undefined && currentQuota > 0 && !confirmed && <details className="guardian-review">
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
  const launchLive = useRef<() => void>(null);
  const language: SpeechLanguage = useLanguage();
  const [handled, setHandled] = useState<string[]>([]);
  const offer = incoming && !handled.includes(incoming.id) ? incoming : null;
  function handleOffer(accept: boolean) {
    if (!offer) return;
    setHandled(previous => [...previous.slice(-99), offer.id]);
    if (accept) setCall({ context: offer.context ?? context, reason: offer.reason, language });
  }
  const dock = document.getElementById('live-voice-launcher');
  const liveButton = <button type="button" className="button guardian-live-launch" aria-haspopup="dialog" aria-label="Start live voice"
    title="Live voice sends each phrase for transcription after you pause." onClick={() => {
      // Open the audio device inside the original gesture, including on mobile.
      flushSync(() => setCall({ context, reason: 'accessibility', language }));
      launchLive.current?.();
    }}><AudioLines size={20} aria-hidden="true"/><span>Start live voice</span></button>;
  return <>
    {!call && <div className="guardian-launch">
      {dock ? createPortal(liveButton, dock) : liveButton}
      <button type="button" className="text-button" aria-haspopup="dialog"
        onClick={() => setCall({ context, reason: 'accessibility', language })}><MessageSquareText size={16}/><span>Voice assistant</span></button>
    </div>}
    {!call && offer && <section className="guardian-incoming" aria-label="Guardian alert">
      <div className="guardian-incoming-head"><span className="guardian-phone-mark"><BellRing size={21} /></span>
        <div><small>Voice Guardian</small><h2 role="status">{reasonLabels[offer.reason]}</h2></div></div>
      <p>{offer.reason === 'emergency' ? 'The simulator flagged an event. We can check what happened together.'
        : 'A reading or planning input is missing. Can you help check it?'}</p>
      <div className="guardian-actions"><button type="button" className="button button-primary" onClick={() => handleOffer(true)}>Explain alert</button>
        <button type="button" className="button button-secondary" onClick={() => handleOffer(false)}>Dismiss</button></div>
    </section>}
    {call && <GuardianCall call={call} close={() => setCall(undefined)} onConfirm={onConfirm} liveLaunch={launchLive} />}
  </>;
}
