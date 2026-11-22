import { Mic, Send, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const maxDuration = 20_000;
const maxBytes = 2_000_000;

/** A recording stays on the device until the farmer presses Send recording. */
export default function GuardianMicrophone({ disabled, onSend, onCapture }: {
  disabled: boolean;
  onSend: (mime: string, base64: string) => void;
  onCapture: (enabled: boolean) => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'permission' | 'recording' | 'preview'>('idle');
  const [notice, setNotice] = useState('');
  const [clip, setClip] = useState<Blob>();
  const generation = useRef(0);
  const capture = useRef<MediaRecorder | null>(null);
  const captureState = useRef(onCapture);
  captureState.current = onCapture;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function release() {
    captureState.current(false);
    clearTimeout(timer.current);
    const recorder = capture.current;
    capture.current = null;
    if (!recorder) return;
    recorder.onstop = null;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    if (recorder.state !== 'inactive') recorder.stop();
    recorder.stream.getTracks().forEach(track => track.stop());
  }
  useEffect(() => () => { generation.current++; release(); }, []);

  function discard() {
    generation.current++;
    release();
    setClip(undefined);
    setPhase('idle');
    setNotice('');
  }

  async function record() {
    if (disabled || phase !== 'idle') return;
    onCapture(true);
    const version = ++generation.current;
    setNotice('');
    setPhase('permission');
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (version !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('unsupported');
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
      const parts: Blob[] = [];
      let bytes = 0;
      capture.current = recorder;
      recorder.ondataavailable = event => {
        bytes += event.data.size;
        if (bytes <= maxBytes) parts.push(event.data);
        else if (recorder.state === 'recording') recorder.stop();
      };
      recorder.onstop = () => {
        release();
        if (version !== generation.current) return;
        if (bytes > maxBytes || !bytes) {
          setNotice('No usable recording. Try a shorter recording or type your message.');
          setPhase('idle');
          return;
        }
        setClip(new Blob(parts, { type: mimeType.split(';')[0] }));
        setPhase('preview');
      };
      recorder.onerror = () => { discard(); setNotice('The recording stopped. You can type your message.'); };
      recorder.start(500);
      setPhase('recording');
      timer.current = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, maxDuration);
    } catch {
      stream?.getTracks().forEach(track => track.stop());
      if (version !== generation.current) return;
      discard();
      setNotice('Microphone unavailable. Check browser permissions or type your message.');
    }
  }

  function send() {
    if (!clip || disabled) return;
    const version = generation.current;
    const reader = new FileReader();
    reader.onload = () => {
      if (version !== generation.current || typeof reader.result !== 'string') return;
      onSend(clip.type, reader.result.substring(reader.result.indexOf(',') + 1));
      discard();
    };
    reader.onerror = () => { if (version === generation.current) setNotice('The recording could not be read. Please record again.'); };
    reader.readAsDataURL(clip);
  }

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return <p className="guardian-note">This browser cannot record audio. You can type your message.</p>;
  }
  return <div className="guardian-capture">
    {phase === 'idle' && <button type="button" className="button button-secondary" disabled={disabled} onClick={record}>
      <Mic size={16} />Record message</button>}
    {phase === 'permission' && <span role="status">Waiting for microphone permission…</span>}
    {phase === 'recording' && <button type="button" className="button button-secondary" onClick={() => capture.current?.stop()}>
      <Square size={14} />Stop recording</button>}
    {phase === 'preview' && <button type="button" className="button button-primary" disabled={disabled} onClick={send}>
      <Send size={15} />Send recording</button>}
    {phase !== 'idle' && <button type="button" className="text-button" onClick={discard}><X size={14} />Discard recording</button>}
    <small>{phase === 'preview' ? 'Send this recording to Vultr for transcription.' : 'Up to 20 seconds. Only sent to Vultr when you choose Send recording.'}</small>
    {notice && <p role="status">{notice}</p>}
  </div>;
}
