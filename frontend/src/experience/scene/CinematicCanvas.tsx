import { PerformanceMonitor } from '@react-three/drei/core/PerformanceMonitor.js';
import { Canvas, useThree } from '@react-three/fiber';
import {
  Bloom, BrightnessContrast, ChromaticAberration, EffectComposer, HueSaturation, Noise, ToneMapping, Vignette,
} from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useLanguage } from '../../i18n/language.ts';
import type { Quality, Tier } from '../core/capabilities.ts';
import type { Director } from '../core/director.ts';
import { CloudVeil, Clouds, Particles, Sky } from './Atmosphere.tsx';
import { CameraRig, type RigHandle } from './CameraRig.tsx';
import { makeDropPath } from './choreography.ts';
import { Energy, SceneLights } from './Energy.tsx';
import { Labels } from './Labels.tsx';
import { Storm } from './Storm.tsx';
import { DamPulses, HeroDrop, RenewableSites, RiverFlow } from './StoryLayers.tsx';
import { Terrain } from './Terrain.tsx';
import { FOG_COLOR } from './uniforms.ts';
import { Valley } from './Valley.tsx';
import { buildWorld, type Progress, type World } from './world.ts';

const worldCache = new Map<Tier, Promise<World>>();

/** Builds (once per tier) the procedural world. Replays reuse the cached result. */
export function prepareWorld(tier: Tier, quality: Quality, onTerrain: Progress, onValley: Progress) {
  let pending = worldCache.get(tier);
  if (!pending) {
    pending = buildWorld(quality, onTerrain, onValley);
    pending.catch(() => worldCache.delete(tier));
    worldCache.set(tier, pending);
  } else {
    pending.then(() => {
      onTerrain(1);
      onValley(1);
    }, () => undefined);
  }
  return pending;
}

/** Compiles every program up front, renders a first frame, then reports readiness. */
function RendererLifecycle({ onReady, onContextLost }: Pick<CinematicCanvasProps, 'onReady' | 'onContextLost'>) {
  const { gl, scene, camera } = useThree();
  useLayoutEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => {
      event.preventDefault();
      onContextLost();
    };
    canvas.addEventListener('webglcontextlost', lost);
    return () => {
      canvas.removeEventListener('webglcontextlost', lost);
      if (!gl.getContext().isContextLost()) gl.forceContextLoss();
    };
  }, [gl, onContextLost]);
  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    const finish = () => {
      if (cancelled) return;
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(onReady); });
    };
    gl.compileAsync(scene, camera).then(finish, () => { if (!cancelled) onContextLost(); });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [gl, scene, camera, onReady, onContextLost]);
  return null;
}

export interface CinematicCanvasProps {
  world: World;
  director: Director;
  quality: Quality;
  hud: RigHandle;
  labelLayer: HTMLElement | null;
  onReady: () => void;
  onContextLost: () => void;
}

export default function CinematicCanvas({ world, director, quality, hud, labelLayer, onReady, onContextLost }: CinematicCanvasProps) {
  const language = useLanguage();
  const [dpr, setDpr] = useState(quality.dpr[1]);
  // `?mxpost=0` disables post-processing, for performance triage on weak devices.
  const [post, setPost] = useState(() => quality.postprocessing && new URLSearchParams(window.location.search).get('mxpost') !== '0');
  const revealOrigin = world.valley.reservoir.center;
  const aberration = useMemo(() => new THREE.Vector2(0.0009, 0.0006), []);
  const dropPath = useMemo(() => makeDropPath(world), [world]);
  const v = world.valley.center;
  const valleyMotes = useMemo(() => ({
    min: new THREE.Vector3(v.x - 4, v.y - 0.1, v.z - 4),
    size: new THREE.Vector3(8, 3.2, 8),
  }), [v]);
  const highDust = useMemo(() => ({
    min: new THREE.Vector3(-70, 4, -110),
    size: new THREE.Vector3(140, 110, 200),
  }), []);

  return (
    <Canvas
      className="mx-canvas"
      dpr={[quality.dpr[0], dpr]}
      gl={{ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false }}
      camera={{ fov: 34, near: 0.03, far: 2000, position: [0, 140, 0] }}
      onCreated={({ gl }) => gl.setClearColor(FOG_COLOR)}
    >
      <PerformanceMonitor
        onDecline={() => setDpr((d) => Math.max(1, d - 0.25))}
        onFallback={() => setPost(false)}
        flipflops={3}
      />
      <Sky />
      <Terrain world={world} director={director} revealOrigin={revealOrigin} />
      <SceneLights />
      <Valley valley={world.valley} director={director} />
      <Energy valley={world.valley} director={director} />
      <Labels world={world} director={director} layer={labelLayer} language={language} />
      <Clouds director={director} path={dropPath} />
      <HeroDrop world={world} director={director} />
      <CloudVeil director={director} />
      <Storm world={world} director={director} streaks={quality.particles * 3} />
      <RiverFlow world={world} director={director} count={Math.round(quality.particles * 0.7)} />
      <DamPulses world={world} director={director} />
      <RenewableSites world={world} director={director} />
      <Particles
        count={Math.round(quality.particles * 0.6)}
        {...valleyMotes}
        pointSize={9}
        seed={3}
        director={director}
        opacity={(d) => d.valley * (1 - d.exit * 0.6)}
      />
      <Particles
        count={Math.round(quality.particles * 0.4)}
        {...highDust}
        pointSize={120}
        seed={9}
        director={director}
        opacity={(d) => d.mapReveal * (1 - d.valley) * 0.55}
      />
      <CameraRig world={world} director={director} hud={hud} />
      <RendererLifecycle onReady={onReady} onContextLost={onContextLost} />
      {post ? (
        <EffectComposer multisampling={quality.dpr[1] > 1.5 ? 4 : 0} enableNormalPass={false}>
          <Bloom mipmapBlur luminanceThreshold={0.78} luminanceSmoothing={0.22} intensity={0.95} radius={0.75} />
          <ChromaticAberration
            offset={aberration}
            radialModulation
            modulationOffset={0.35}
            blendFunction={BlendFunction.NORMAL}
          />
          <ToneMapping mode={ToneMappingMode.AGX} />
          <HueSaturation saturation={0.08} />
          <BrightnessContrast contrast={0.08} />
          <Vignette offset={0.26} darkness={0.7} />
          <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.28} />
        </EffectComposer>
      ) : <></>}
    </Canvas>
  );
}
