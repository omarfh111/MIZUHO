import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/manrope';
import './experience.css';
import { gsap } from 'gsap';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ComponentType, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { detectCapabilities, QUALITY, type Capabilities } from './core/capabilities.ts';
import { LOADING_STAGES, type LoadingStage } from './core/content.ts';
import {
  SCENE_END, SECONDS_PER_CHAPTER, chapterAt, createDirector, direct, springStep, type Director,
} from './core/director.ts';
import type { CinematicCanvasProps } from './scene/CinematicCanvas.tsx';
import type { World } from './scene/world.ts';
import { Captions } from './ui/Captions.tsx';
import { Fallback } from './ui/Fallback.tsx';
import { Hud } from './ui/Hud.tsx';
import { Loader } from './ui/Loader.tsx';
import { ReplayButton } from './ui/ReplayButton.tsx';

export type PlayPolicy = 'session' | 'once' | 'always' | 'never';

export interface ExperienceGateProps {
  children: ReactNode;
  /** When to play the entrance automatically. `?intro=1` / `?intro=0` override it. Default: `session`. */
  play?: PlayPolicy;
  /** Optional work to count in the loading progress, e.g. `() => import('./App')` or an initial fetch. */
  preload?: () => Promise<unknown>;
  /** Mount the wrapped app from the start instead of near the end of the film. Default: false. */
  mountChildrenEarly?: boolean;
  /** Floating "replay" pill once the dashboard is visible. Default: true. */
  replayButton?: boolean;
  storageKey?: string;
  onComplete?: () => void;
}

type Phase = 'loading' | 'film' | 'exiting' | 'done';
type Mode = '3d' | 'fallback';

interface ExperienceApi {
  replay: () => void;
  active: boolean;
}

const ExperienceContext = createContext<ExperienceApi>({ replay: () => undefined, active: false });

/** Lets the wrapped app offer its own "replay intro" control. */
export const useExperience = () => useContext(ExperienceContext);

type CanvasModule = { default: ComponentType<CinematicCanvasProps>; prepareWorld: typeof import('./scene/CinematicCanvas.tsx').prepareWorld };

const WEIGHTS: Record<Exclude<LoadingStage, 'ready'>, number> = { engine: 0.22, terrain: 0.4, valley: 0.13, shaders: 0.15, app: 0.1 };
/** The opening lasts about three seconds: ~2.4 s of filling, ~0.7 s of hand-over. */
const MIN_OPENING_MS = 2400;
const MIN_REPLAY_OPENING_MS = 1200;
/** How long the finale holds before entering on its own, when nobody took control. */
const FINALE_HOLD_S = 2.6;
/** Scrolling this far past the last chapter enters the dashboard. */
const OVERSCROLL_ENTER = 0.32;

function shouldPlay(policy: PlayPolicy, storageKey: string, reducedMotion: boolean): boolean {
  if (typeof window === 'undefined') return false;
  const forced = new URLSearchParams(window.location.search).get('intro');
  if (forced === '1') return true;
  if (forced === '0') return false;
  if (policy === 'never' || reducedMotion) return false;
  if (policy === 'always') return true;
  try {
    const store = policy === 'once' ? window.localStorage : window.sessionStorage;
    return store.getItem(storageKey) !== 'seen';
  } catch {
    return true;
  }
}

function markSeen(policy: PlayPolicy, storageKey: string) {
  try {
    (policy === 'once' ? window.localStorage : window.sessionStorage).setItem(storageKey, 'seen');
  } catch {
    /* storage unavailable: the intro simply plays again next time */
  }
}

/** Black dip used for hard cuts when motion is reduced. */
function Dip({ director }: { director: Director }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      if (ref.current) ref.current.style.opacity = String(director.dip);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [director]);
  return <div ref={ref} className="mx-dip" style={{ opacity: 0 }} />;
}

