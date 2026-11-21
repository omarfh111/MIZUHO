import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Director } from '../core/director.ts';
import { MEDJERDA, toWorld } from '../core/geo.ts';
import { DROP_LANDS, makeDropPath } from './choreography.ts';
import { random } from './noise.ts';
import { PALETTE, shared } from './uniforms.ts';
import type { World } from './world.ts';

/* ------------------------------------------------------------- hero drop */

const dropVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vWorld;
  void main() {
    vec3 p = position;
    // Teardrop: taper the upper hemisphere to a soft point and stretch it.
    float up = max(p.y, 0.);
    float taper = 1. - pow(up, 1.7) * .96;
    p.xz *= taper;
    p.y *= mix(1., 1.55, step(0., p.y));
    vec3 n = normalize(vec3(normal.x * (1. + up * .6), normal.y * .8, normal.z * (1. + up * .6)));
    vec4 world = modelMatrix * vec4(p, 1.);
    vWorld = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * n);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const dropFragment = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uOpacity;
  uniform float uTime;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
  vec3 env(vec3 d) {
    float h = d.y;
    vec3 ground = mix(srgb(vec3(.12, .2, .14)), srgb(vec3(.42, .36, .22)), smoothstep(-.9, -.1, h));
    vec3 sky = mix(srgb(vec3(.96, .74, .52)), srgb(vec3(.06, .16, .2)), smoothstep(0., .6, h));
    vec3 c = h < 0. ? ground : sky;
    c += uSunColor * pow(max(dot(d, uSunDir), 0.), 300.) * 18.;
    return c;
  }
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vWorld);
    float fresnel = pow(1. - max(dot(n, v), 0.), 3.);
    vec3 refr = refract(-v, n, .75);
    vec3 refl = reflect(-v, n);
    vec3 col = env(refr) * srgb(vec3(.75, .95, 1.)) * .9;
    col = mix(col, env(refl), fresnel * .8);
    col += srgb(vec3(.55, .95, 1.)) * fresnel * 1.6;
    float caustic = pow(max(dot(-n, uSunDir), 0.), 6.);
    col += srgb(vec3(.7, 1., 1.)) * caustic * 1.2;
    gl_FragColor = vec4(col, uOpacity * (.55 + fresnel * .45));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const glowFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - .5;
    float streak = exp(-pow(p.x * 9., 2.)) * smoothstep(.5, -.2, p.y) * smoothstep(-.5, -.3, p.y);
    gl_FragColor = vec4(uColor * 1.8, streak * uOpacity);
  }
`;

const uvVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }
`;

const ringFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uPhase;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - .5) * 2.;
    float ring = exp(-pow((r - uPhase) / .035, 2.)) + exp(-pow((r - uPhase * .62) / .025, 2.)) * .5;
    float a = ring * (1. - uPhase) * uOpacity * step(r, 1.);
    if (a < .003) discard;
    gl_FragColor = vec4(uColor * 2., a);
  }
