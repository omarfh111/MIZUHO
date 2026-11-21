import { Droplets, MapPin, TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Position } from 'geojson';
import type { Layer, LayerId, LayerProperties, Site } from '../types.ts';
import { buildTerrain, disposeScene, elevation, trace, worldPoint } from './terrain.ts';
import type { MapControls } from './mapControls.ts';

const layerColors: Record<LayerId, string> = { plots: '#c9ef86', solar: '#f7ce76', anomalies: '#f29285', wind: '#a9b9f4' };
const tankPosition = new THREE.Vector3(-34, elevation(-34, 7) + 2.5, 7);

interface Marker {
  id: string;
  position: THREE.Vector3;
  label: string;
  layer?: LayerId;
  properties?: LayerProperties;
}

function describeMarkers(center: Position, layers: Partial<Record<LayerId, Layer>>, siteLabel: string): Marker[] {
  const markers: Marker[] = [{ id: 'site', position: tankPosition, label: siteLabel }];
  for (const [id, layer] of Object.entries(layers) as [LayerId, Layer][]) {
    layer.features.forEach(({ geometry, properties }, index) => {
      if (geometry.type !== 'Point' && geometry.type !== 'Polygon') return;
      const points = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates[0].slice(0, -1);
      if (!points.length) return;
      const position = points.reduce((total, point) => [
        total[0] + point[0] / points.length, total[1] + point[1] / points.length,
      ], [0, 0]);
      markers.push({
        id: `${id}-${index}`, position: worldPoint(position, center, .66), layer: id, properties,
        label: properties.label ?? properties.plot_id ?? id,
      });
    });
  }
  return markers;
}

function revealLayers(
  scene: THREE.Scene, center: Position, layers: Partial<Record<LayerId, Layer>>,
  active: LayerProperties | null, markers: Marker[],
) {
  for (const [id, layer] of Object.entries(layers) as [LayerId, Layer][]) {
    layer.features.forEach(({ geometry, properties }) => {
      if (geometry.type === 'Polygon') {
        const edge = geometry.coordinates[0];
        const shapePoints = edge.slice(0, -1).map((point) => {
          const { x, z } = worldPoint(point, center);
          return new THREE.Vector2(x, z);
        });
        const selected = properties === active;
        const triangles = THREE.ShapeUtils.triangulateShape(shapePoints, []);
        const positions = triangles.flatMap((face) => face.flatMap((index) => {
          const { x, y, z } = worldPoint(edge[index], center, .11);
          return [x, y, z];
        }));
        const fill = new THREE.BufferGeometry();
        fill.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        scene.add(new THREE.Mesh(fill, new THREE.MeshBasicMaterial({
          color: layerColors[id], opacity: selected ? .39 : .15, transparent: true,
          depthWrite: false, side: THREE.DoubleSide,
        })));
        const outline = edge.slice(1).flatMap((point, index) => Array.from({ length: 12 }, (_, step) => {
          const start = edge[index];
          const ratio = step / 12;
          return worldPoint([
            THREE.MathUtils.lerp(start[0], point[0], ratio), THREE.MathUtils.lerp(start[1], point[1], ratio),
          ], center, .26);
        }));
        outline.push(outline[0].clone());
        scene.add(trace(outline, selected ? '#e7ffb5' : '#b2d474', selected ? .17 : .075).mesh);
      }
      if (id === 'solar' && geometry.type === 'Point') {
        const panel = new THREE.Group();
        panel.position.copy(worldPoint(geometry.coordinates, center, .25));
        for (let row = 0; row < 2; row++) {
          for (let column = 0; column < 4; column++) {
            const slab = new THREE.Mesh(new THREE.BoxGeometry(1.48, .09, .68),
              new THREE.MeshStandardMaterial({ color: '#314f6b', emissive: '#325273', emissiveIntensity: .27, metalness: .32 }));
            slab.position.set(column * 1.65 - 2.48, .34, row * .92 - .45);
            slab.rotation.x = -.28;
            panel.add(slab);
          }
        }
        scene.add(panel);
      }
    });
  }
  const plots = markers.filter(({ layer }) => layer === 'plots');
  const links = plots.map(({ position }) => {
    const points = [
      [-34, 7], [-30, 11], [-28, 14], [position.x - 3, 14], [position.x, position.z],
    ].map(([x, z]) => new THREE.Vector3(x, elevation(x, z) + .26, z));
    const link = trace(points, '#69d8be', .105);
    const pulse = new THREE.Mesh(new THREE.SphereGeometry(.30, 8, 8), new THREE.MeshBasicMaterial({ color: '#b9fff1' }));
    scene.add(link.mesh, pulse);
    return { ...link, pulse };
  });
  return links;
}

interface Props {
  site: Site;
  layers: Partial<Record<LayerId, Layer>>;
  active: LayerProperties | null;
  select: (properties: LayerProperties | null) => void;
  controls: React.RefObject<MapControls | null>;
  onUnavailable: () => void;
}

