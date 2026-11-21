# MIZUHO cinematic entrance

A ~3 s opening followed by a scrubbable 3D film: one raindrop's journey across Tunisia, from cloud to crop, powered by the sun and the wind. It ends by revealing the dashboard (M7). Everything lives in this folder and is mounted through one wrapper.

## Integrating with M7

```tsx
import { ExperienceGate } from './experience';

createRoot(root).render(
  <ExperienceGate preload={() => import('./App')}>
    <App />
  </ExperienceGate>,
);
```

M7 needs these dependencies (versions match the harness):

```
npm i @react-three/fiber@^9.8.2 @react-three/drei@^10.7.9 @react-three/postprocessing@^3.2.2 postprocessing@^6.39.6 gsap@^3.15.1
```

`three`, `react`, `react-dom` and the two `@fontsource-variable` fonts are already in M7.

| Prop | Default | Purpose |
| --- | --- | --- |
| `play` | `'session'` | `'session'`, `'once'`, `'always'` or `'never'`. `?intro=1` / `?intro=0` override it. |
| `preload` | none | A promise counted in the opening's progress (an app chunk, a first fetch). |
| `mountChildrenEarly` | `false` | By default the app mounts during the last chapters, behind the film, so it is painted before the reveal. |
| `replayButton` | `true` | Floating "Replay intro" pill once the dashboard shows. |
| `onComplete` | none | Called when the dashboard is fully revealed. |

`useExperience().replay()` lets M7 put its own replay control anywhere.

## The film

| Time | Chapter | Device |
| --- | --- | --- |
| Opening | MIZUHO | Water mist in the brand's water, land and sun colours condenses into the wordmark as loading really progresses, then spirals into the falling drop |
| 0 | Every drop counts | The camera rides the falling drop through a cloud deck as Tunisia unfolds below |
| 1 | Rain falls in the north | Rain streaks over the northern governorates only |
| 2 | One river carries it | Flow particles travel down the Medjerda, with real dams and towns labelled |
| 3 | Dams hold the year | Light pillars and pulses at five real reservoirs; the drop lands in Bou Heurtma |
| 4 | Canals bring it home | The Jendouba valley assembles; canals fill, plots grow; the cursor waters the soil |
| 5 | Sun and wind power the pumps | A utility-scale solar field and wind turbines on both ridges; amber power flows along cables to the pumping station |
| 6 | Clean energy for every drop | The camera rises over Tunisia's operating renewable plants: the Sidi Daoud and Bizerte wind farms and the Tozeur solar plant |
| 7 | MIZUHO | A dive back to the valley; a digital-twin grid settles; "Enter the observatory" |

- **Input.** The film autoplays until the visitor scrolls, swipes, uses the arrow, Page or Space keys, or clicks the chapter rail. From then on, scene time follows input through a critically damped spring, which behaves the same at any frame rate. Scrolling past the last chapter enters the dashboard. Esc skips at any point.
- **Direction.** The whole film is a pure function of scene time (`core/director.ts`, `scene/choreography.ts`), so scrubbing backwards is exact. Each chapter frames its subject on the side opposite its copy.
- **Honesty.** Geography is schematic, positions are approximate, and copy is qualitative. No live or simulated values are shown. A permanent note says so.

## Resilience

- The 3D layer is a lazy chunk, so returning visitors who skip it never download it.
- There is no WebGL 2, the scene fails to build, or the context is lost: a vector intro or an immediate reveal takes over.
- `prefers-reduced-motion`: the intro is skipped by default. On replay, chapters cut through a short dip instead of flying.
- `PerformanceMonitor` lowers the resolution, then drops post-processing on weak GPUs.

## Standalone harness

`frontend/experience-preview` runs the experience in front of an M7 stand-in:

```
cd frontend/experience-preview
npm install
npm run dev
```
