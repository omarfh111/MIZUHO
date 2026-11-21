import { gsap } from 'gsap';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { BRAND, TAGLINE } from '../core/content.ts';
import { createOpeningField, type OpeningField } from './opening-gl.ts';

interface Props {
  /** Real loading progress, 0 → 1. The condensation eases towards it but never runs ahead. */
  progress: number;
  stage: string;
  leaving: boolean;
  particles: number;
}

const FONT = '"Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif';

/**
 * The opening, about three seconds. Luminous water mist swirls in the dark
 * and condenses into the wordmark as the scene genuinely loads; then the
 * letters spiral into one drop, which falls into the film.
 */
export function Loader({ progress, stage, leaving, particles }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const field = useRef<OpeningField | null>(null);
  const state = useRef({ condense: 0, release: 0, pointer: null as [number, number] | null });
  const number = useRef<HTMLSpanElement>(null);
  const [gl, setGl] = useState(true);

  // Particle field lifecycle: one rAF loop for the whole opening.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let f: OpeningField | null = null;
    try {
      f = createOpeningField(el, particles);
    } catch (error) {
      console.warn('[MIZUHO experience] Particle opening unavailable, using the vector wordmark.', error);
      f = null;
    }
    if (!f) {
      setGl(false);
      return;
    }
    field.current = f;
    let cancelled = false;
    const font = `600 200px ${FONT}`;
    const place = () => !cancelled && f!.setHomes(BRAND, FONT);
    (document.fonts?.load(font) ?? Promise.resolve()).then(place, place);
    const onResize = () => {
      f!.resize();
      place();
    };
    window.addEventListener('resize', onResize);
    const start = performance.now();
    let frame = 0;
    const loop = (now: number) => {
      const aspect = el.clientWidth / Math.max(1, el.clientHeight);
      f!.frame({
        time: (now - start) / 1000,
        condense: state.current.condense,
        release: state.current.release,
        pointer: state.current.pointer,
        drop: [aspect < 1.25 ? 0 : aspect * 0.32, aspect < 1.25 ? -0.05 : 0.02],
      });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      f!.dispose();
    };
  }, [particles]);

  // Progress → condensation, eased, never ahead of the real value.
  useEffect(() => {
    const tween = gsap.to(state.current, {
      condense: progress,
      duration: 0.8,
      ease: 'power2.out',
      onUpdate: () => {
        if (number.current) number.current.textContent = String(Math.round(state.current.condense * 100)).padStart(2, '0');
        root.current?.setAttribute('aria-valuenow', String(Math.round(state.current.condense * 100)));
      },
    });
    return () => {
      tween.kill();
    };
  }, [progress]);

  // Release: the wordmark spirals into a single drop, then the curtain lifts.
  useLayoutEffect(() => {
    if (!leaving || !root.current) return;
    const ctx = gsap.context(() => {
      gsap.to(state.current, { condense: 1, duration: 0.2 });
      gsap.to(state.current, { release: 1, duration: 0.95, ease: 'power2.in' });
      gsap.to('.mx-open__tagline, .mx-open__meta, .mx-open__fallback', { opacity: 0, y: -8, duration: 0.35, ease: 'power2.in' });
      gsap.fromTo('.mx-open__flash', { scale: 0.2, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.25, delay: 0.82, ease: 'power2.out' });
      gsap.to('.mx-open__flash', { scale: 3, opacity: 0, duration: 0.6, delay: 1.07, ease: 'power2.out' });
      gsap.to(root.current, { '--mx-open-bg': 0, duration: 0.6, delay: 0.7, ease: 'power1.inOut' });
      gsap.to(canvas.current, { opacity: 0, duration: 0.35, delay: 1.0 });
      gsap.set(root.current, { pointerEvents: 'none', delay: 0.4 });
      gsap.set(root.current, { visibility: 'hidden', delay: 1.6 });
    }, root);
    return () => ctx.revert();
  }, [leaving]);

  const onPointer = (event: ReactPointerEvent) => {
    const el = canvas.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const aspect = rect.width / Math.max(1, rect.height);
    state.current.pointer = [((event.clientX - rect.left) / rect.width * 2 - 1) * aspect, -((event.clientY - rect.top) / rect.height * 2 - 1)];
  };

  return (
    <div
      ref={root}
      className="mx-open"
      data-leaving={leaving || undefined}
      data-gl={gl || undefined}
      role="progressbar"
      aria-label={`Loading ${BRAND}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={stage}
      onPointerMove={onPointer}
      onPointerLeave={() => { state.current.pointer = null; }}
    >
      <div className="mx-open__caustics" aria-hidden />
      <canvas ref={canvas} className="mx-open__field" aria-hidden />
      {!gl ? (
        <div className="mx-open__fallback" aria-hidden>
          {BRAND.split('').map((ch, i) => <span key={i} style={{ '--i': i } as CSSProperties}>{ch}</span>)}
        </div>
      ) : null}
      <h1 className="mx-open__sr">{BRAND}</h1>
      <p className="mx-open__tagline">
        {TAGLINE.split(' ').map((w, i) => <span key={i} style={{ '--i': i } as CSSProperties}>{w}</span>)}
      </p>
      <div className="mx-open__meta">
        <span className="mx-open__stage" key={stage}>{stage}</span>
        <span className="mx-open__pct"><span ref={number}>00</span></span>
      </div>
      <span className="mx-open__flash" aria-hidden />
    </div>
  );
}
