import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Director } from '../core/director.ts';
import { random } from './noise.ts';
import { cloudFragment, cloudVertex } from './shaders.ts';
import { shared } from './uniforms.ts';
import type { World } from './world.ts';

/**
 * Chapter "Rain falls in the north": a storm system over the Tell.
 *  - storm clouds: dark, sun-rimmed, lit from inside by lightning
 *  - rain shafts: translucent curtains hanging under the cloud base
 *  - streaks: motion-blurred drops around the camera for parallax
 * Lightning timing is a pure function of the clock, so it never accumulates.
 */

/** Sporadic double-pulse flashes, roughly every few seconds. */
export const lightning = (t: number) => {
  const beat = Math.max(0, Math.sin(t * 1.31) * Math.sin(t * 0.47 + 1.7));
  const pulse = Math.pow(beat, 28) * (0.6 + 0.4 * Math.sin(t * 40) ** 2);
  return Math.min(1, pulse * 3);
};

const shaftVertex = /* glsl */ `
  varying vec2 vUv;
  varying float vViewDist;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.);
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const shaftFragment = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uSeed;
  uniform float uFlash;
  varying vec2 vUv;
  varying float vViewDist;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    // Streaky density falling fast, with slow lateral billowing.
    vec2 p = vec2(vUv.x * 7. + uSeed + sin(vUv.y * 3. + uTime * .4) * .25, vUv.y * 1.5 + uTime * 2.6);
    float streaks = noise(p * vec2(6., .6)) * .6 + noise(p * vec2(14., 1.2)) * .4;
    float body = smoothstep(0., .25, vUv.x) * smoothstep(1., .75, vUv.x);
    float vertical = smoothstep(0., .18, vUv.y) * smoothstep(1., .82, vUv.y);
    float edgeBreak = noise(vec2(vUv.x * 3. + uSeed, uTime * .1)) * .5 + .5;
    float a = body * vertical * (.35 + .65 * streaks) * edgeBreak * uOpacity;
    a *= smoothstep(4., 18., vViewDist);
    vec3 col = mix(vec3(.24, .3, .34), vec3(.62, .7, .74), vUv.y) + vec3(.8, .85, 1.) * uFlash * .6;
    gl_FragColor = vec4(col, a * .55);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const streakVertex = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec2 aSeed;
  uniform float uTime;
  uniform vec3 uBoxMin;
  uniform vec3 uBoxSize;
  uniform vec3 uCam;
  varying float vAlpha;
  varying float vV;
  void main() {
    vec3 o = aOffset;
    float speed = 30. + aSeed.x * 18.;
    o.y = uBoxMin.y + mod(o.y - uBoxMin.y - uTime * speed, uBoxSize.y);
    o.x += (o.y - uBoxMin.y) * .18;
    // Cylindrical billboard: the quad turns around the vertical axis to face the camera.
    vec3 toCam = uCam - o;
    vec3 side = normalize(vec3(toCam.z, 0., -toCam.x) + vec3(1e-4, 0., 0.));
    float len = 1.6 + aSeed.y * 2.2;
    float width = .035 + aSeed.x * .035;
    vec3 p = o + side * position.x * width + vec3(.18, 1., 0.) * position.y * len;
    float lat = -o.z / 24. + 34.;
    vAlpha = (.35 + .65 * aSeed.y) * smoothstep(35.1, 35.9, lat);
    vV = position.y + .5;
    vec4 mv = viewMatrix * vec4(p, 1.);
    vAlpha *= smoothstep(1.5, 6., -mv.z) * (1. - smoothstep(40., 80., -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const streakFragment = /* glsl */ `
  uniform float uOpacity;
  uniform float uFlash;
  varying float vAlpha;
  varying float vV;
  void main() {
    float head = smoothstep(0., .9, vV) * smoothstep(1., .85, vV);
    vec3 col = vec3(.72, .86, .9) + vec3(.6) * uFlash;
    gl_FragColor = vec4(col * 1.3, head * vAlpha * uOpacity);
    gl_FragColor = clamp(gl_FragColor, vec4(0.), vec4(64000.));
  }
