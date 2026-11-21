import { gsap } from 'gsap';
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { BRAND, TAGLINE } from '../core/content.ts';

interface Props {
  /** Real loading progress, 0 → 1. The fill eases towards it but never runs ahead. */
  progress: number;
  stage: string;
  leaving: boolean;
}

/** Wavy top edge, repeated horizontally and slid sideways to animate the surface. */
const WAVE = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="2000" viewBox="0 0 240 2000"><path d="M0 14 C40 2 80 2 120 14 S200 26 240 14 V2000 H0Z" fill="#000"/></svg>',
)}")`;

/**
 * The opening, about three seconds: the wordmark fills with water as the
 * scene really loads, then a drop gathers under the final letter and falls
 * into the film, where the 3D drop takes over.
 */
export function Loader({ progress, stage, leaving }: Props) {
  const shown = useRef({ value: 0 });
  const root = useRef<HTMLDivElement>(null);
  const word = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  const number = useRef<HTMLSpanElement>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const lastLetter = useRef<HTMLSpanElement>(null);
  const drip = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const render = () => {
      const v = shown.current.value;
      const h = word.current?.offsetHeight ?? 0;
      // The visible water level sits inside the glyph band (cap height ≈ 15 %–85 % of the box).
      const level = h * (0.86 - v * 0.74);
      fill.current?.style.setProperty('--level', `${level.toFixed(1)}px`);
      if (line.current) line.current.style.transform = `translateY(${level.toFixed(1)}px)`;
      if (number.current) number.current.textContent = String(Math.round(v * 100)).padStart(2, '0');
      if (meter.current) meter.current.style.transform = `scaleX(${v})`;
      root.current?.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    };
    const tween = gsap.to(shown.current, { value: progress, duration: 0.7, ease: 'power2.out', onUpdate: render });
    render();
    return () => {
      tween.kill();
    };
  }, [progress]);

  // Hand-over: letters lift away, a drop gathers under the last letter and falls.
  useLayoutEffect(() => {
    if (!leaving || !root.current) return;
    const ctx = gsap.context(() => {
      const box = lastLetter.current?.getBoundingClientRect();
      const host = root.current!.getBoundingClientRect();
      if (box && drip.current) {
        gsap.set(drip.current, { left: box.left - host.left + box.width / 2, top: box.bottom - host.top - box.height * 0.12 });
        gsap.timeline()
          .fromTo(drip.current, { scale: 0, opacity: 1 }, { scale: 1, duration: 0.22, ease: 'back.out(3)' })
          .to(drip.current, {
            y: host.height * 0.5 - (box.bottom - host.top) + host.height * 0.02,
            x: host.width * 0.58 - (box.left - host.left + box.width / 2),
            scaleY: 1.5,
            scaleX: 0.8,
            duration: 0.5,
            ease: 'power2.in',
          })
          .to(drip.current, { opacity: 0, scale: 2.4, duration: 0.18, ease: 'power1.out' });
      }
      gsap.to('.mx-open__glyph', { yPercent: -40, opacity: 0, filter: 'blur(14px)', duration: 0.55, stagger: 0.035, ease: 'power3.in', delay: 0.12 });
      gsap.to('.mx-open__meta, .mx-open__tagline, .mx-open__line', { opacity: 0, duration: 0.3 });
      gsap.to(root.current, { '--mx-open-bg': 0, duration: 0.55, delay: 0.32, ease: 'power1.inOut' });
      gsap.set(root.current, { pointerEvents: 'none', delay: 0.3 });
      gsap.set(root.current, { visibility: 'hidden', delay: 1.0 });
    }, root);
    return () => ctx.revert();
  }, [leaving]);

  const letters = BRAND.split('');
  return (
    <div
      ref={root}
      className="mx-open"
      data-leaving={leaving || undefined}
      role="progressbar"
      aria-label="Loading MIZUHO"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={stage}
    >
      <div className="mx-open__caustics" aria-hidden />
      <div className="mx-open__center">
        <div ref={word} className="mx-open__word" aria-hidden>
          <div className="mx-open__outline">
            {letters.map((ch, i) => (
              <span key={i} className="mx-open__glyph" style={{ '--i': i } as CSSProperties}>{ch}</span>
            ))}
          </div>
          <div ref={fill} className="mx-open__fill" style={{ WebkitMaskImage: WAVE, maskImage: WAVE }}>
            {letters.map((ch, i) => (
              <span
                key={i}
                ref={i === letters.length - 1 ? lastLetter : undefined}
                className="mx-open__glyph"
                style={{ '--i': i } as CSSProperties}
              >
                {ch}
              </span>
            ))}
          </div>
          <span ref={line} className="mx-open__line" />
        </div>
        <h1 className="mx-open__sr">{BRAND}</h1>
        <p className="mx-open__tagline">{TAGLINE}</p>
      </div>
      <div className="mx-open__meta">
        <span className="mx-open__stage" key={stage}>{stage}</span>
        <span className="mx-open__track"><span ref={meter} /></span>
        <span className="mx-open__pct"><span ref={number}>00</span>%</span>
      </div>
      <span ref={drip} className="mx-open__drip" aria-hidden />
    </div>
  );
}
