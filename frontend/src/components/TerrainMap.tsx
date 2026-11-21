import { Droplets, MapPin, TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Geometry, Position } from 'geojson';
import type { Layer, LayerId, LayerProperties, Site } from '../types.ts';
import { buildTerrain, disposeScene, elevation, trace, worldPoint } from './terrain.ts';
import type { MapControls } from './mapControls.ts';
import type { TwinFrame } from '../twin.ts';
import { reliefGeometry, verticalExaggeration, type ReliefGrid } from './cityReliefGeometry.ts';
import { surfaceElevation } from './surfaceSample.ts';
import { terrainScene } from './CityRelief.tsx';
import { tankDimensionScale, type StationVariant } from './stationVariant.ts';

const layerColors: Record<LayerId, string> = { plots: '#c9ef86', solar: '#f7ce76', anomalies: '#f29285', wind: '#a9b9f4', wapor: '#3bc9c1' };
const tankPosition = new THREE.Vector3(-34, elevation(-34, 7) + 2.5, 7);
type Project = (position: Position, lift: number) => THREE.Vector3;

function rings(geometry?: Geometry): Position[][] {
  if (geometry?.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.map(([outer]) => outer);
  return [];
}

function projection(site: Site, layers: Partial<Record<LayerId, Layer>>, demo: boolean,
  grid?: ReliefGrid, terrain?: ReturnType<typeof reliefGeometry>): Project {
  const center = site.geometry.coordinates;
  if (demo) return (point, lift) => worldPoint(point, center, lift);
  if (grid && terrain) {
    const [west, south, east, north] = grid.bounds;
    const scale = 100 / Math.max(terrain.widthMetres, terrain.depthMetres);
    return ([lon, lat], lift) => {
      const u = (lon - west) / (east - west), v = (lat - south) / (north - south);
      const y = ((surfaceElevation(grid, { u, v }) ?? terrain.low) - terrain.low) * scale * verticalExaggeration;
      return new THREE.Vector3((u - .5) * terrain.widthMetres * scale, y + lift, (.5 - v) * terrain.depthMetres * scale);
    };
  }
  let extent = 1;
  const geometries = [...Object.values(layers).flatMap((layer) => layer.features.map(({ geometry }) => geometry)), site.outline];
  for (const geometry of geometries) {
    const points = geometry?.type === 'Point' ? [geometry.coordinates] : rings(geometry).flat();
    for (const point of points) {
      const { x, z } = worldPoint(point, center);
      extent = Math.max(extent, Math.abs(x), Math.abs(z));
    }
  }
  return (point, lift) => {
    const { x, z } = worldPoint(point, center);
    return new THREE.Vector3(x * 36 / extent, lift, z * 36 / extent);
  };
}

interface Marker {
  id: string;
  position: THREE.Vector3;
  label: string;
  layer?: LayerId;
  properties?: LayerProperties;
}

function describeMarkers(project: Project, layers: Partial<Record<LayerId, Layer>>, siteLabel: string, demo: boolean, operational: boolean): Marker[] {
  const markers: Marker[] = [{ id: 'site', position: demo ? tankPosition : new THREE.Vector3(0, 1.4, 0), label: siteLabel }];
  if (operational && demo) {
    markers.push({ id: 'pump', position: new THREE.Vector3(-36, elevation(-36, 0) + 3, -1), label: 'Pump', properties: { equipment: 'pump' } },
      { id: 'grid', position: new THREE.Vector3(-47, elevation(-47, -13) + 2, -13), label: 'Grid', properties: { equipment: 'grid' } });
  }
  for (const [id, layer] of Object.entries(layers) as [LayerId, Layer][]) {
    if (id === 'wapor') continue;
    layer.features.forEach(({ geometry, properties }, index) => {
      const points = geometry.type === 'Point' ? [geometry.coordinates] : rings(geometry)[0]?.slice(0, -1) ?? [];
      if (!points.length) return;
      const position = points.reduce((total, point) => [
        total[0] + point[0] / points.length, total[1] + point[1] / points.length,
      ], [0, 0]);
      markers.push({
        id: `${id}-${index}`, position: project(position, .66), layer: id, properties,
        label: properties.label ?? properties.plot_id ?? id,
      });
    });
  }
  return markers;
}

function revealLayers(
  scene: THREE.Scene, project: Project, layers: Partial<Record<LayerId, Layer>>,
  active: LayerProperties | null, markers: Marker[], demo: boolean,
) {
  for (const [id, layer] of Object.entries(layers) as [LayerId, Layer][]) {
    if (id === 'wapor') {
      const positions: number[] = [];
      const colors: number[] = [];
      const low = new THREE.Color('#835d34'), high = new THREE.Color('#3bc9c1');
      const color = new THREE.Color();
      for (const { geometry, properties } of layer.features) {
        const ring = rings(geometry)[0];
        if (ring?.length !== 5 || properties.eta_mm_day == null) continue;
        color.lerpColors(low, high, THREE.MathUtils.clamp(properties.eta_mm_day / 6, 0, 1));
        const corners = ring.slice(0, 4).map((point) => project(point, .04));
        for (const i of [0, 1, 2, 0, 2, 3]) {
          positions.push(corners[i].x, corners[i].y, corners[i].z);
          colors.push(color.r, color.g, color.b);
        }
      }
      const grid = new THREE.BufferGeometry();
      grid.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      grid.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      scene.add(new THREE.Mesh(grid, new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: .75, depthWrite: false, side: THREE.DoubleSide,
      })));
      continue;
    }
    layer.features.forEach(({ geometry, properties }) => {
      for (const edge of rings(geometry)) {
        if (edge.length < 4) continue;
        const shapePoints = edge.slice(0, -1).map((point) => {
          const { x, z } = project(point, .11);
          return new THREE.Vector2(x, z);
        });
        const selected = properties === active;
        const triangles = THREE.ShapeUtils.triangulateShape(shapePoints, []);
        const positions = triangles.flatMap((face) => face.flatMap((index) => {
          const { x, y, z } = project(edge[index], .11);
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
          return project([
            THREE.MathUtils.lerp(start[0], point[0], ratio), THREE.MathUtils.lerp(start[1], point[1], ratio),
          ], .26);
        }));
        outline.push(outline[0].clone());
        scene.add(trace(outline, selected ? '#e7ffb5' : layerColors[id], selected ? .17 : .075).mesh);
      }
      if (demo && id === 'solar' && geometry.type === 'Point') {
        const panel = new THREE.Group();
        panel.position.copy(project(geometry.coordinates, .25));
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
  if (!demo) return [];
  const plots = markers.filter(({ layer }) => layer === 'plots');
  const links = plots.map(({ position, properties }) => {
    const points = [
      [-34, 7], [-30, 11], [-28, 14], [position.x - 3, 14], [position.x, position.z],
    ].map(([x, z]) => new THREE.Vector3(x, elevation(x, z) + .26, z));
    const link = trace(points, '#69d8be', .105);
    const pulse = new THREE.Mesh(new THREE.SphereGeometry(.30, 8, 8), new THREE.MeshBasicMaterial({ color: '#b9fff1' }));
    scene.add(link.mesh, pulse);
    return { ...link, pulse, plotId: properties?.plot_id };
  });
  return links;
}

interface Props {
  surveyRelief?: ReliefGrid;
  imagery?: string;
  site: Site;
  layers: Partial<Record<LayerId, Layer>>;
  active: LayerProperties | null;
  select: (properties: LayerProperties | null) => void;
  controls: React.RefObject<MapControls | null>;
  onUnavailable: () => void;
  demo: boolean;
  snapshot?: Pick<TwinFrame, 'tank_stock_m3' | 'tank_capacity_m3' | 'pump_m3' | 'grid_available'> & StationVariant & {
    parcels: Pick<TwinFrame['parcels'][number], 'plot_id' | 'delivered_m3'>[];
  };
}

export default function TerrainMap({ site, layers, active, select, controls, onUnavailable, demo, snapshot, surveyRelief, imagery }: Props) {
  const current = useRef(snapshot);
  current.current = snapshot;
  const operational = Boolean(snapshot);
  const view = useRef<HTMLDivElement>(null);
  const markerRefs = useRef(new Map<string, HTMLButtonElement>());
  const setup = useRef<{ scene: THREE.Scene; render: () => void } | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const updateLinks = useRef<(now: number) => void>(() => {});
  const terrain = useMemo(() => surveyRelief ? reliefGeometry(surveyRelief) : undefined, [surveyRelief]);
  const project = useMemo(() => projection(site, layers, demo, surveyRelief, terrain), [site, layers, demo, surveyRelief, terrain]);
  const markers = useMemo(() => describeMarkers(project, layers, site.properties.label, demo, operational),
    [project, layers, site.properties.label, demo, operational]);

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
      orbit.target.set(0, demo ? -8 : (terrain?.height ?? 0) * .45, 0);
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
    let disposed = false;
    if (surveyRelief && terrain) {
      const bed = terrainScene(surveyRelief, terrain);
      scene.add(bed.scene);
      if (imagery) {
        const texture = new THREE.TextureLoader().load(imagery, (ready) => {
          if (disposed) { ready.dispose(); return; }
          bed.material.map = ready;
          bed.material.vertexColors = false;
          bed.material.needsUpdate = true;
        }, undefined, () => texture.dispose());
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      }
    } else scene.add(sun, demo ? buildTerrain(operational) : new THREE.GridHelper(96, 24, '#54705e', '#344d41'));
    const water = scene.getObjectByName('reservoir-fill');
    const vessel = scene.getObjectByName('reservoir-vessel');
    const backup = scene.getObjectByName('active-islandable-backup');
    const lamp = scene.getObjectByName('pump-indicator') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | undefined;
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
        updateLinks.current(reduced.matches ? 0 : time);
        const snapshot = current.current;
        if (water && lamp && snapshot) {
          vessel?.scale.setScalar(tankDimensionScale(snapshot.tank_scale));
          if (backup) backup.visible = Boolean(snapshot.backup_active);
          const level = snapshot.tank_capacity_m3 ? snapshot.tank_stock_m3 / snapshot.tank_capacity_m3 : 0;
          water.scale.y = reduced.matches ? level : THREE.MathUtils.lerp(water.scale.y, level, .15);
          lamp.material.color.setHex(snapshot.pump_m3 > 0 ? 0x96ffc6 : 0x546760);
        }
        render();
      }
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      orbit.dispose();
      disposeScene(scene);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      mount.parentElement?.style.removeProperty('--map-north');
      controls.current = null;
      setup.current = null;
    };
  }, [controls, onUnavailable, demo, operational, surveyRelief, terrain, imagery]);

  useEffect(() => {
    if (!setup.current) return;
    const layerScene = new THREE.Scene();
    markersRef.current = markers;
    const links = revealLayers(layerScene, project, layers, active, markers, demo);
    if (!demo) {
      for (const edge of rings(site.outline)) {
        layerScene.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(edge.map((point) => project(point, .32))),
          new THREE.LineBasicMaterial({ color: '#83b8a0' }),
        ));
      }
    }
    links.forEach(({ curve, pulse }) => { pulse.position.copy(curve.getPoint(.35)); });
    const scene = setup.current.scene;
    scene.add(layerScene);
    updateLinks.current = (time) => links.forEach(({ curve, pulse, mesh, plotId }, index) => {
      const snapshot = current.current;
      const parcel = snapshot?.parcels.find((entry) => entry.plot_id === plotId);
      pulse.visible = !snapshot || Boolean(parcel?.delivered_m3);
      mesh.material.color.setHex(pulse.visible ? 0x69d8be : 0x638276);
      if (pulse.visible) curve.getPoint((time / 4400 + index * .24) % 1, pulse.position);
    });
    setup.current.render();
    return () => {
      updateLinks.current = () => {};
      scene.remove(layerScene);
      disposeScene(layerScene);
    };
  }, [active, site, layers, demo, project, markers]);

  return <>
    <div className="terrain-surface" ref={view} data-tank-volume-ratio={snapshot?.tank_scale} data-backup-active={snapshot?.backup_active} />
    <div className="terrain-markers">
      {markers.map((marker) => {
        const selected = marker.properties ? marker.properties === active : active === null;
        const Icon = marker.layer === 'solar' || marker.id === 'grid' ? Zap : marker.layer === 'anomalies' ? TriangleAlert : marker.layer ? MapPin : Droplets;
        return <button key={marker.id} type="button" className={`terrain-marker marker-${marker.layer ?? 'site'}`}
          aria-label={marker.properties ? marker.label : `Site ${marker.label}`} aria-pressed={selected}
          title={marker.label} onClick={() => select(marker.properties ?? null)}
          ref={(element) => { if (element) markerRefs.current.set(marker.id, element); else markerRefs.current.delete(marker.id); }}>
          {marker.layer === 'plots' && marker.properties?.plot_id ? marker.properties.plot_id : <Icon size={14} />}
          {!marker.layer && <span>{marker.id === 'grid' ? (snapshot?.grid_available ? 'Grid on' : 'Grid off') :
            marker.id === 'pump' ? (snapshot?.pump_m3 ? 'Pumping' : 'Stopped') : demo ? 'Reservoir' : 'Site'}</span>}
        </button>;
      })}
    </div>
  </>;
}
