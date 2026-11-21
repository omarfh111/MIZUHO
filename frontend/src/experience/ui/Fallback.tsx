import { useMemo, type CSSProperties } from 'react';
import { ENERGY_SITES, MEDJERDA, PLACES, TUNISIA_OUTLINE, DJERBA, type LonLat } from '../core/geo.ts';

/**
 * Lightweight vector intro used when WebGL is unavailable or the 3D scene
 * fails. Same chapters and copy, drawn as an animated SVG map.
 */

const K = 60;
const WEST = 7.2;
const NORTH = 37.6;
const project = ([lon, lat]: LonLat) => [(lon - WEST) * K, (NORTH - lat) * K] as const;
const toPath = (points: readonly LonLat[], close = false) =>
  points.map((p, i) => `${i ? 'L' : 'M'}${project(p).map((v) => v.toFixed(1)).join(' ')}`).join('') + (close ? 'Z' : '');

export function Fallback({ chapter }: { chapter: number }) {
  const shapes = useMemo(() => ({
    outline: toPath(TUNISIA_OUTLINE, true),
    djerba: toPath(DJERBA, true),
    river: toPath(MEDJERDA),
    places: PLACES.map((place) => ({ ...place, xy: project(place.at) })),
    energy: ENERGY_SITES.map((site) => ({ ...site, xy: project(site.at) })),
    focus: project([8.77, 36.54]),
  }), []);

  return (
    <div className="mx-fallback" data-chapter={chapter} aria-hidden>
      <svg viewBox="0 0 276 450" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="mx-fb-land" cx="30%" cy="15%" r="90%">
            <stop offset="0" stopColor="#2f4a2a" />
            <stop offset=".45" stopColor="#5c5a3a" />
            <stop offset="1" stopColor="#8a6d40" />
          </radialGradient>
        </defs>
        <g
          className="mx-fallback__map"
          style={{ transformOrigin: `${shapes.focus[0]}px ${shapes.focus[1]}px` }}
        >
          <g className="mx-fallback__grid">
            {Array.from({ length: 5 }, (_, i) => <line key={`v${i}`} x1={(i + 1) * K} y1="0" x2={(i + 1) * K} y2="450" />)}
            {Array.from({ length: 8 }, (_, i) => <line key={`h${i}`} x1="0" y1={(i + 0.6) * K} x2="276" y2={(i + 0.6) * K} />)}
          </g>
          <path className="mx-fallback__land" d={shapes.outline} />
          <path className="mx-fallback__land" d={shapes.djerba} />
          <path className="mx-fallback__coast" d={shapes.outline} pathLength={1} />
          <path className="mx-fallback__river" d={shapes.river} pathLength={1} />
          {shapes.places.map((place, i) => (
            <g key={place.id} className={`mx-fallback__place mx-fallback__place--${place.kind}`} style={{ '--i': i } as CSSProperties}>
              <circle cx={place.xy[0]} cy={place.xy[1]} r={place.kind === 'dam' ? 2.4 : 1.6} />
              <circle className="mx-fallback__pulse" cx={place.xy[0]} cy={place.xy[1]} r="2.4" />
            </g>
          ))}
          {shapes.energy.map((site) => (
            <g key={site.id} className={`mx-fallback__energy mx-fallback__energy--${site.kind}`}>
              <circle cx={site.xy[0]} cy={site.xy[1]} r="3.2" />
              <circle className="mx-fallback__pulse" cx={site.xy[0]} cy={site.xy[1]} r="3.2" />
            </g>
          ))}
          <circle className="mx-fallback__focus" cx={shapes.focus[0]} cy={shapes.focus[1]} r="9" />
        </g>
      </svg>
    </div>
  );
}
