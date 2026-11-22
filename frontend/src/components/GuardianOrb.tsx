import { useEffect, useRef } from 'react';
import { useLanguage, type Language } from '../i18n/language.ts';
import './guardian-orb.css';

export type GuardianOrbState = 'idle' | 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'paused' | 'unavailable';
type Level = { readonly current: number };

const labels: Record<Language, Record<GuardianOrbState, string>> = {
  en: { idle: 'Microphone off', connecting: 'Connecting', listening: 'Listening', hearing: 'Hearing you',
    thinking: 'Preparing a reply', speaking: 'Speaking', paused: 'Listening paused', unavailable: 'Voice unavailable' },
  ja: { idle: 'マイクはオフです', connecting: '接続中', listening: 'お話しください', hearing: '聞いています',
    thinking: '返答を準備中', speaking: '応答中', paused: '聞き取りを一時停止中', unavailable: '音声を利用できません' },
  aeb: { idle: 'الميكرو مطفّي', connecting: 'قاعدين نتّصلوا', listening: 'تفضّل احكي', hearing: 'نسمع فيك',
    thinking: 'نحضّرلك في الجواب', speaking: 'نجاوب فيك', paused: 'الاستماع واقف توّا', unavailable: 'الصوت موش متاح' },
};

const tau = Math.PI * 2;
// Sample the contours once. Animation only projects this small mesh onto a 2D canvas.
const latitudes = Array.from({ length: 27 }, (_, row) => {
  const latitude = ((row + 1) / 28 - 0.5) * Math.PI;
  const y = Math.sin(latitude);
  const radius = Math.cos(latitude);
  return Array.from({ length: 77 }, (_, step) => {
    const angle = tau * step / 76;
    return { x: radius * Math.cos(angle), y, z: radius * Math.sin(angle),
      fold: angle * 3 + latitude * 4, wave: angle * 2 - latitude * 5 };
  });
});

const appearance: Record<GuardianOrbState, { rgb: string; glow: string; speed: number }> = {
  idle: { rgb: '120 173 155', glow: '#9bb8a5', speed: 0 },
  connecting: { rgb: '133 205 194', glow: '#c3ecdc', speed: .6 },
  listening: { rgb: '89 217 193', glow: '#acf5d7', speed: .24 },
  hearing: { rgb: '100 227 195', glow: '#d6ffde', speed: .42 },
  thinking: { rgb: '158 177 245', glow: '#dddaf7', speed: .83 },
  speaking: { rgb: '173 229 131', glow: '#ebf5ac', speed: .51 },
  paused: { rgb: '156 168 149', glow: '#b3b9a6', speed: 0 },
  unavailable: { rgb: '177 150 137', glow: '#cfafa3', speed: 0 },
};

