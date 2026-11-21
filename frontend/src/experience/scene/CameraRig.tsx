import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Director } from '../core/director.ts';
import { formatLatLon, toLonLat } from '../core/geo.ts';
import { makeKeys, sample, type Shot } from './choreography.ts';
import { shared } from './uniforms.ts';
import type { World } from './world.ts';

export interface RigHandle {
  coordinates?: HTMLElement | null;
}

export function CameraRig({ world, director, hud }: { world: World; director: Director; hud: RigHandle }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const keys = useMemo(() => makeKeys(world), [world]);
  const shot = useMemo<Shot>(() => ({ pos: new THREE.Vector3(), at: new THREE.Vector3(), fov: 40, roll: 0, shift: 0 }), []);
  const scratch = useMemo(() => ({
    right: new THREE.Vector3(), up: new THREE.Vector3(), pointer: new THREE.Vector2(), target: new THREE.Vector2(), frame: 0,
  }), []);
  const lastLabel = useRef('');

  useFrame((state, delta) => {
    const s = director.time;
    sample(keys, s, shot);
    const { pos, at } = shot;

    // Exit: dolly towards the subject while the reveal mask opens.
    pos.lerp(at, director.exit * 0.3);

    // Pointer parallax and a slow breathing sway, both scaled with altitude.
    const { pointer, target, right, up } = scratch;
    target.set(director.pointer.x, director.pointer.y);
    pointer.lerp(target, 1 - Math.exp(-delta * 2.2));
    const altitude = Math.max(0.6, pos.y - at.y);
    const t = state.clock.elapsedTime;
    right.subVectors(at, pos).cross(THREE.Object3D.DEFAULT_UP).normalize();
    const sway = altitude * 0.01;
    pos.addScaledVector(right, pointer.x * altitude * 0.05 + Math.sin(t * 0.37) * sway);
    pos.y += pointer.y * altitude * 0.03 + Math.sin(t * 0.53) * sway * 0.6;
    camera.position.copy(pos);
    camera.up.copy(THREE.Object3D.DEFAULT_UP);
    camera.lookAt(at);
    camera.rotateZ(shot.roll + pointer.x * -0.015);
    up.copy(camera.up);

    // Lens and framing. Portrait screens widen the lens and drop the side offset.
    const aspect = size.width / Math.max(1, size.height);
    let fov = shot.fov - director.exit * 4;
    const portrait = aspect < 1.25;
    if (portrait) {
      fov = THREE.MathUtils.radToDeg(2 * Math.atan((Math.tan(THREE.MathUtils.degToRad(fov) / 2) * 1.25) / aspect));
      fov = Math.min(fov, 76);
    }
    const shift = portrait ? 0 : shot.shift;
    if (Math.abs(camera.fov - fov) > 0.005) camera.fov = fov;
    if (shift !== 0) camera.setViewOffset(size.width, size.height, -shift * size.width, 0, size.width, size.height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();

    // Fog: thin from orbit, thick at ground level so the horizon melts into the sky.
    const low = THREE.MathUtils.smoothstep(altitude, 4, 60);
    shared.uFogDensity.value = THREE.MathUtils.lerp(0.034, 0.0022, low);
    shared.uTime.value = t;

    if (hud.coordinates && scratch.frame++ % 6 === 0) {
      const label = formatLatLon(toLonLat(at.x, at.z));
      if (label !== lastLabel.current) {
        hud.coordinates.textContent = label;
        lastLabel.current = label;
      }
    }
  });

  return null;
}
