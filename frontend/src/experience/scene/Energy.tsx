import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Director } from '../core/director.ts';
import { canalFragment, canalVertex } from './shaders.ts';
import { PALETTE, shared } from './uniforms.ts';
import type { ValleyLayout } from './world.ts';

/**
 * The valley's renewable layer: wind turbines on both ridges and the power
 * they send, with the solar field's, along amber cables to the pumping station.
 */

function bladeGeometry() {
  // A slim, tapered blade with a slight twist, root at the origin, tip along +y.
  const shape = new THREE.Shape();
  shape.moveTo(-0.012, 0);
  shape.quadraticCurveTo(-0.02, 0.05, -0.008, 0.2);
  shape.lineTo(0.002, 0.205);
  shape.quadraticCurveTo(0.012, 0.06, 0.012, 0);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: false });
  g.translate(0, 0, -0.002);
  return g;
}

export function Energy({ valley, director }: { valley: ValleyLayout; director: Director }) {
  const parts = useMemo(() => {
    const tower = new THREE.CylinderGeometry(0.006, 0.013, 1, 12, 1);
    tower.translate(0, 0.5, 0);
    return {
      tower,
      nacelle: new THREE.BoxGeometry(0.05, 0.022, 0.022),
      hub: new THREE.SphereGeometry(0.011, 12, 8),
      blade: bladeGeometry(),
      beacon: new THREE.SphereGeometry(0.006, 8, 6),
      white: new THREE.MeshStandardMaterial({ color: '#eef2ee', roughness: 0.45, metalness: 0.1 }),
      red: new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3b30').multiplyScalar(3), toneMapped: false, transparent: true }),
      power: new THREE.ShaderMaterial({
        vertexShader: canalVertex,
        fragmentShader: canalFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { ...shared, uFlow: { value: 0 }, uColor: { value: PALETTE.sun } },
      }),
    };
  }, []);
  useEffect(() => () => {
    Object.values(parts).forEach((p) => p.dispose());
  }, [parts]);

  const rigs = useRef<(THREE.Group | null)[]>([]);
  const rotors = useRef<(THREE.Group | null)[]>([]);
  const spin = useRef(0);
  const group = useRef<THREE.Group>(null);

  useFrame((state, delta) => {
    const energy = director.solar;
    if (group.current) group.current.visible = director.valley > 0.05;
    // Rotors spin up as the energy chapter arrives, then keep turning.
    spin.current += delta * (0.6 + 2.2 * energy);
    valley.turbines.forEach((t, i) => {
      const rig = rigs.current[i];
      const rotor = rotors.current[i];
      // Turbines rise in sequence along the ridge.
      const rise = THREE.MathUtils.smoothstep(director.valley * 1.4 - i * 0.05, 0.25, 1);
      if (rig) rig.scale.set(1, Math.max(0.0001, rise), 1);
      if (rotor) rotor.rotation.z = spin.current + t.phase;
    });
    parts.red.opacity = (Math.sin(state.clock.elapsedTime * 3) > 0.6 ? 1 : 0.15) * director.valley;
    parts.power.uniforms.uFlow.value = THREE.MathUtils.smoothstep(director.solar, 0.15, 1);
  });

  return (
    <group ref={group}>
      {valley.turbines.map((t, i) => (
        <group key={i} position={t.position} rotation={[0, t.yaw, 0]}>
          <group ref={(el) => { rigs.current[i] = el; }}>
            <mesh geometry={parts.tower} material={parts.white} scale={[1, t.height, 1]} />
            <group position={[0, t.height, 0]}>
              <mesh geometry={parts.nacelle} material={parts.white} position={[-0.012, 0, 0]} />
              <mesh geometry={parts.beacon} material={parts.red} position={[-0.02, 0.014, 0]} />
              <group position={[0.016, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
                <group ref={(el) => { rotors.current[i] = el; }}>
                  <mesh geometry={parts.hub} material={parts.white} />
                  {[0, 1, 2].map((b) => (
                    <mesh key={b} geometry={parts.blade} material={parts.white} rotation={[0, 0, (b * Math.PI * 2) / 3]} />
                  ))}
                </group>
              </group>
            </group>
          </group>
        </group>
      ))}
      <mesh geometry={valley.power} material={parts.power} renderOrder={3} dispose={null} />
    </group>
  );
}

/** Key and fill lights for the few lit (non-shader) materials, matched to the shader sun. */
export function SceneLights() {
  const sun = shared.uSunDir.value;
  return (
    <>
      <hemisphereLight args={['#cfe6ea', '#4a3f2c', 1.1]} />
      <directionalLight position={[sun.x * 100, sun.y * 100, sun.z * 100]} intensity={2.4} color={shared.uSunColor.value} />
    </>
  );
}
