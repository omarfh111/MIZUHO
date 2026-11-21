import { ArrowDownToLine, Compass, Minus, Plus, RotateCcw, RotateCw, ScanLine } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { reliefGeometry, verticalExaggeration, type ReliefGrid } from './cityReliefGeometry.ts';
import { disposeScene } from './terrain.ts';
import './city-relief.css';

interface Props {
  name: string;
  relief: ReliefGrid;
}

type Terrain = NonNullable<ReturnType<typeof reliefGeometry>>;
type ReliefControls = {
  turn: (direction: number) => void;
  zoom: (direction: number) => void;
  home: (topDown?: boolean) => void;
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
  const paletteColors = palette.map(hex => new THREE.Color(hex));
  const color = new THREE.Color();
  const reliefRange = Math.max(terrain.high - terrain.low, 1);
  for (let i = 0; i < grid.elevations.length; i++) {
    const amount = ((grid.elevations[i] ?? terrain.low) - terrain.low) / reliefRange;
    elevationColor(color, paletteColors, amount).toArray(colors, i * 3);
  }
  surface.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  surface.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  surface.setIndex(terrain.indices);
  surface.computeVertexNormals();
  scene.add(new THREE.Mesh(surface, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.89, metalness: 0.06,
  })));

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
  return scene;
}

function ElevationRaster({ relief, terrain, name }: { relief: ReliefGrid; terrain: Terrain; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
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
  }, [relief, terrain]);
  return <div className="city-relief-raster">
    <canvas ref={canvas} width={relief.cols} height={relief.rows} role="img" aria-label={`North-up elevation grid for ${name}`}
      style={{ aspectRatio: terrain.widthMetres / terrain.depthMetres }} />
    <span>North-up elevation grid</span>
  </div>;
}

export default function CityRelief({ name, relief }: Props) {
  const terrain = useMemo(() => reliefGeometry(relief), [relief]);
  const mount = useRef<HTMLDivElement>(null);
  const pointer = useRef<HTMLSpanElement>(null);
  const controls = useRef<ReliefControls | null>(null);
  const [failedGrid, setFailedGrid] = useState<ReliefGrid | null>(null);
  const fallback = failedGrid === relief || !terrain?.indices.length;

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

    const scene = terrainScene(relief, terrain);
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
      home,
    };
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
      disposeScene(scene);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.dispose();
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [fallback, relief, terrain]);

  if (!terrain) return <p role="status">Elevation samples are unavailable for {name}.</p>;
  return <figure className="city-relief" aria-label={`Elevation around ${name}`} data-relief-mode={fallback ? 'raster' : '3d'}>
    <div className="city-relief-stage">
      {fallback ? <ElevationRaster name={name} relief={relief} terrain={terrain} /> : <>
        <div className="city-relief-mount" ref={mount} />
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
        <span className="city-relief-scale" aria-hidden="true" style={{ background: `linear-gradient(90deg, ${palette.join(', ')})` }} />
        <span data-testid="relief-high">{number.format(terrain.high)} m</span>
      </div>
      <span>{number.format(terrain.widthMetres / 1000)} × {number.format(terrain.depthMetres / 1000)} km
        {' · '}{number.format(terrain.sampleCount)} elevation samples{!fallback && ` · ${verticalExaggeration}× vertical scale`}
        {terrain.sampleCount < relief.elevations.length && ' · Missing samples omitted'}</span>
    </figcaption>
  </figure>;
}
