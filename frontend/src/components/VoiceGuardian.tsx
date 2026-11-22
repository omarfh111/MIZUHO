import { AudioLines, Check, Headphones, MessageSquareText, Phone, PhoneIncoming, PhoneOff, Send, ShieldCheck, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
interface Entry { speaker: 'guardian' | 'farmer'; text: string; citations?: { title: string; url: string }[] }
interface Capabilities { stt: boolean; tts: boolean; llm: boolean }
type ServerMessage =
  | { type: 'ready'; text: string; voice: Capabilities; requires_manager_code?: boolean }
  | { type: 'reply'; text: string; citations?: Entry['citations']; proposal?: Proposal }
  | { type: 'recorded' | 'transcript'; text: string }
  | { type: 'audio'; mime: string; data: string }
  | { type: 'error'; code: string; request_type?: string; text: string }
  | ({ type: 'confirmed' } & GuardianConfirmation);

interface Call { context: GuardianContext; reason: Reason }
const reasonLabels: Record<Reason, string> = {
  accessibility: 'Farmer assistance', clarification: 'Field clarification', emergency: 'Urgent replay alert',
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
  const [deviceVoice, setDeviceVoice] = useState<SpeechSynthesisVoice>();
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const active = connection === 'active';
  const busy = pending || !active;
  const currentQuota = call.context.comparison?.state.quota_remaining_m3 ?? call.context.zone_plan?.inputs.withdrawal_limit_m3;
  const lastReply = entries.filter(entry => entry.speaker === 'guardian').at(-1);
  const lastFarmer = entries.filter(entry => entry.speaker === 'farmer').at(-1);
  useEffect(() => { confirmHandler.current = onConfirm; }, [onConfirm]);

  const stopPlayback = () => {
    speaker.current?.pause();
    if (utterance.current) { window.speechSynthesis?.cancel(); utterance.current = null; }
  };
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const refresh = () => setDeviceVoice(synth.getVoices().find(voice => voice.lang.toLowerCase().startsWith('fr') && voice.localService));
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
    function readAloud() { if (tts && !mute.current && !capturing.current && channel.readyState === WebSocket.OPEN) channel.send(JSON.stringify({ type: 'speak' })); }
    channel.onopen = () => {
      if (alive) channel.send(JSON.stringify({ type: 'start', ...call.context, reason: call.reason, language: 'fr' }));
    };
    channel.onmessage = event => {
      if (!alive || typeof event.data !== 'string') return;
      let reply: ServerMessage;
      try { reply = JSON.parse(event.data); } catch { setError('The call received an unreadable response.'); return; }
      if (reply.type === 'ready') {
        ready = true;
        clearTimeout(connectDeadline);
        setConnection('active');
        setCapabilities(reply.voice);
        setRequiresManagerCode(reply.requires_manager_code === true);
        tts = reply.voice.tts;
        append({ speaker: 'guardian', text: reply.text });
        readAloud();
      } else if (reply.type === 'transcript') {
        append({ speaker: 'farmer', text: reply.text });
      } else if (reply.type === 'reply' || reply.type === 'recorded') {
        settle();
        append({ speaker: 'guardian', text: reply.text, citations: reply.type === 'reply' ? reply.citations : undefined });
        if (reply.type === 'reply' && reply.proposal) setProposal(reply.proposal);
        if (reply.type === 'recorded') { setProposal(undefined); approval.current = ''; }
        readAloud();
      } else if (reply.type === 'audio') {
        if (!mute.current && !capturing.current && typeof reply.data === 'string' && /^audio\/(wav|x-wav|wave|mpeg|mp3|ogg|webm|mp4)(;|$)/i.test(reply.mime)) {
          setAudioSrc(`data:${reply.mime};base64,${reply.data}`);
        }
      } else if (reply.type === 'error') {
        if (reply.request_type === 'speak' || reply.code === 'tts_unavailable') {
          tts = false;
          setCapabilities(current => ({ ...current, tts: false }));
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
      setError(current => current || 'The call connection closed. Reconnect to start a new session.');
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
  return <Modal title="Voice Guardian" icon={<AudioLines size={24} />} close={close} kind="guardian-modal">
    <div className="guardian-call-meta"><span className="guardian-chip">{reasonLabels[call.reason]}</span><span lang="fr" translate="no">Français</span>
      {call.context.telemetry && <span>{String(call.context.telemetry.selected_slot).padStart(2, '0')}:00</span>}</div>
    <div className="guardian-call-body">
      {connection === 'connecting' && <p role="status" className="guardian-status">Connecting to field support…</p>}
      {active && !capabilities.llm && <p className="guardian-note">Guided mode uses verified simulator data. Open conversation needs the AI service.</p>}
      <div className="guardian-transcript" ref={transcript} role="log" aria-label="Call transcript" aria-live="polite">
        {entries.map((entry, index) => <div className={`guardian-turn ${entry.speaker}`} key={index}>
          <strong>{entry.speaker === 'guardian' ? 'Voice Guardian' : 'Farmer'}</strong>
          <p lang="fr" translate="no">{entry.text}</p>
          {entry.citations?.filter(source => /^https?:\/\//i.test(source.url)).map(source =>
            <a href={source.url} key={source.url} target="_blank" rel="noreferrer" translate="no">{source.title} ↗</a>)}
        </div>)}
      </div>
      {error && <p role="alert" className="guardian-notice">{error}</p>}
      {active && <div className="guardian-playback">
        {capabilities.tts ? <button type="button" className="text-button" aria-pressed={!muted} onClick={mutePlayback}>
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}{muted ? 'Enable voice replies' : 'Mute voice replies'}</button>
          : deviceVoice && lastReply ? <button type="button" className="text-button" onClick={() => {
            stopPlayback();
            const speech = new SpeechSynthesisUtterance(lastReply.text);
            speech.voice = deviceVoice; speech.lang = deviceVoice.lang; utterance.current = speech;
            window.speechSynthesis.speak(speech);
          }}><Volume2 size={15} />Read aloud with device voice</button> : null}
        {audioSrc && <audio key={audioSrc} ref={speaker} src={audioSrc} autoPlay controls aria-label="Spoken reply" />}
      </div>}
      {active && <>
        {capabilities.stt ? <GuardianMicrophone disabled={busy} onCapture={enabled => {
          capturing.current = enabled;
          if (enabled) stopPlayback();
        }} onSend={(mime, data) => post({ type: 'audio', mime, data })} />
          : <p className="guardian-note">Voice transcription is unavailable. Type your message below.</p>}
        <form className="guardian-compose" onSubmit={e => {
          e.preventDefault();
          const text = draft.trim();
          if (text && post({ type: 'message', text })) {
            setEntries(previous => [...previous.slice(-59), { speaker: 'farmer', text }]); setDraft('');
          }
        }}><label className="field"><span>Message</span><textarea maxLength={1200} rows={2} value={draft} onChange={e => setDraft(e.target.value)} /></label>
          <button type="submit" className="button button-primary" disabled={busy || !draft.trim()}><Send size={15} />Send message</button>
        </form>
        {pending && <p role="status" className="guardian-note">Checking your request…</p>}
        <button type="button" className="text-button" aria-expanded={recordingObservation} onClick={() => setRecordingObservation(!recordingObservation)}>
          <MessageSquareText size={15} />Record observation</button>
        {recordingObservation && <form className="guardian-review" onSubmit={e => {
          e.preventDefault(); if (observation.trim() && post({ type: 'observation', text: observation.trim() })) {
            setEntries(previous => [...previous.slice(-59), { speaker: 'farmer', text: observation.trim() }]);
            setObservation(''); setRecordingObservation(false);
          }
        }}><label className="field"><span>Field observation</span><textarea value={observation} maxLength={1200} rows={2} onChange={e => setObservation(e.target.value)} /></label>
          <p className="guardian-note">Saved as a farmer report for this call. Physical readings require verification.</p>
          {lastFarmer && <button type="button" className="text-button" onClick={() => setObservation(lastFarmer.text)}>Use my last message</button>}
          <button type="submit" className="button button-secondary" disabled={busy || !observation.trim()}>Save observation</button>
        </form>}
        {currentQuota !== undefined && currentQuota > 0 && !confirmed && <details className="guardian-review">
          <summary>Review a new quota</summary>
          <form onSubmit={e => { e.preventDefault(); if (quota !== '' && post({ type: 'propose', quota_m3: Number(quota) })) setProposal(undefined); }}>
            <label className="field"><span>Proposed withdrawal limit (m³)</span><input type="number" min={0} max={Math.ceil(currentQuota) - 1} step={1}
              value={quota} required onChange={e => { setQuota(e.target.value); setProposal(undefined); }} /></label>
            <button type="submit" className="button button-secondary" disabled={busy || quota.trim() === ''}>Calculate proposal</button>
          </form></details>}
        {proposal && <section className="guardian-proposal" aria-label="Proposed simulated plan">
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
      {connection === 'closed' && <button type="button" className="button button-secondary" onClick={reconnect}>Reconnect call</button>}
    </div>
    <div className="guardian-call-footer"><span><Headphones size={15} />In-platform call</span>
      <button type="button" className="button guardian-hangup" onClick={close}><PhoneOff size={15} />End call</button></div>
  </Modal>;
}

export default function VoiceGuardian({ context, incoming, onConfirm }: {
  context: GuardianContext; incoming?: GuardianOffer | null; onConfirm?: (value: GuardianConfirmation) => void;
}) {
  const [call, setCall] = useState<Call>();
  const [handled, setHandled] = useState<string[]>([]);
  const offer = incoming && !handled.includes(incoming.id) ? incoming : null;
  function handleOffer(accept: boolean) {
    if (!offer) return;
    setHandled(previous => [...previous.slice(-99), offer.id]);
    if (accept) setCall({ context: offer.context ?? context, reason: offer.reason });
  }
  return <>
    {!call && offer && <section className="guardian-incoming" aria-label="Incoming Guardian call">
      <div className="guardian-incoming-head"><span className="guardian-phone-mark"><PhoneIncoming size={21} /></span>
        <div><small>Voice Guardian</small><h2 role="status">{reasonLabels[offer.reason]}</h2></div></div>
      <p>{offer.reason === 'emergency' ? 'The simulation flagged an urgent event. Answer to inspect the cause and available options.'
        : 'A reading or planning input is missing. Answer to clarify what you can verify.'}</p>
      <div className="guardian-actions"><button type="button" className="button button-primary" onClick={() => handleOffer(true)}><Phone size={15} />Accept call</button>
        <button type="button" className="button button-secondary" onClick={() => handleOffer(false)}>Decline</button></div>
    </section>}
    {!call && !offer && <button type="button" className="guardian-launch button button-secondary" aria-haspopup="dialog" aria-label="Call Voice Guardian"
      onClick={() => setCall({ context, reason: 'accessibility' })}><Phone size={17} /><span>Voice Guardian</span></button>}
    {call && <GuardianCall call={call} close={() => setCall(undefined)} onConfirm={onConfirm} />}
  </>;
}