`;

export function Storm({ world, director, streaks }: { world: World; director: Director; streaks: number }) {
  const camera = useThree((s) => s.camera);
  const v = world.valley.center;
  const group = useRef<THREE.Group>(null);

  const clouds = useMemo(() => {
    const rand = random(404);
    return Array.from({ length: 26 }, () => {
      const material = new THREE.ShaderMaterial({
        vertexShader: cloudVertex,
        fragmentShader: cloudFragment,
        transparent: true,
        depthWrite: false,
        uniforms: {
          ...shared,
          uSeed: { value: rand() * 50 },
          uOpacity: { value: 0 },
          uLit: { value: new THREE.Color('#c9c3b8') },
          uShade: { value: new THREE.Color('#1c262b') },
        },
      });
      const position = new THREE.Vector3(v.x - 14 + rand() * 46, 17 + rand() * 6, v.z - 22 + rand() * 30);
      return { material, position, scale: 16 + rand() * 18, base: new THREE.Color('#c9c3b8') };
    });
  }, [v]);

  const shafts = useMemo(() => {
    const rand = random(808);
    return Array.from({ length: 18 }, () => {
      const height = 17 + rand() * 4;
      const material = new THREE.ShaderMaterial({
        vertexShader: shaftVertex,
        fragmentShader: shaftFragment,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: { uTime: shared.uTime, uOpacity: { value: 0 }, uSeed: { value: rand() * 20 }, uFlash: { value: 0 } },
      });
      const x = v.x - 10 + rand() * 38;
      const z = v.z - 18 + rand() * 24;
      const ground = world.heightAt(x, z);
      return { material, position: new THREE.Vector3(x, ground + height / 2, z), width: 4 + rand() * 7, height };
    });
  }, [v, world]);

  const rain = useMemo(() => {
    const rand = random(51);
    const base = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.getAttribute('position'));
    geometry.instanceCount = streaks;
    const min = new THREE.Vector3(v.x + 4, 0, v.z - 44);
    const size = new THREE.Vector3(48, 46, 46);
    const offsets = new Float32Array(streaks * 3);
    const seeds = new Float32Array(streaks * 2);
    for (let i = 0; i < streaks; i++) {
      offsets.set([min.x + rand() * size.x, min.y + rand() * size.y, min.z + rand() * size.z], i * 3);
      seeds.set([rand(), rand()], i * 2);
    }
    geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 2));
    const material = new THREE.ShaderMaterial({
      vertexShader: streakVertex,
      fragmentShader: streakFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: shared.uTime, uBoxMin: { value: min }, uBoxSize: { value: size }, uCam: { value: new THREE.Vector3() },
        uOpacity: { value: 0 }, uFlash: { value: 0 },
      },
    });
    return { geometry, material };
  }, [v, streaks]);

  useEffect(() => () => {
    clouds.forEach((c) => c.material.dispose());
    shafts.forEach((s) => s.material.dispose());
    rain.geometry.dispose();
    rain.material.dispose();
  }, [clouds, shafts, rain]);

  const cloudGroup = useRef<THREE.Group>(null);
  const shaftGroup = useRef<THREE.Group>(null);
  const flashColor = useMemo(() => new THREE.Color('#e8f4ff'), []);

  useFrame((state) => {
    const amount = director.rain;
    if (group.current) group.current.visible = amount > 0.001;
    if (amount <= 0.001) return;
    const flash = lightning(state.clock.elapsedTime) * amount;
    cloudGroup.current?.children.forEach((child, i) => {
      child.quaternion.copy(camera.quaternion);
      const u = clouds[i].material.uniforms;
      u.uOpacity.value = amount;
      (u.uLit.value as THREE.Color).copy(clouds[i].base).lerp(flashColor, flash * (0.4 + 0.6 * ((i * 7) % 3) / 2));
    });
    shaftGroup.current?.children.forEach((child, i) => {
      // Shafts turn around the vertical axis to face the camera.
      child.rotation.y = Math.atan2(camera.position.x - child.position.x, camera.position.z - child.position.z);
      shafts[i].material.uniforms.uOpacity.value = amount;
      shafts[i].material.uniforms.uFlash.value = flash;
    });
    rain.material.uniforms.uOpacity.value = amount * 0.5;
    rain.material.uniforms.uFlash.value = flash;
    (rain.material.uniforms.uCam.value as THREE.Vector3).copy(camera.position);
  });

  return (
    <group ref={group}>
      <group ref={shaftGroup}>
        {shafts.map((shaft, i) => (
          <mesh key={i} position={shaft.position} material={shaft.material} renderOrder={5}>
            <planeGeometry args={[shaft.width, shaft.height]} />
          </mesh>
        ))}
      </group>
      <mesh geometry={rain.geometry} material={rain.material} frustumCulled={false} renderOrder={6} />
      <group ref={cloudGroup}>
        {clouds.map((cloud, i) => (
          <mesh key={i} position={cloud.position} scale={cloud.scale} material={cloud.material} renderOrder={7}>
            <planeGeometry args={[1, 0.55]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