export function ExperienceGate({
  children, play = 'session', preload, mountChildrenEarly = false, replayButton = true,
  storageKey = 'mizuho.experience', onComplete,
}: ExperienceGateProps) {
  const caps = useMemo<Capabilities>(() => detectCapabilities(), []);
  const [phase, setPhase] = useState<Phase>(() => (shouldPlay(play, storageKey, caps.reducedMotion) ? 'loading' : 'done'));
  const [mode, setMode] = useState<Mode>(caps.webgl ? '3d' : 'fallback');
  const [run, setRun] = useState(0);
  const [childrenMounted, setChildrenMounted] = useState(() => mountChildrenEarly || phase === 'done');
  const [chapter, setChapter] = useState(0);
  const [autoplay, setAutoplay] = useState(true);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<LoadingStage>('engine');
  const [labelLayer, setLabelLayer] = useState<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<{ Canvas: CanvasModule['default']; world: World } | null>(null);

  const director = useRef<Director>(createDirector());
  const film = useRef({ target: 0, spring: { value: 0, velocity: 0 }, autoplay: true, hold: 0 });
  const overlay = useRef<HTMLDivElement>(null);
  const hud = useRef<{ coordinates?: HTMLElement | null; rail?: HTMLElement | null }>({});
  const sceneReady = useRef<() => void>(() => undefined);
  const exiting = useRef(false);
  const touch = useRef<{ y: number } | null>(null);
  const preloadRef = useRef(preload);
  preloadRef.current = preload;
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  const active = phase !== 'done';

  /* ------------------------------------------------------------ exit */
  const finish = useCallback(() => {
    setPhase('done');
    setScene(null);
    markSeen(play, storageKey);
    completeRef.current?.();
  }, [play, storageKey]);

  const exit = useCallback((quick = false) => {
    if (exiting.current) return;
    exiting.current = true;
    setChildrenMounted(true);
    setPhase('exiting');
    const el = overlay.current;
    const mask = { r: 0 };
    const duration = quick ? 0.75 : 1.35;
    gsap.to(director.current, { exit: 1, duration, ease: 'power2.inOut' });
    gsap.to(mask, {
      r: 1,
      duration,
      ease: 'power3.inOut',
      onUpdate: () => el?.style.setProperty('--mx-reveal', mask.r.toFixed(4)),
      onComplete: finish,
    });
  }, [finish]);

  /* --------------------------------------------------------- loading */
  useEffect(() => {
    if (phase !== 'loading') return;
    let cancelled = false;
    const started = performance.now();
    const parts: Record<keyof typeof WEIGHTS, number> = { engine: 0, terrain: 0, valley: 0, shaders: 0, app: 0 };
    const report = (key: keyof typeof WEIGHTS, value: number) => {
      if (cancelled) return;
      parts[key] = Math.max(parts[key], value);
      const total = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((sum, k) => sum + parts[k] * WEIGHTS[k], 0);
      setProgress(total);
      const pending = (['engine', 'terrain', 'valley', 'shaders', 'app'] as const).find((k) => parts[k] < 1);
      setStage(pending ?? 'ready');
    };
    direct(director.current, 0);

    const app = Promise.all([
      preloadRef.current?.().catch(() => undefined),
      document.fonts?.ready.catch(() => undefined),
    ]).then(() => report('app', 1));

    const sceneTask = mode === '3d'
      ? (async () => {
        const mod = (await import('./scene/CinematicCanvas.tsx')) as CanvasModule;
        report('engine', 1);
        const world = await mod.prepareWorld(caps.tier, QUALITY[caps.tier], (f) => report('terrain', f), (f) => report('valley', f));
        if (cancelled) return;
        await new Promise<void>((resolve) => {
          sceneReady.current = resolve;
          setScene({ Canvas: mod.default, world });
        });
        report('shaders', 1);
      })()
      : Promise.resolve().then(() => (['engine', 'terrain', 'valley', 'shaders'] as const).forEach((k) => report(k, 1)));

    Promise.all([app, sceneTask])
      .then(async () => {
        const wait = (run ? MIN_REPLAY_OPENING_MS : MIN_OPENING_MS) - (performance.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (!cancelled) setPhase('film');
      })
      .catch((error) => {
        console.warn('[MIZUHO experience] 3D scene unavailable, using the lightweight intro.', error);
        if (!cancelled) {
          setScene(null);
          setMode('fallback');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [phase, mode, run, caps.tier]);

  /* ------------------------------------------------------- film clock */
  useEffect(() => {
    if (phase !== 'film') return;
    let frame = 0;
    let last = performance.now();
    // The drop is released by the opening; give it a beat before the film starts moving.
    let delay = 0.45;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const f = film.current;
      if (delay > 0) delay -= dt;
      else if (f.autoplay) {
        f.target = Math.min(SCENE_END, f.target + dt / SECONDS_PER_CHAPTER);
        if (f.target >= SCENE_END && f.spring.value > SCENE_END - 0.02) {
          f.hold += dt;
          if (f.hold > FINALE_HOLD_S) exit();
        }
      }
      const d = director.current;
      if (caps.reducedMotion) {
        // No glide: cut straight to the target, softened by a dip.
        if (Math.abs(f.spring.value - Math.min(SCENE_END, f.target)) > 0.001) {
          d.dip = 1;
          f.spring.value = Math.min(SCENE_END, f.target);
        }
      } else {
        springStep(f.spring, Math.min(SCENE_END, f.target), dt);
      }
      const s = Math.min(SCENE_END, Math.max(0, f.spring.value));
      const dip = Math.max(0, d.dip - dt * 3);
      direct(d, s);
      d.dip = dip;
      setChapter(chapterAt(s));
      if (s > SCENE_END - 1.6) setChildrenMounted(true);
      hud.current.rail?.style.setProperty('--mx-film', (s / SCENE_END).toFixed(4));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, exit, caps.reducedMotion]);

  /** Any manual input takes the wheel from autoplay. */
  const takeControl = useCallback(() => {
    if (film.current.autoplay) {
      film.current.autoplay = false;
      film.current.hold = 0;
      setAutoplay(false);
    }
  }, []);

  const nudge = useCallback((delta: number) => {
    if (phase !== 'film') return;
    takeControl();
    const f = film.current;
    f.target = Math.max(0, Math.min(SCENE_END + OVERSCROLL_ENTER + 0.05, f.target + delta));
    if (f.target > SCENE_END + OVERSCROLL_ENTER) exit();
  }, [phase, exit, takeControl]);

  const jump = useCallback((index: number) => {
    takeControl();
    film.current.target = Math.max(0, Math.min(SCENE_END, index));
  }, [takeControl]);

  const toggleAutoplay = useCallback(() => {
    const f = film.current;
    f.autoplay = !f.autoplay;
    f.hold = 0;
    f.target = Math.min(f.target, SCENE_END);
    setAutoplay(f.autoplay);
  }, []);

  /* ------------------------------------------ keyboard, wheel & scroll lock */
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        exit(phase === 'loading');
        return;
      }
      if (phase !== 'film') return;
      const f = film.current;
      const forward = ['ArrowDown', 'PageDown', 'ArrowRight'].includes(event.key) || (event.key === ' ' && !event.shiftKey);
      const back = ['ArrowUp', 'PageUp', 'ArrowLeft'].includes(event.key) || (event.key === ' ' && event.shiftKey);
      if (forward) {
        event.preventDefault();
        if (f.target >= SCENE_END) exit();
        else jump(Math.floor(f.target + 0.001) + 1);
      } else if (back) {
        event.preventDefault();
        jump(Math.ceil(f.target - 0.001) - 1);
      } else if (event.key === 'Home') jump(0);
      else if (event.key === 'End') jump(SCENE_END);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      nudge((event.deltaY * unit) / 900);
    };
    const el = overlay.current;
    window.addEventListener('keydown', onKey);
    el?.addEventListener('wheel', onWheel, { passive: false });
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      el?.removeEventListener('wheel', onWheel);
      root.style.overflow = previous;
    };
  }, [active, phase, exit, nudge, jump]);

  /* ---------------------------------------------------------- replay */
  const replay = useCallback(() => {
    if (phase !== 'done') return;
    gsap.killTweensOf(director.current);
    director.current = createDirector();
    film.current = { target: 0, spring: { value: 0, velocity: 0 }, autoplay: true, hold: 0 };
    exiting.current = false;
    setChapter(0);
    setAutoplay(true);
    setProgress(0);
    setStage('engine');
    setMode(caps.webgl ? '3d' : 'fallback');
    setRun((r) => r + 1);
    setPhase('loading');
  }, [phase, caps.webgl]);

  const api = useMemo(() => ({ replay, active }), [replay, active]);

  const onPointerMove = (event: ReactPointerEvent) => {
    const p = director.current.pointer;
    p.x = (event.clientX / window.innerWidth) * 2 - 1;
    p.y = -((event.clientY / window.innerHeight) * 2 - 1);
    p.active = true;
    if (event.pointerType === 'touch' && touch.current) {
      const dy = touch.current.y - event.clientY;
      touch.current.y = event.clientY;
      nudge(dy / (window.innerHeight * 0.55));
    }
  };
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') touch.current = { y: event.clientY };
  };
  const onPointerEnd = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') {
      touch.current = null;
      director.current.pointer.active = false;
    }
  };

  const SceneCanvas = scene?.Canvas;

  return (
    <ExperienceContext.Provider value={api}>
      <div className="mx-app" data-experience={phase} inert={active} aria-hidden={active || undefined}>
        {childrenMounted ? children : null}
      </div>

      {active ? (
        <div
          key={run}
          ref={overlay}
          className="mx-gate"
          data-phase={phase}
          data-mode={mode}
          role="region"
          aria-roledescription="film"
          aria-label="MIZUHO: follow a raindrop across Tunisia"
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onPointerLeave={() => { director.current.pointer.active = false; }}
        >
          <div className="mx-stage">
            {mode === '3d' && SceneCanvas && scene ? (
              <SceneCanvas
                world={scene.world}
                director={director.current}
                quality={QUALITY[caps.tier]}
                hud={hud.current}
                labelLayer={labelLayer}
                onReady={() => sceneReady.current()}
                onContextLost={() => exit(true)}
              />
            ) : null}
            <div className="mx-labels" ref={setLabelLayer} aria-hidden />
            {mode === 'fallback' && phase !== 'loading' ? <Fallback chapter={chapter} /> : null}
            {caps.reducedMotion ? <Dip director={director.current} /> : null}
          </div>

          {phase !== 'loading' ? (
            <>
              <Captions chapter={chapter} onEnter={() => exit()} />
              <Hud
                chapter={chapter}
                autoplay={autoplay}
                touch={caps.touch}
                onJump={jump}
                onToggleAutoplay={toggleAutoplay}
                railRef={(el) => { hud.current.rail = el; }}
                coordinatesRef={(el) => { hud.current.coordinates = el; }}
                showCoordinates={mode === '3d'}
              />
            </>
          ) : null}

          <Loader progress={progress} stage={LOADING_STAGES[stage]} leaving={phase !== 'loading'} />

          <button
            type="button"
            className={`mx-skip ${chapter >= SCENE_END ? 'mx-skip--primary' : ''}`}
            onClick={() => exit(phase === 'loading')}
          >
            <span>{chapter >= SCENE_END ? 'Enter' : 'Skip intro'}</span>
            <kbd>Esc</kbd>
          </button>
        </div>
      ) : null}

      {phase === 'done' && replayButton ? <ReplayButton onReplay={replay} /> : null}
    </ExperienceContext.Provider>
  );
}