`;

export function HeroDrop({ world, director }: { world: World; director: Director }) {
  const camera = useThree((s) => s.camera);
  const path = useMemo(() => makeDropPath(world), [world]);
  const drop = useRef<THREE.Mesh>(null);
  const trail = useRef<THREE.Mesh>(null);
  const splash = useRef<THREE.Mesh>(null);
  const mats = useMemo(() => ({
    drop: new THREE.ShaderMaterial({
      vertexShader: dropVertex, fragmentShader: dropFragment, transparent: true, depthWrite: false,
      uniforms: { uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uTime: shared.uTime, uOpacity: { value: 1 } },
    }),
    trail: new THREE.ShaderMaterial({
      vertexShader: uvVertex, fragmentShader: glowFragment, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, uniforms: { uColor: { value: PALETTE.water }, uOpacity: { value: 0 } },
    }),
    splash: new THREE.ShaderMaterial({
      vertexShader: uvVertex, fragmentShader: ringFragment, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: PALETTE.water }, uOpacity: { value: 0 }, uPhase: { value: 0 } },
    }),
  }), []);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  const p = useMemo(() => new THREE.Vector3(), []);
  const ahead = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const s = director.drop;
    const falling = s < DROP_LANDS;
    path(s, p);
    path(Math.min(DROP_LANDS, s + 0.02), ahead);
    const altitude = p.y - world.valley.reservoir.center.y;
    const size = THREE.MathUtils.lerp(0.035, 0.85, THREE.MathUtils.smoothstep(altitude, 0, 90));
    if (drop.current) {
      drop.current.visible = falling;
      drop.current.position.copy(p);
      drop.current.scale.setScalar(size);
      mats.drop.uniforms.uOpacity.value = 1 - THREE.MathUtils.smoothstep(s, DROP_LANDS - 0.08, DROP_LANDS);
    }
    if (trail.current) {
      trail.current.visible = falling;
      trail.current.position.copy(p).addScaledVector(THREE.Object3D.DEFAULT_UP, size * 4);
      trail.current.scale.set(size * 1.6, size * 9, 1);
      trail.current.quaternion.copy(camera.quaternion);
      mats.trail.uniforms.uOpacity.value = 0.55 * THREE.MathUtils.smoothstep(s, 0.05, 0.4) * (1 - THREE.MathUtils.smoothstep(s, DROP_LANDS - 0.1, DROP_LANDS));
    }
    if (splash.current) {
      const phase = THREE.MathUtils.clamp((s - DROP_LANDS) / 0.9, 0, 1);
      splash.current.visible = phase > 0 && phase < 1;
      mats.splash.uniforms.uPhase.value = phase;
      mats.splash.uniforms.uOpacity.value = 1;
    }
  });

  const res = world.valley.reservoir.center;
  return (
    <group>
      <mesh ref={drop} material={mats.drop} renderOrder={8} frustumCulled={false}>
        <sphereGeometry args={[1, 48, 32]} />
      </mesh>
      <mesh ref={trail} material={mats.trail} renderOrder={7} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <mesh ref={splash} material={mats.splash} position={[res.x, res.y + 0.03, res.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={9}>
        <planeGeometry args={[2.2, 2.2]} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------ river flow */

const flowVertex = /* glsl */ `
  attribute float aSeed;
  uniform float uPixelRatio;
  varying float vSeed;
  varying float vViewDist;
  void main() {
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.);
    vViewDist = -mv.z;
    gl_PointSize = (14. + aSeed * 16.) * uPixelRatio / max(-mv.z, .5) * 6.;
    gl_Position = projectionMatrix * mv;
  }
`;

const flowFragment = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uColor;
  varying float vSeed;
  varying float vViewDist;
  void main() {
    float d = length(gl_PointCoord - .5);
    float a = smoothstep(.5, 0., d);
    gl_FragColor = vec4(uColor * (1.4 + vSeed), a * a * uOpacity);
  }
`;

