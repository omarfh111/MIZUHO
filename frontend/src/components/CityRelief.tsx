import { ArrowDownToLine, Compass, Minus, Plus, RotateCcw, RotateCw, ScanLine } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { LandCoverGrid } from '../types.ts';
import { reliefGeometry, verticalExaggeration, type ReliefGrid } from './cityReliefGeometry.ts';
import { paintLandCover } from './landCover.ts';
import { sampleSurface, type SurfacePoint } from './surfaceSample.ts';
import { disposeScene } from './terrain.ts';
import './city-relief.css';

interface Props {
  name: string;
  relief: ReliefGrid;
  landCover?: LandCoverGrid;
  showLandCover?: boolean;
  markers?: ReliefMarker[];
  onInspect?: (point: SurfacePoint) => void;
}

export interface ReliefMarker extends SurfacePoint {
  id: string;
  label: string;
  deliveryFraction?: number;
}
const noMarkers: ReliefMarker[] = [];
type Terrain = NonNullable<ReturnType<typeof reliefGeometry>>;
type ReliefControls = {
  turn: (direction: number) => void;
  zoom: (direction: number) => void;
  home: (topDown?: boolean) => void;
  cover: (visible: boolean) => void;
  refresh: () => void;
};
const palette = ['#376d60', '#688150', '#ad995c', '#dcbe85'];
const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

function elevationColor(color: THREE.Color, colors: THREE.Color[], amount: number) {
  const position = THREE.MathUtils.clamp(amount, 0, 1) * (colors.length - 1);
  const index = Math.min(Math.floor(position), colors.length - 2);
  return color.lerpColors(colors[index], colors[index + 1], position - index);
}

function terrainScene(grid: ReliefGrid, terrain: Terrain) {
  const scene = new THREE.Scene();
  const surface = new THREE.BufferGeometry();
  const positions = terrain.positions;
  const colors = new Float32Array(positions.length);
  const uv = new Float32Array(grid.elevations.length * 2);
  const paletteColors = palette.map(hex => new THREE.Color(hex));
  const color = new THREE.Color();
  const reliefRange = Math.max(terrain.high - terrain.low, 1);
  for (let i = 0; i < grid.elevations.length; i++) {
    const amount = ((grid.elevations[i] ?? terrain.low) - terrain.low) / reliefRange;
    elevationColor(color, paletteColors, amount).toArray(colors, i * 3);
    uv[i * 2] = (i % grid.cols) / (grid.cols - 1);
    uv[i * 2 + 1] = Math.floor(i / grid.cols) / (grid.rows - 1);
  }
  surface.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  surface.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  surface.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  surface.setIndex(terrain.indices);
  surface.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.89, metalness: 0.06,
  });
  const mesh = new THREE.Mesh(surface, material);
  scene.add(mesh);

  const walls = [];
  for (let i = 0; i < terrain.rim.length; i += 2) {
    const a = terrain.rim[i] * 3;
    const b = terrain.rim[i + 1] * 3;
    const bottomA = [positions[a], -3, positions[a + 2]];
    const bottomB = [positions[b], -3, positions[b + 2]];
    const topA = positions.subarray(a, a + 3);
    const topB = positions.subarray(b, b + 3);
    walls.push(...bottomA, ...bottomB, ...topA, ...bottomB, ...topB, ...topA);
  }
  const edges = new THREE.BufferGeometry();
  edges.setAttribute('position', new THREE.Float32BufferAttribute(walls, 3));
  scene.add(new THREE.Mesh(edges, new THREE.MeshBasicMaterial({ color: '#30453a', side: THREE.DoubleSide })));

  const contours = [];
  const step = Math.max(1, 10 ** Math.floor(Math.log10(reliefRange / 8)));
  const firstContour = Math.floor(terrain.low / step) * step + step;
  const sampledStep = step * Math.ceil(reliefRange / (step * 14));
  const corners = [0, 0, 0];
  for (let i = 0; i < terrain.indices.length; i += 3) {
    for (let j = 0; j < 3; j++) corners[j] = terrain.indices[i + j];
    for (let contour = firstContour; contour < terrain.high; contour += sampledStep) {
      const segment = [];
      for (let j = 0; j < 3; j++) {
        const a = corners[j];
        const b = corners[(j + 1) % 3];
        const heightA = grid.elevations[a]!;
        const heightB = grid.elevations[b]!;
        if ((heightA < contour) === (heightB < contour)) continue;
        const t = (contour - heightA) / (heightB - heightA);
        for (let c = 0; c < 3; c++) segment.push(THREE.MathUtils.lerp(positions[a * 3 + c], positions[b * 3 + c], t));
      }
      if (segment.length === 6) {
        segment[1] += 0.045;
        segment[4] += 0.045;
        contours.push(...segment);
      }
    }
  }
  const lines = new THREE.BufferGeometry();
  lines.setAttribute('position', new THREE.Float32BufferAttribute(contours, 3));
  scene.add(new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: '#ecf6bb', transparent: true, opacity: .28 })));
  scene.add(new THREE.HemisphereLight('#e6f4dd', '#5c6852', 2));
  const light = new THREE.DirectionalLight('#ffedd2', 1.7);
  light.position.set(-50, 100, -90);
  scene.add(light);
  return { scene, mesh, material };
}

