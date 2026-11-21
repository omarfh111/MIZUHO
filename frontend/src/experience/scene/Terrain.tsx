import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Director } from '../core/director.ts';
import { VALLEY_RADIUS } from '../core/geo.ts';
import { mapFragment, mapVertex, valleyFragment, valleyVertex } from './shaders.ts';
import { shared } from './uniforms.ts';
import type { World } from './world.ts';

interface Props {
  world: World;
  director: Director;
  revealOrigin: THREE.Vector3;
}

export function Terrain({ world, director, revealOrigin }: Props) {
  const { valley } = world;

  const mapMaterial = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: mapVertex,
    fragmentShader: mapFragment,
    uniforms: {
      ...shared,
      uLand: { value: world.landTexture },
      uReveal: { value: 0 },
      uRevealOrigin: { value: revealOrigin },
      uValleyCenter: { value: valley.center },
      uValleyRadius: { value: VALLEY_RADIUS },
      uValley: { value: 0 },
    },
  }), [world, valley, revealOrigin]);

  const valleyMaterial = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: valleyVertex,
    fragmentShader: valleyFragment,
    transparent: true,
    uniforms: {
      ...shared,
      uReveal: { value: 0 },
      uPresence: { value: 0 },
      uOrigin: { value: valley.station },
      uCenter: { value: valley.center },
      uRadius: { value: VALLEY_RADIUS },
      uTwin: { value: 0 },
      uWet: { value: new THREE.Vector3() },
      uWetAmount: { value: 0 },
    },
  }), [valley]);
  const camera = useThree((s) => s.camera);
  const probe = useMemo(() => ({
    ray: new THREE.Raycaster(),
    ndc: new THREE.Vector2(),
    plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -valley.center.y),
    hit: new THREE.Vector3(),
    wet: 0,
  }), [valley]);

  useEffect(() => () => {
    mapMaterial.dispose();
    valleyMaterial.dispose();
  }, [mapMaterial, valleyMaterial]);

  useFrame((_, delta) => {
    // Project the pointer onto the valley floor for the irrigation lamp.
    const u = valleyMaterial.uniforms;
    const want = director.pointer.active && director.valley > 0.9 ? 1 - director.twin * 0.6 : 0;
    probe.wet += (want - probe.wet) * (1 - Math.exp(-delta * 4));
    u.uWetAmount.value = probe.wet;
    if (director.pointer.active) {
      probe.ndc.set(director.pointer.x, director.pointer.y);
      probe.ray.setFromCamera(probe.ndc, camera);
      if (probe.ray.ray.intersectPlane(probe.plane, probe.hit)) (u.uWet.value as THREE.Vector3).lerp(probe.hit, 1 - Math.exp(-delta * 10));
    }
    u.uTwin.value = director.twin;
    mapMaterial.uniforms.uReveal.value = director.mapReveal;
    mapMaterial.uniforms.uValley.value = director.valley;
    valleyMaterial.uniforms.uReveal.value = director.valley;
    // The perimeter shows up as a faint holographic target once the map is revealed.
    valleyMaterial.uniforms.uPresence.value = Math.min(1, Math.max(0, (director.mapReveal - 0.55) * 2.2)) * 0.75;
  });

  return (
    <group>
      <mesh geometry={world.mapGeometry} material={mapMaterial} dispose={null} />
      <mesh geometry={valley.geometry} material={valleyMaterial} renderOrder={1} dispose={null} />
    </group>
  );
}
