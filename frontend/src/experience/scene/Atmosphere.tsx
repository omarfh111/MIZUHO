import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Director } from '../core/director.ts';
import { random } from './noise.ts';
import {
  cloudFragment, cloudVertex, particleFragment, particleVertex, skyFragment, skyVertex,
} from './shaders.ts';
import { PALETTE, shared } from './uniforms.ts';

export function Sky() {
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color('#020809') },
      uHorizon: { value: shared.uFogColor.value },
      uGlow: { value: new THREE.Color('#f2b27a') },
      uSunDir: shared.uSunDir,
    },
  }), []);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh material={material} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[900, 32, 16]} />
    </mesh>
  );
}

interface ParticleProps {
  count: number;
  min: THREE.Vector3;
  size: THREE.Vector3;
  pointSize: number;
  opacity: (director: Director) => number;
  director: Director;
  seed: number;
}

export function Particles({ count, min, size, pointSize, opacity, director, seed }: ParticleProps) {
  const dpr = useThree((s) => s.viewport.dpr);
  const { geometry, material } = useMemo(() => {
    const rand = random(seed);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = min.x + rand() * size.x;
      positions[i * 3 + 1] = min.y + rand() * size.y;
      positions[i * 3 + 2] = min.z + rand() * size.z;
      seeds[i] = rand();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: particleVertex,
      fragmentShader: particleFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: shared.uTime,
        uSize: { value: pointSize },
        uPixelRatio: { value: 1 },
        uBoxMin: { value: min },
        uBoxSize: { value: size },
        uColorA: { value: PALETTE.mote },
        uColorB: { value: PALETTE.water },
        uOpacity: { value: 0 },
      },
    });
    return { geometry: g, material: m };
  }, [count, min, size, pointSize, seed]);
  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);
  useFrame(() => {
    material.uniforms.uPixelRatio.value = dpr;
    material.uniforms.uOpacity.value = opacity(director);
  });
  return <points geometry={geometry} material={material} frustumCulled={false} />;
}

/** A cloud deck the hero drop (and the camera) falls through. */
export function Clouds({ director, path }: { director: Director; path: (s: number, out?: THREE.Vector3) => THREE.Vector3 }) {
  const camera = useThree((s) => s.camera);
  const group = useRef<THREE.Group>(null);
  const clouds = useMemo(() => {
    const rand = random(77);
    return Array.from({ length: 22 }, (_, i) => {
      const material = new THREE.ShaderMaterial({
        vertexShader: cloudVertex,
        fragmentShader: cloudFragment,
        transparent: true,
        depthWrite: false,
        uniforms: {
          ...shared,
          uSeed: { value: rand() * 50 },
          uOpacity: { value: 0 },
          uLit: { value: new THREE.Color('#ffe6c8') },
          uShade: { value: new THREE.Color('#47656b') },
        },
      });
      const along = path(0.08 + (i / 21) * 0.7, new THREE.Vector3());
      const angle = rand() * Math.PI * 2;
      const radius = 5 + rand() * 18;
      const position = along.add(new THREE.Vector3(Math.cos(angle) * radius, (rand() - 0.5) * 8, Math.sin(angle) * radius));
      return { material, position, scale: 12 + rand() * 20 };
    });
  }, [path]);
  useEffect(() => () => clouds.forEach((c) => c.material.dispose()), [clouds]);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.visible = director.clouds > 0.001;
    if (!g.visible) return;
    g.children.forEach((child, i) => {
      child.quaternion.copy(camera.quaternion);
      clouds[i].material.uniforms.uOpacity.value = director.clouds;
    });
  });
  return (
    <group ref={group}>
      {clouds.map((cloud, i) => (
        <mesh key={i} position={cloud.position} scale={cloud.scale} material={cloud.material} renderOrder={5}>
          <planeGeometry args={[1, 0.6]} />
        </mesh>
      ))}
    </group>
  );
}

const veilVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy * 2., 0., 1.); }
`;

const veilFragment = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uLit;
  uniform vec3 uShade;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
  float fbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.1 + 3.7; a *= .5; } return s; }
  void main() {
    // Falling through cloud: wisps rush upward past the lens and part at the centre.
    vec2 p = vUv * vec2(2.2, 1.4) + vec2(0., uTime * .9);
    float d = fbm(p) * .65 + fbm(p * 2.3 + vec2(uTime * .2, uTime * 1.6)) * .35;
    float centre = smoothstep(.15, .75, length(vUv - .5) * 1.6);
    float a = smoothstep(.32, .7, d) * mix(.55, 1., centre) * uOpacity;
    vec3 col = mix(uShade, uLit, smoothstep(.3, .9, d) * .7 + vUv.y * .3);
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Screen-space cloud the camera plunges through while riding the drop. */
export function CloudVeil({ director }: { director: Director }) {
  const ref = useRef<THREE.Mesh>(null);
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: veilVertex,
    fragmentShader: veilFragment,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uTime: shared.uTime,
      uOpacity: { value: 0 },
      uLit: { value: new THREE.Color('#fff1de') },
      uShade: { value: new THREE.Color('#6f8a90') },
    },
  }), []);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(() => {
    material.uniforms.uOpacity.value = director.veil;
    if (ref.current) ref.current.visible = director.veil > 0.002;
  });
  return (
    <mesh ref={ref} material={material} frustumCulled={false} renderOrder={20}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}