function draw(ctx: CanvasRenderingContext2D, width: number, height: number, state: GuardianOrbState, phase: number, level: number) {
  const { rgb, glow } = appearance[state];
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(height * .346, width * .245);
  const rim = radius * 1.28;
  const turn = phase * .31 + .4;
  const sinTurn = Math.sin(turn);
  const cosTurn = Math.cos(turn);
  const tilt = .34 + .07 * Math.sin(phase * .42);
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(cx, cy);

  // A reference axis stays still while the contour moves with the speaker.
  ctx.strokeStyle = `rgb(${rgb} / .17)`;
  ctx.beginPath();
  for (const side of [-1, 1]) {
    ctx.moveTo(side * (rim + 8), .5);
    ctx.lineTo(side * Math.max(rim + 8, width * .43), .5);
  }
  ctx.stroke();
  ctx.fillStyle = `rgb(${rgb} / .3)`;
  for (const side of [-1, 1]) {
    for (let x = rim + 18; x < width * .43; x += 13) ctx.fillRect(side * x, -1.5, 1, 3);
  }
  const litBars = Math.round(level * 9);
  ctx.fillStyle = glow;
  for (let bar = 0; bar < litBars; bar++) {
    const x = rim + 9 + bar * 4;
    if (x > width * .43) break;
    const h = 2 + 7 * (litBars - bar) / 9;
    ctx.fillRect(x, -h / 2, 2, h);
    ctx.fillRect(-x - 2, -h / 2, 2, h);
  }

  const aura = ctx.createRadialGradient(0, 0, 0, 0, 0, rim);
  aura.addColorStop(0, `rgb(${rgb} / .16)`);
  aura.addColorStop(.63, `rgb(${rgb} / .07)`);
  aura.addColorStop(1, `rgb(${rgb} / 0)`);
  ctx.fillStyle = aura;
  ctx.fillRect(-rim, -rim, rim * 2, rim * 2);

  ctx.strokeStyle = `rgb(${rgb} / .45)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let tick = 0; tick < 80; tick++) {
    const angle = tick * tau / 80;
    const long = tick % 10 === 0;
    const outer = rim + (long ? 4 : 1);
    ctx.moveTo((rim - (long ? 3 : 0)) * Math.cos(angle), (rim - (long ? 3 : 0)) * Math.sin(angle));
    ctx.lineTo(outer * Math.cos(angle), outer * Math.sin(angle));
  }
  ctx.stroke();
  ctx.strokeStyle = `rgb(${rgb} / .69)`;
  for (const angle of [-1.8, .4, 2.16]) {
    ctx.beginPath();
    ctx.arc(0, 0, rim - 5, angle + turn * .39, angle + turn * .39 + .44);
    ctx.stroke();
  }

  ctx.save();
  ctx.rotate(-.18);
  const body = ctx.createRadialGradient(-radius * .35, -radius * .42, 0, 0, 0, radius);
  body.addColorStop(0, `rgb(${rgb} / .15)`);
  body.addColorStop(.7, `rgb(${rgb} / .06)`);
  body.addColorStop(1, `rgb(${rgb} / 0)`);
  ctx.fillStyle = body;
  ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
  const ink = ctx.createLinearGradient(-radius, radius, radius * .7, -radius);
  ink.addColorStop(0, `rgb(${rgb} / .25)`);
  ink.addColorStop(.28, `rgb(${rgb} / .97)`);
  ink.addColorStop(.48, glow);
  ink.addColorStop(.71, `rgb(${rgb} / .55)`);
  ink.addColorStop(1, glow);
  ctx.lineJoin = 'round';
  const near = new Path2D();
  const far = new Path2D();
  for (const ring of latitudes) {
    let previousX = 0;
    let previousY = 0;
    let previousDepth = 0;
    let previousPath: Path2D | undefined;
    for (let i = 0; i < ring.length; i++) {
      const point = ring[i];
      const fold = Math.sin(point.fold + phase);
      const surface = 1 + (.07 + level * .10) * fold + (.04 + level * .04) * Math.cos(point.wave - phase * .61);
      const depth = (point.x * sinTurn + point.z * cosTurn) * surface;
      const x = (point.x * cosTurn - point.z * sinTurn) * surface;
      const y = point.y * (.97 + .055 * fold) + level * .07 * Math.sin(point.wave + phase);
      const screenX = x * radius;
      const screenY = (y * cosTilt - depth * sinTilt) * radius;
      const screenDepth = y * sinTilt + depth * cosTilt;
      if (i) {
        const path = previousDepth + screenDepth > 0 ? near : far;
        if (path !== previousPath) path.moveTo(previousX, previousY);
        path.lineTo(screenX, screenY);
        previousPath = path;
      }
      previousX = screenX;
      previousY = screenY;
      previousDepth = screenDepth;
    }
  }
  ctx.strokeStyle = `rgb(${rgb} / .21)`;
  ctx.lineWidth = .72;
  ctx.stroke(far);
  ctx.strokeStyle = ink;
  ctx.lineWidth = .95 + level * .25;
  ctx.stroke(near);
  ctx.restore();
  ctx.restore();
}

export default function GuardianOrb({ state, levelRef }: { state: GuardianOrbState; levelRef?: Level }) {
  const language = useLanguage();
  const canvas = useRef<HTMLCanvasElement>(null);
  const phase = useRef(0);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let visible = true;
    let last = 0;
    let width = 0;
    let height = 0;
    let level = 0;
    const speed = appearance[state].speed;
    const reactive = state === 'listening' || state === 'hearing' || state === 'speaking';
    function paint(time: number) {
      frame = 0;
      if (!visible || document.hidden || width <= 0 || height <= 0) return;
      const running = speed > 0 && !reduced.matches;
      if (last === 0 || time - last >= 32) {
        const dt = last ? Math.min(time - last, 80) / 1000 : 0;
        const raw = reactive && running ? levelRef?.current ?? 0 : 0;
        const target = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
        level += (target - level) * (target > level ? .72 : .32);
        if (running) phase.current += dt * speed;
        draw(ctx!, width, height, state, phase.current, reduced.matches ? 0 : level);
        element!.dataset.drawn = 'true';
        last = time;
      }
      if (running) frame = requestAnimationFrame(paint);
    }
    function restart() {
      cancelAnimationFrame(frame);
      last = 0;
      paint(performance.now());
    }
    function resize() {
      const box = element!.getBoundingClientRect();
      width = box.width;
      height = box.height;
      const scale = Math.min(devicePixelRatio || 1, 2);
      element!.width = Math.max(1, Math.round(width * scale));
      element!.height = Math.max(1, Math.round(height * scale));
      ctx!.setTransform(scale, 0, 0, scale, 0, 0);
      restart();
    }
    const size = new ResizeObserver(resize);
    size.observe(element);
    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      restart();
    });
    visibility.observe(element);
    reduced.addEventListener('change', restart);
    document.addEventListener('visibilitychange', restart);
    resize();
    return () => {
      cancelAnimationFrame(frame);
      size.disconnect();
      visibility.disconnect();
      reduced.removeEventListener('change', restart);
      document.removeEventListener('visibilitychange', restart);
    };
  }, [state, levelRef]);

  return <figure className="guardian-orb" data-state={state}>
    <canvas ref={canvas} aria-hidden="true" />
    <figcaption role="status" aria-live="polite" aria-atomic="true">
      <span className="guardian-orb-status-light" aria-hidden="true" />
      <span translate="no">{labels[language][state]}</span>
    </figcaption>
  </figure>;
}