export default function TerrainMap({ site, layers, active, select, controls, onUnavailable }: Props) {
  const view = useRef<HTMLDivElement>(null);
  const markerRefs = useRef(new Map<string, HTMLButtonElement>());
  const setup = useRef<{ scene: THREE.Scene; render: () => void } | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const updateLinks = useRef<(now: number) => void>(() => {});
  const center = site.geometry.coordinates;
  const markers = describeMarkers(center, layers, site.properties.label);

  useEffect(() => {
    const mount = view.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      onUnavailable();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor('#13221e', 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.32;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    mount.append(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(39, 1, 1, 440);
    const home = new THREE.Vector3(47, 89, 110);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.enableZoom = false;
    orbit.minPolarAngle = .26;
    orbit.maxPolarAngle = 1.18;
    orbit.minDistance = 65;
    orbit.maxDistance = 260;
    orbit.rotateSpeed = .65;
    const reset = () => {
      camera.position.copy(home).multiplyScalar(camera.aspect < 1.2 ? 1.23 : 1);
      orbit.target.set(0, -8, 0);
      orbit.update();
    };
    reset();
    controls.current = {
      zoom: (direction) => {
        const offset = camera.position.clone().sub(orbit.target);
        offset.setLength(THREE.MathUtils.clamp(offset.length() * (direction > 0 ? .84 : 1.18), 66, 250));
        camera.position.copy(orbit.target).add(offset);
        orbit.update();
      },
      reset,
    };
    scene.add(new THREE.HemisphereLight('#d3ecd7', '#35483e', 2.05));
    const sun = new THREE.DirectionalLight('#ffeac4', 2.15);
    sun.position.set(-66, 110, -29);
    scene.add(sun, buildTerrain());
    const lost = (event: Event) => {
      event.preventDefault();
      onUnavailable();
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);

    let frame = 0;
    let viewWidth = 1;
    let viewHeight = 1;
    let visible = true;
    let firstSize = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const projected = new THREE.Vector3();
    const north = new THREE.Vector3();
    const origin = new THREE.Vector3();
    const northOffset = new THREE.Vector3(0, 0, -10);
    const render = () => {
      orbit.update();
      camera.updateMatrixWorld();
      origin.copy(orbit.target).project(camera);
      north.copy(orbit.target).add(northOffset).project(camera);
      const direction = Math.atan2((north.x - origin.x) * viewWidth, (north.y - origin.y) * viewHeight);
      mount.parentElement?.style.setProperty('--map-north', `${direction}rad`);
      for (const marker of markersRef.current) {
        const element = markerRefs.current.get(marker.id);
        if (!element) continue;
        projected.copy(marker.position).project(camera);
        element.style.left = `${(projected.x * .5 + .5) * viewWidth}px`;
        element.style.top = `${(-projected.y * .5 + .5) * viewHeight}px`;
        element.style.visibility = Math.abs(projected.x) <= .98 && Math.abs(projected.y) <= .98 && projected.z < 1 ? '' : 'hidden';
      }
      renderer.render(scene, camera);
    };
    setup.current = { scene, render };
    const observer = new ResizeObserver(() => {
      viewWidth = mount.clientWidth;
      viewHeight = mount.clientHeight;
      if (!viewWidth || !viewHeight) return;
      camera.aspect = viewWidth / viewHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(viewWidth, viewHeight);
      if (firstSize) { reset(); firstSize = false; }
      render();
    });
    observer.observe(mount);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    intersection.observe(mount);
    const animate = (time: number) => {
      if (visible) {
        if (!reduced.matches) updateLinks.current(time);
        render();
      }
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      orbit.dispose();
      disposeScene(scene);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.dispose();
      renderer.domElement.remove();
      mount.parentElement?.style.removeProperty('--map-north');
      controls.current = null;
      setup.current = null;
    };
  }, [controls, onUnavailable]);

  useEffect(() => {
    if (!setup.current) return;
    const layerScene = new THREE.Scene();
    const currentMarkers = describeMarkers(center, layers, site.properties.label);
    markersRef.current = currentMarkers;
    const links = revealLayers(layerScene, center, layers, active, currentMarkers);
    links.forEach(({ curve, pulse }) => { pulse.position.copy(curve.getPoint(.35)); });
    const scene = setup.current.scene;
    scene.add(layerScene);
    updateLinks.current = (time) => links.forEach(({ curve, pulse }, index) => {
      pulse.position.copy(curve.getPoint((time / 4400 + index * .24) % 1));
    });
    setup.current.render();
    return () => {
      updateLinks.current = () => {};
      scene.remove(layerScene);
      disposeScene(layerScene);
    };
  }, [active, center, layers, site.properties.label]);

  return <>
    <div className="terrain-surface" ref={view} />
    <div className="terrain-markers">
      {markers.map((marker) => {
        const selected = marker.properties ? marker.properties === active : active === null;
        const Icon = marker.layer === 'solar' ? Zap : marker.layer === 'anomalies' ? TriangleAlert : marker.layer ? MapPin : Droplets;
        return <button key={marker.id} type="button" className={`terrain-marker marker-${marker.layer ?? 'site'}`}
          aria-label={marker.layer ? marker.label : `Site ${marker.label}`} aria-pressed={selected}
          title={marker.label} onClick={() => select(marker.properties ?? null)}
          ref={(element) => { if (element) markerRefs.current.set(marker.id, element); else markerRefs.current.delete(marker.id); }}>
          {marker.layer === 'plots' && marker.properties?.plot_id ? marker.properties.plot_id : <Icon size={14} />}
          {!marker.layer && <span>Reservoir</span>}
        </button>;
      })}
    </div>
  </>;
}
