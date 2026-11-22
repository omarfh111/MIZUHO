import { useRef, useState, type RefObject } from 'react';
import { GuardianHandsFree, type GuardianVoicePhase } from './guardianHandsFree.ts';
import type { Language } from '../i18n/language.ts';

type Activity = 'ask' | 'present' | 'translate';

/** Keep the microphone, its pending utterance and playback inside this dialog's WebSocket session. */
export function useGuardianLiveVoice(socket: RefObject<WebSocket | null>, activity: Activity, target: Language,
  notice: (message: string) => void) {
  const controller = useRef<GuardianHandsFree | null>(null);
  const level = useRef(0);
  const [phase, setPhase] = useState<GuardianVoicePhase>('off');
  const [paused, setPaused] = useState(false);
  const stt = useRef<boolean | undefined>(undefined);
  const sequence = useRef(0);
  const current = useRef<number | null>(null);
  const queued = useRef<string | null>(null);
  const options = useRef({ activity, target });
  options.current = { activity, target };

  function cancelTurn() {
    if (current.current !== null && queued.current === null && socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'cancel', turn_id: current.current }));
    }
    current.current = null;
    queued.current = null;
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
        const { activity: mode, target: language } = options.current;
        const id = ++sequence.current;
        current.current = id;
        const frame = JSON.stringify({ type: 'audio', mime, data, turn_id: id, mode,
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
    controller.current?.listen();
  }
  function read(id: number, available: boolean) {
    if (!accepts(id)) return;
    if (available && socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'speak', turn_id: id }));
    } else finished(id);
  }
  function play(id: number, mime: string, audio: string) {
    if (!accepts(id)) return;
    const mic = controller.current!;
    void mic.play(mime, audio).catch(() => { /* The controller reports playback errors and reopens listening. */ })
      .finally(() => finished(id));
  }
  return { start, stop, ready, disconnect, accepts, read, play, finished, level, phase, paused, controller };
}