function ElevationRaster({ relief, terrain, name, cover, markers, onInspect }: {
  relief: ReliefGrid; terrain: Terrain; name: string; cover?: LandCoverGrid;
  markers: ReliefMarker[]; onInspect?: (point: SurfacePoint) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    if (cover && canvas.current) {
      paintLandCover(canvas.current, cover);
      return;
    }
    const paletteColors = palette.map(hex => new THREE.Color(hex));
    const color = new THREE.Color();
    const span = Math.max(terrain.high - terrain.low, 1);
    ctx.clearRect(0, 0, relief.cols, relief.rows);
    for (let row = 0; row < relief.rows; row++) {
      for (let col = 0; col < relief.cols; col++) {
        const sample = relief.elevations[row * relief.cols + col];
        if (sample === null || !Number.isFinite(sample)) continue;
        ctx.fillStyle = elevationColor(color, paletteColors, (sample - terrain.low) / span).getStyle();
        ctx.fillRect(col, relief.rows - 1 - row, 1, 1);
      }
    }
  }, [cover, relief, terrain]);
  const raster = cover ? 'land-cover map' : 'elevation grid';
  return <div className="city-relief-raster">
    <div className="city-raster-frame" style={{ aspectRatio: terrain.widthMetres / terrain.depthMetres }}>
      <canvas ref={canvas} width={cover?.cols ?? relief.cols} height={cover?.rows ?? relief.rows} role="img"
        onClick={event => {
          const box = event.currentTarget.getBoundingClientRect();
          onInspect?.({ u: (event.clientX - box.left) / box.width, v: 1 - (event.clientY - box.top) / box.height });
        }} aria-label={`North-up ${raster} for ${name}`} />
      {markers.map(marker => <span key={marker.id} className="city-relief-pin" data-marker={marker.id}
        style={{ left: `${marker.u * 100}%`, top: `${(1 - marker.v) * 100}%` }}>{marker.label}
        {marker.deliveryFraction !== undefined && <i aria-hidden="true" style={{ width: `${100 * marker.deliveryFraction}%` }} />}</span>)}
    </div>
    <span>North-up {raster}</span>
  </div>;
}

