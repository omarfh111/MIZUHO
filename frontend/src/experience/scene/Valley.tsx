import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Director } from '../core/director.ts';
import {
  beaconFragment, beaconVertex, canalFragment, canalVertex, panelFragment, panelVertex, plotFragment, plotVertex,
  treeFragment, treeVertex, waterFragment, waterVertex,
} from './shaders.ts';
import { PALETTE, shared } from './uniforms.ts';
import type { ValleyLayout } from './world.ts';

interface Props {
  valley: ValleyLayout;
  director: Director;
}

function useInstanced(
  count: number, matrices: Float32Array, attributes: Record<string, [Float32Array, number]>,
  prepare?: (geometry: THREE.BufferGeometry) => void,
) {
  return useMemo(() => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    prepare?.(geometry);
    for (const [name, [array, size]] of Object.entries(attributes)) {
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size));
    }
    return { geometry, matrices, count };
  }, [count, matrices]); // attributes/prepare are derived from the same layout object
}

function InstancedField({ count, matrices, geometry, material }: {
  count: number; matrices: Float32Array; geometry: THREE.BufferGeometry; material: THREE.Material;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.instanceMatrix.array.set(matrices);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [matrices]);
  return <instancedMesh ref={ref} args={[geometry, material, count]} frustumCulled={false} />;
}

export function Valley({ valley, director }: Props) {
  const plotGeo = useInstanced(valley.plots.count, valley.plots.matrices, {
    aColor: [valley.plots.colors, 3], aDelay: [valley.plots.delays, 1],
  }, (geometry) => {
    // Thin slab whose base sits just below the ground.
    geometry.translate(0, 0.5, 0);
    geometry.scale(1, 0.028, 1);
    geometry.translate(0, -0.01, 0);
  });
  const panelGeo = useInstanced(valley.panels.count, valley.panels.matrices, { aDelay: [valley.panels.delays, 1] });
  const treeGeo = useMemo(() => {
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(valley.trees.colors, 3));
    geometry.setAttribute('aDelay', new THREE.InstancedBufferAttribute(valley.trees.delays, 1));
    return { geometry, matrices: valley.trees.matrices, count: valley.trees.count };
  }, [valley]);

  const materials = useMemo(() => {
    const water = (river: boolean) => new THREE.ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      transparent: true,
      depthWrite: false,
      defines: river ? { RIVER: '' } : {},
      uniforms: { ...shared, uReveal: { value: 0 }, uExtent: { value: valley.reservoir.radius } },
    });
    return {
      reservoir: water(false),
      river: water(true),
      canals: new THREE.ShaderMaterial({
        vertexShader: canalVertex,
        fragmentShader: canalFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { ...shared, uFlow: { value: 0 }, uColor: { value: PALETTE.water } },
      }),
      plots: new THREE.ShaderMaterial({
        vertexShader: plotVertex,
        fragmentShader: plotFragment,
        uniforms: { ...shared, uReveal: { value: 0 }, uAccent: { value: PALETTE.leaf } },
      }),
      trees: new THREE.ShaderMaterial({
        vertexShader: treeVertex,
        fragmentShader: treeFragment,
        uniforms: { ...shared, uReveal: { value: 0 } },
      }),
      panels: new THREE.ShaderMaterial({
        vertexShader: panelVertex,
        fragmentShader: panelFragment,
        uniforms: { ...shared, uReveal: { value: 0 } },
      }),
      beacon: new THREE.ShaderMaterial({
        vertexShader: beaconVertex,
        fragmentShader: beaconFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uTime: shared.uTime, uOpacity: { value: 0 }, uColor: { value: PALETTE.water } },
      }),
      concrete: new THREE.MeshStandardMaterial({ color: '#9aa29a', roughness: 0.8 }),
      roof: new THREE.MeshStandardMaterial({ color: '#d7dcd2', roughness: 0.6 }),
      window: new THREE.MeshBasicMaterial({ color: new THREE.Color('#f7ce76').multiplyScalar(2.2), toneMapped: false }),
    };
  }, [valley]);

  useEffect(() => () => {
    Object.values(materials).forEach((m) => m.dispose());
    plotGeo.geometry.dispose();
    panelGeo.geometry.dispose();
    treeGeo.geometry.dispose();
  }, [materials, plotGeo, panelGeo, treeGeo]);

  const station = useRef<THREE.Group>(null);
  const dam = useRef<THREE.Mesh>(null);
  const beaconGeometry = useMemo(() => {
    const g = new THREE.CylinderGeometry(0.012, 0.05, 1.1, 16, 1, true);
    g.translate(0, 0.55, 0);
    return g;
  }, []);

  useFrame(() => {
    materials.reservoir.uniforms.uReveal.value = director.reservoir;
    materials.river.uniforms.uReveal.value = director.valley;
    materials.canals.uniforms.uFlow.value = director.canals;
    materials.plots.uniforms.uReveal.value = director.plots;
    materials.panels.uniforms.uReveal.value = director.solar;
    materials.trees.uniforms.uReveal.value = director.valley;
    materials.beacon.uniforms.uOpacity.value = director.labels;
    const built = THREE.MathUtils.smoothstep(director.reservoir, 0.1, 0.8);
    if (station.current) station.current.scale.setScalar(Math.max(0.0001, THREE.MathUtils.smoothstep(director.canals, 0, 0.25)));
    if (dam.current) dam.current.scale.set(1, Math.max(0.0001, built), 1);
  });

  const { reservoir } = valley;
  return (
    <group>
      <mesh geometry={valley.river} material={materials.river} renderOrder={2} dispose={null} />
      <mesh
        geometry={reservoir.geometry}
        material={materials.reservoir}
        position={reservoir.center}
        renderOrder={2}
        dispose={null}
      />
      <mesh ref={dam} position={valley.dam.position} material={materials.concrete}>
        <boxGeometry args={[valley.dam.width, 0.16, 0.05]} />
      </mesh>
      <group ref={station} position={valley.station}>
        <mesh material={materials.concrete} position={[0, 0.035, 0]}>
          <boxGeometry args={[0.13, 0.07, 0.08]} />
        </mesh>
        <mesh material={materials.roof} position={[0, 0.075, 0]}>
          <boxGeometry args={[0.15, 0.01, 0.1]} />
        </mesh>
        <mesh material={materials.window} position={[0, 0.04, 0.041]}>
          <planeGeometry args={[0.07, 0.014]} />
        </mesh>
      </group>
      <mesh geometry={valley.canals} material={materials.canals} renderOrder={3} dispose={null} />
      <InstancedField {...plotGeo} material={materials.plots} />
      <InstancedField {...panelGeo} material={materials.panels} />
      <InstancedField {...treeGeo} material={materials.trees} />
      {valley.pois.map((poi) => (
        <mesh key={poi.id} position={poi.position} geometry={beaconGeometry} material={materials.beacon} renderOrder={4} />
      ))}
    </group>
  );
}
