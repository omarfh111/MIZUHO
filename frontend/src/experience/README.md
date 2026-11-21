# MIZUHO cinematic entrance

A ~3 s opening followed by a scrubbable 3D film: one raindrop's journey across Tunisia, from cloud to crop, powered by the sun and the wind. It ends by revealing the dashboard (M7). Everything lives in this folder and is mounted through one wrapper.

## Application entry

```tsx
import { ExperienceGate } from './experience/index.ts';

createRoot(root).render(
  <ExperienceGate mountChildrenEarly>
    <App />
  </ExperienceGate>,
);
```

The dashboard starts loading during the opening. Only its terrain renderer is suspended while the film is active, so replay preserves simulation inputs, approved plans and assistant sessions.

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

- **Input.** The film plays on its own. Scrolling, swiping, the arrow, Page or Space keys, or the chapter rail take over. After 2.5 s without input the film carries on by itself. Scrolling past the last chapter enters the dashboard. Skip intro and Escape work from the opening onward.
- **Direction.** The whole film is a pure function of scene time (`core/director.ts`, `scene/choreography.ts`), so scrubbing backwards is exact. Each chapter frames its subject on the side opposite its copy.
- **Honesty.** Geography is schematic, positions are approximate, and copy is qualitative. No live or simulated values are shown.

## Resilience

- The 3D layer is a lazy chunk, so returning visitors who skip it never download it.
- The vector intro takes over if WebGL 2 is unavailable, scene warmup times out or the context is lost.
- Reduced-motion visitors go directly to the dashboard. Replay opens manually navigated vector chapters without camera motion.
- The mobile tier uses fewer particles and a lower resolution, with vector opening and post-processing disabled. Desktop quality can adapt to lower frame rates.

## Verification

```
cd frontend
npm run test:browser
```

Run the app and its backend first. The browser checks use the real application entry point, including desktop and mobile playback, Skip and Replay, renderer cleanup and the M6/M8 walkthrough.