export default function CityRelief({ name, relief, landCover, showLandCover = false, markers = noMarkers, onInspect }: Props) {
  const terrain = useMemo(() => reliefGeometry(relief), [relief]);
  const mount = useRef<HTMLDivElement>(null);
  const pointer = useRef<HTMLSpanElement>(null);
  const controls = useRef<ReliefControls | null>(null);
  const [failedGrid, setFailedGrid] = useState<ReliefGrid | null>(null);
  const fallback = failedGrid === relief || !terrain?.indices.length;
  const coverMode = useRef(showLandCover);
  coverMode.current = showLandCover;
  const markerState = useRef(markers);
  markerState.current = markers;
  const inspect = useRef(onInspect);
  inspect.current = onInspect;
  const pinElements = useRef(new Map<string, HTMLSpanElement>());

  useEffect(() => {
    const container = mount.current;
    if (!container || !terrain || fallback) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    } catch {
      setFailedGrid(relief);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x13221e, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    container.append(renderer.domElement);

    const { scene, mesh, material } = terrainScene(relief, terrain);
    const coverCanvas = landCover && document.createElement('canvas');
    const texture = landCover && coverCanvas && paintLandCover(coverCanvas, landCover)
      ? new THREE.CanvasTexture(coverCanvas) : null;
    if (texture) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
    }
    const size = Math.hypot(70, terrain.height * .5 + 3);
    const centre = new THREE.Vector3(0, terrain.height * .5, 0);
    const camera = new THREE.OrthographicCamera(-size, size, size, -size, .1, size * 7);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enablePan = false;
    orbit.enableZoom = false;
    orbit.rotateSpeed = .55;
    orbit.minPolarAngle = .001;
    orbit.maxPolarAngle = Math.PI * 0.46;
    orbit.target.copy(centre);
    renderer.domElement.style.touchAction = 'pan-y';

    const northPoint = centre.clone().add(new THREE.Vector3(0, 0, -10));
    const projectedNorth = new THREE.Vector3();
    const projectedCentre = new THREE.Vector3();
    const offset = new THREE.Vector3();
    const spherical = new THREE.Spherical();
    const projectedPin = new THREE.Vector3();
    const scale = 100 / Math.max(terrain.widthMetres, terrain.depthMetres);
    const deliveryColumns = new Map<string, THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>>();
    let width = 1;
    let height = 1;
    let scheduled = 0;
    const draw = () => {
      scheduled = 0;
      camera.updateMatrixWorld();
      projectedNorth.copy(northPoint).project(camera);
      projectedCentre.copy(centre).project(camera);
      const direction = Math.atan2((projectedNorth.x - projectedCentre.x) * width,
        (projectedNorth.y - projectedCentre.y) * height);
      if (pointer.current) pointer.current.style.transform = `rotate(${direction}rad)`;
      deliveryColumns.forEach(column => { column.visible = false; });
      if (landCover) for (const marker of markerState.current) {
        const element = pinElements.current.get(marker.id);
        if (!element) continue;
        const { elevation } = sampleSurface(relief, landCover, marker);
        element.hidden = elevation == null;
        if (elevation == null) continue;
        projectedPin.set((marker.u - .5) * terrain.widthMetres * scale, (elevation - terrain.low) * scale * verticalExaggeration,
          (.5 - marker.v) * terrain.depthMetres * scale);
        if (marker.deliveryFraction) {
          let column = deliveryColumns.get(marker.id);
          if (!column) {
            column = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 1, 16),
              new THREE.MeshStandardMaterial({ color: '#42d9ba', emissive: '#15675a', emissiveIntensity: .3 }));
            deliveryColumns.set(marker.id, column);
            scene.add(column);
          }
          const height = 12 * THREE.MathUtils.clamp(marker.deliveryFraction, 0, 1);
          column.position.copy(projectedPin);
          column.position.y += height / 2;
          column.scale.y = height;
          column.visible = true;
          projectedPin.y += height;
        }
        projectedPin.project(camera);
        element.style.left = `${(projectedPin.x + 1) * 50}%`;
        element.style.top = `${(1 - projectedPin.y) * 50}%`;
      }
      renderer.render(scene, camera);
    };
    const schedule = () => { if (!scheduled) scheduled = window.requestAnimationFrame(draw); };
    const home = (topDown = false) => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      offset.setFromSphericalCoords(size * 2.6, topDown ? .001 : .89, topDown ? 0 : .55);
      camera.position.copy(centre).add(offset);
      orbit.update();
      schedule();
    };
    controls.current = {
      turn(direction) {
        spherical.setFromVector3(offset.copy(camera.position).sub(centre));
        spherical.theta += direction * Math.PI / 6;
        camera.position.copy(centre).add(offset.setFromSpherical(spherical));
        orbit.update();
      },
      zoom(direction) {
        camera.zoom = THREE.MathUtils.clamp(camera.zoom * (direction > 0 ? 1.2 : 1 / 1.2), .68, 2.5);
        camera.updateProjectionMatrix();
        schedule();
      },
      home, refresh: schedule,
      cover(visible) {
        const map = visible ? texture : null;
        if (material.map === map) return;
        material.map = map;
        material.vertexColors = !map;
        material.needsUpdate = true;
        schedule();
      },
    };
    controls.current.cover(coverMode.current);
    home();
    orbit.addEventListener('change', schedule);
    const resize = new ResizeObserver(() => {
      width = container.clientWidth;
      height = container.clientHeight;
      if (!width || !height) return;
      const aspect = width / height;
      const span = size * 1.08 / Math.min(1, aspect);
      camera.left = -span * aspect;
      camera.right = span * aspect;
      camera.top = span;
      camera.bottom = -span;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      schedule();
    });
    resize.observe(container);
    const ray = new THREE.Raycaster();
    let press: { x: number; y: number; id: number } | undefined;
    const down = (event: PointerEvent) => {
      press = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : undefined;
    };
    const up = (event: PointerEvent) => {
      const start = press;
      press = undefined;
      if (!inspect.current || !start || start.id !== event.pointerId || Math.hypot(start.x - event.clientX, start.y - event.clientY) > 5) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1,
        1 - (event.clientY - bounds.top) / bounds.height * 2), camera);
      const hit = ray.intersectObject(mesh, false)[0]?.uv;
      if (hit) inspect.current({ u: hit.x, v: hit.y });
    };
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointerup', up);
    const lost = (event: Event) => {
      event.preventDefault();
      setFailedGrid(relief);
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    return () => {
      controls.current = null;
      window.cancelAnimationFrame(scheduled);
      resize.disconnect();
      orbit.dispose();
      renderer.domElement.removeEventListener('pointerdown', down);
      renderer.domElement.removeEventListener('pointerup', up);
      material.map = null;
      texture?.dispose();
      disposeScene(scene);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.dispose();
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [fallback, landCover, relief, terrain]);

  useEffect(() => { controls.current?.cover(showLandCover); }, [showLandCover]);
  useEffect(() => { controls.current?.refresh(); }, [markers]);

  if (!terrain) return <p role="status">Elevation samples are unavailable for {name}.</p>;
  const activeCover = showLandCover ? landCover : undefined;
  return <figure className="city-relief" aria-label={`Elevation around ${name}`} data-relief-mode={fallback ? 'raster' : '3d'}
    data-surface={activeCover ? 'land-cover' : 'elevation'}>
    <div className="city-relief-stage">
      {fallback ? <ElevationRaster name={name} relief={relief} terrain={terrain} cover={activeCover} markers={markers} onInspect={onInspect} /> : <>
        <div className="city-relief-mount" ref={mount} />
        {markers.map(marker => <span className="city-relief-pin" key={marker.id} data-marker={marker.id}
          ref={node => { if (node) pinElements.current.set(marker.id, node); else pinElements.current.delete(marker.id); }}>
          {marker.label}</span>)}
        <div className="city-relief-compass" aria-label="North"><span ref={pointer}><Compass size={20} aria-hidden="true" /></span><b>N</b></div>
        <div className="city-relief-controls" role="group" aria-label="Relief controls">
          <button type="button" title="Rotate left" aria-label="Rotate left" onClick={() => controls.current?.turn(-1)}><RotateCcw size={16} /></button>
          <button type="button" title="Rotate right" aria-label="Rotate right" onClick={() => controls.current?.turn(1)}><RotateCw size={16} /></button>
          <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => controls.current?.zoom(1)}><Plus size={17} /></button>
          <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => controls.current?.zoom(-1)}><Minus size={17} /></button>
          <button type="button" title="North-up view" aria-label="North-up view" onClick={() => controls.current?.home(true)}><ArrowDownToLine size={15} /></button>
          <button type="button" title="Reset relief view" aria-label="Reset relief view" onClick={() => controls.current?.home()}><ScanLine size={16} /></button>
        </div>
      </>}
    </div>
    <figcaption className="city-relief-caption">
      <div className="city-relief-legend" aria-label={`Elevation: ${number.format(terrain.low)} to ${number.format(terrain.high)} meters`}>
        <span data-testid="relief-low">{number.format(terrain.low)} m</span>
        {!activeCover && <span className="city-relief-scale" aria-hidden="true" style={{ background: `linear-gradient(90deg, ${palette.join(', ')})` }} />}
        {activeCover && <span>Elevation range</span>}
        <span data-testid="relief-high">{number.format(terrain.high)} m</span>
      </div>
      <span>{number.format(terrain.widthMetres / 1000)} × {number.format(terrain.depthMetres / 1000)} km
        {' · '}{number.format(terrain.sampleCount)} elevation samples{!fallback && ` · ${verticalExaggeration}× vertical scale`}
        {terrain.sampleCount < relief.elevations.length && ' · Missing samples omitted'}</span>
    </figcaption>
  </figure>;
}
