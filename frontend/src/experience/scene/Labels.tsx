import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Director } from '../core/director.ts';
import type { World } from './world.ts';

type Channel = 'mapLabels' | 'labels';

interface Spec {
  text: string;
  className: string;
  position: THREE.Vector3;
  channel: Channel;
  stagger: number;
}

/**
 * Projects 3D anchors to screen space and positions plain DOM labels in a
 * layer outside the canvas. No React roots are created per label, which
 * keeps mounting/unmounting the scene cheap and race-free.
 */
export function Labels({ world, director, layer }: { world: World; director: Director; layer: HTMLElement | null }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  const specs = useMemo<Spec[]>(() => [
    ...world.places.map((place, i) => ({
      text: place.label,
      className: `mx-place mx-place--${place.kind}`,
      position: place.position.clone().add(new THREE.Vector3(0, 0.4, 0)),
      channel: 'mapLabels' as const,
      stagger: i * 0.06,
    })),
    ...world.valley.pois.map((poi, i) => ({
      text: poi.label,
      className: 'mx-poi',
      position: poi.position.clone().add(new THREE.Vector3(0, 1.15, 0)),
      channel: 'labels' as const,
      stagger: i * 0.08,
    })),
  ], [world]);

  const elements = useMemo(() => {
    if (!layer) return [];
    return specs.map((spec) => {
      const el = document.createElement('div');
      el.className = spec.className;
      const pin = document.createElement('span');
      pin.className = spec.channel === 'labels' ? 'mx-poi__dot' : 'mx-place__pin';
      const text = document.createElement('span');
      text.className = 'mx-place__label';
      text.textContent = spec.text;
      el.append(pin, text);
      el.style.visibility = 'hidden';
      return el;
    });
  }, [layer, specs]);

  useEffect(() => {
    if (!layer) return;
    layer.append(...elements);
    return () => elements.forEach((el) => el.remove());
  }, [layer, elements]);

  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    specs.forEach((spec, i) => {
      const el = elements[i];
      if (!el) return;
      const raw = director[spec.channel];
      const amount = THREE.MathUtils.clamp((raw - spec.stagger) / (1 - spec.stagger), 0, 1);
      v.copy(spec.position).project(camera);
      const visible = amount > 0.01 && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      el.style.visibility = visible ? 'visible' : 'hidden';
      if (!visible) return;
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      el.style.opacity = amount.toFixed(3);
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${(y + (1 - amount) * 8).toFixed(1)}px, 0)`;
    });
  });

  return null;
}