export function RiverFlow({ world, director, count }: { world: World; director: Director; count: number }) {
  const dpr = useThree((s) => s.viewport.dpr);
  const data = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(MEDJERDA.map((ll) => {
      const { x, z } = toWorld(ll);
      return new THREE.Vector3(x, 0, z);
    }), false, 'centripetal');
    const samples = curve.getSpacedPoints(600).map((p) => {
      p.y = world.heightAt(p.x, p.z) + 0.14;
      return p;
    });
    const rand = random(13);
    const offsets = new Float32Array(count);
    const lanes = new Float32Array(count);
    const speeds = new Float32Array(count);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      offsets[i] = rand();
      lanes[i] = (rand() - 0.5) * 2;
      speeds[i] = 0.018 + rand() * 0.02;
      seeds[i] = rand();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: flowVertex, fragmentShader: flowFragment, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPixelRatio: { value: 1 }, uOpacity: { value: 0 }, uColor: { value: PALETTE.water } },
    });
    return { samples, offsets, lanes, speeds, geometry: g, material: m };
  }, [world, count]);
  useEffect(() => () => {
    data.geometry.dispose();
    data.material.dispose();
  }, [data]);
  const ref = useRef<THREE.Points>(null);

  useFrame((state) => {
    const visible = director.river > 0.001;
    if (ref.current) ref.current.visible = visible;
    if (!visible) return;
    data.material.uniforms.uOpacity.value = director.river;
    data.material.uniforms.uPixelRatio.value = dpr;
    const t = state.clock.elapsedTime;
    const position = data.geometry.attributes.position as THREE.BufferAttribute;
    const arr = position.array as Float32Array;
    const n = data.samples.length - 1;
    for (let i = 0; i < data.offsets.length; i++) {
      const f = (data.offsets[i] + t * data.speeds[i]) % 1;
      const k = f * n;
      const j = Math.floor(k);
      const a = data.samples[j];
      const b = data.samples[Math.min(n, j + 1)];
      const u = k - j;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const lane = data.lanes[i] * 0.22;
      arr[i * 3] = a.x + dx * u - (dz / len) * lane;
      arr[i * 3 + 1] = a.y + (b.y - a.y) * u;
      arr[i * 3 + 2] = a.z + dz * u + (dx / len) * lane;
    }
    position.needsUpdate = true;
  });
  return <points ref={ref} geometry={data.geometry} material={data.material} frustumCulled={false} renderOrder={6} />;
}

/* ------------------------------------------------------------ dam pulses */

const pillarFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float fade = pow(1. - vUv.y, 2.4);
    float scan = .7 + .3 * sin(vUv.y * 30. - uTime * 5.);
    gl_FragColor = vec4(uColor * 2.2, fade * scan * uOpacity * .75);
  }
`;

export function DamPulses({ world, director }: { world: World; director: Director }) {
  const dams = useMemo(() => world.places.filter((p) => p.kind === 'dam'), [world]);
  const { ring, pillar, rings } = useMemo(() => {
    const pillarMat = new THREE.ShaderMaterial({
      vertexShader: uvVertex, fragmentShader: pillarFragment, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: PALETTE.water }, uOpacity: { value: 0 }, uTime: shared.uTime },
    });
    const ringMats = dams.map(() => new THREE.ShaderMaterial({
      vertexShader: uvVertex, fragmentShader: ringFragment, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: PALETTE.water }, uOpacity: { value: 0 }, uPhase: { value: 0 } },
    }));
    const pillarGeometry = new THREE.CylinderGeometry(0.06, 0.3, 9, 20, 1, true);
    pillarGeometry.translate(0, 4.5, 0);
    return { ring: new THREE.PlaneGeometry(1, 1), pillar: { geometry: pillarGeometry, material: pillarMat }, rings: ringMats };
  }, [dams]);
  useEffect(() => () => {
    ring.dispose();
    pillar.geometry.dispose();
    pillar.material.dispose();
    rings.forEach((m) => m.dispose());
  }, [ring, pillar, rings]);
  const group = useRef<THREE.Group>(null);

  useFrame((state) => {
    const amount = director.dams;
    if (group.current) group.current.visible = amount > 0.001;
    if (amount <= 0.001) return;
    pillar.material.uniforms.uOpacity.value = amount;
    const t = state.clock.elapsedTime;
    rings.forEach((m, i) => {
      m.uniforms.uPhase.value = (t * 0.45 + i * 0.21) % 1;
      m.uniforms.uOpacity.value = amount;
    });
  });

  return (
    <group ref={group}>
      {dams.map((dam, i) => (
        <group key={dam.id} position={[dam.position.x, dam.position.y + 0.05, dam.position.z]}>
          <mesh geometry={pillar.geometry} material={pillar.material} renderOrder={6} />
          <mesh geometry={ring} material={rings[i]} rotation={[-Math.PI / 2, 0, 0]} scale={5} renderOrder={6} />
        </group>
      ))}
    </group>
  );
}
