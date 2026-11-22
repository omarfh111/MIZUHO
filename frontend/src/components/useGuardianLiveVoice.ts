import { useRef, useState, type RefObject } from 'react';
import { GuardianHandsFree, type GuardianVoicePhase } from './guardianHandsFree.ts';
import type { Language } from '../i18n/language.ts';

export type GuardianActivity = 'ask' | 'present' | 'translate' | 'evidence';

/** Keep the microphone, its pending utterance and playback inside this dialog's WebSocket session. */
export function useGuardianLiveVoice(socket: RefObject<WebSocket | null>, activity: GuardianActivity, target: Language,
  notice: (message: string) => void) {
  const controller = useRef<GuardianHandsFree | null>(null);
  const level = useRef(0);
  const [phase, setPhase] = useState<GuardianVoicePhase>('off');
  const [paused, setPaused] = useState(false);
  const [preview, setPreview] = useState('');
  const stt = useRef<boolean | undefined>(undefined);
  const sequence = useRef(0);
  const current = useRef<number | null>(null);
  const queued = useRef<string | null>(null);
  const playback = useRef(Promise.resolve());
  const options = useRef({ activity, target });
  options.current = { activity, target };

  function cancelTurn() {
    if (current.current !== null && queued.current === null && socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'cancel', turn_id: current.current }));
    }
    current.current = null;
    queued.current = null;
    playback.current = Promise.resolve();
    setPreview('');
  }
  function stop() {
    cancelTurn();
    const mic = controller.current;
    controller.current = null;
    mic?.stop();
    level.current = 0;
    setPhase('off');
    if (mic) setPaused(true);
  }
  function start() {
    if (controller.current || stt.current === false) return;
    setPaused(false);
    notice('');
    const mic = new GuardianHandsFree({
      onPhase(next) {
        if (controller.current !== mic) return;
        setPhase(next);
        if (next === 'off') {
          cancelTurn();
          controller.current = null;
          level.current = 0;
          setPaused(true);
        }
      },
      onLevel(value) { if (controller.current === mic) level.current = value; },
      onInterrupt() { if (controller.current === mic) cancelTurn(); },
      onTurn(mime, data) {
        if (controller.current !== mic) return;
        notice('');
        const { activity: mode, target: language } = options.current;
        const id = ++sequence.current;
        current.current = id;
        const frame = JSON.stringify({ type: 'audio', mime, data, turn_id: id, mode, stream_audio: true,
          ...((mode === 'ask' || mode === 'evidence') && { progress_audio: true }),
          ...(mode === 'translate' && { target_language: language }) });
        if (stt.current === true && socket.current?.readyState === WebSocket.OPEN) socket.current.send(frame);
        else queued.current = frame;
      },
      onError(reason) {
        if (controller.current !== mic) return;
        const messages = {
          microphone: 'Microphone unavailable. Check browser permissions or type your message.',
          unsupported: 'This browser cannot record audio. You can type your message.',
          interrupted: 'Live listening stopped. Resume when you are ready.',
          playback: 'Voice playback is unavailable for this reply.',
          utterance_limit: 'That phrase was too long to send. Try saying it in shorter parts.',
        };
        notice(messages[reason]);
      },
    });
    controller.current = mic;
    void mic.start().catch(() => { if (controller.current === mic) stop(); });
  }
  function ready(available: boolean) {
    stt.current = available;
    if (!available) { stop(); return; }
    if (queued.current && socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(queued.current);
      queued.current = null;
    }
  }
  function disconnect() { stop(); stt.current = undefined; }
  function accepts(id: number) { return current.current === id && controller.current !== null; }
  function finished(id: number) {
    if (!accepts(id)) return;
    current.current = null;
    setPreview('');
    controller.current?.listen();
  }
  // The final answer can arrive before the first verified sentence finishes playing.
  // A new utterance invalidates both the playing audio and every queued segment.
  function inOrder(id: number, work: (mic: GuardianHandsFree) => void | Promise<void>) {
    playback.current = playback.current.then(async () => {
      if (accepts(id)) await work(controller.current!);
    }).catch(() => {
      if (accepts(id)) notice('Voice playback is unavailable for this reply.');
    });
  }
  function read(id: number, available: boolean) {
    if (!accepts(id)) return;
    setPreview('');
    if (available && socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'speak', turn_id: id, stream_audio: true }));
    } else inOrder(id, () => finished(id));
  }
  function segmentEnded(id: number, prefix: boolean) {
    if (prefix && accepts(id)) controller.current?.waitForReply();
    else finished(id);
  }
  function play(id: number, mime: string, audio: string, prefix: boolean) {
    inOrder(id, async mic => {
      try { await mic.play(mime, audio); } finally { segmentEnded(id, prefix); }
    });
  }
  function chunk(id: number, data: string) {
    inOrder(id, mic => { mic.queuePcm(data); });
  }
  function endAudio(id: number, prefix: boolean) {
    inOrder(id, async mic => {
      try { await mic.finishPcm(); } finally { segmentEnded(id, prefix); }
    });
  }
  return { start, stop, ready, disconnect, accepts, read, play, chunk, endAudio, finished, level, phase, paused,
    controller, preview, setPreview };
}
