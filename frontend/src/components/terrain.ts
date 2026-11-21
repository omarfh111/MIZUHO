import * as THREE from 'three';
import type { Position } from 'geojson';

const width = 116;
const depth = 82;
const floor = -6;
const fieldColors = ['#586940', '#697848', '#8b8151', '#5e7550', '#4e6d47', '#769051', '#92905a'];

function randomGenerator(seed: number) {
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function elevation(x: number, z: number) {
  const hill = (cx: number, cz: number, radius: number) => Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / radius);
  return 1 + 11 * hill(-46, -24, 330) + 9 * hill(-33, -38, 170) + 7 * hill(44, -30, 440)
    + 4 * hill(54, 33, 240) + 0.7 * Math.sin(x / 10 + z / 12) + 0.32 * Math.sin(x / 3 - z / 5);
}

export function worldPoint(position: Position, center: Position, lift = 0) {
  const x = (position[0] - center[0]) * 6800;
  const z = (center[1] - position[1]) * 8100;
  return new THREE.Vector3(x, elevation(x, z) + lift, z);
}

function riverX(z: number) {
  return 40 + 6 * Math.sin(z * 0.095) + 2.5 * Math.sin(z * 0.22);
}

function texture(trees: [number, number, number][]) {
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1130;
  const ctx = canvas.getContext('2d')!;
  const random = randomGenerator(177);
  const u = (x: number) => (x / width + 0.5) * canvas.width;
  const v = (z: number) => (z / depth + 0.5) * canvas.height;
  const path = (points: number[][]) => {
    ctx.beginPath();
    points.forEach(([x, z], index) => index ? ctx.lineTo(u(x), v(z)) : ctx.moveTo(u(x), v(z)));
  };

  ctx.fillStyle = '#3b4937';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const corners = Array.from({ length: 10 }, (_, row) => Array.from({ length: 13 }, (_, column) =>
    [-68 + column * 11 + 5 * (random() - .5) + row * .8, -49 + row * 11 + 5 * (random() - .5) - column * .45]));
  for (let row = 0; row < corners.length - 1; row++) {
    for (let column = 0; column < corners[row].length - 1; column++) {
      const points = [corners[row][column], corners[row][column + 1], corners[row + 1][column + 1], corners[row + 1][column]];
      path(points);
      ctx.closePath();
      const [x, z] = points[0];
      const rugged = elevation(x + 5, z + 5) > 5.5;
      ctx.fillStyle = rugged ? ['#455641', '#53664a', '#3b5540'][Math.floor(random() * 3)]
        : fieldColors[Math.floor(random() * fieldColors.length)];
      ctx.fill();
      if (!rugged) {
        ctx.strokeStyle = 'rgba(31, 40, 29, .50)';
        ctx.lineWidth = 5;
        ctx.stroke();
      }
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(224, 223, 159, .16)';
      ctx.lineWidth = 1.5;
      const spacing = 2.6 + random() * 6;
      for (let line = -45; line < 230; line += spacing) {
        ctx.beginPath();
        ctx.moveTo(u(x) + line, v(z) - 8);
        ctx.lineTo(u(x) + line + (column % 2 === 0 ? 18 : -40), v(z) + 192);
        if (!rugged) ctx.stroke();
      }
      ctx.restore();
    }
  }

  for (let index = 0; index < 30000; index++) {
    const x = random() * width - width / 2;
    const z = random() * depth - depth / 2;
    const tint = random();
    ctx.fillStyle = tint < .5 ? 'rgba(6, 18, 13, .085)' : 'rgba(220, 224, 166, .10)';
    const size = 1 + random() * 4;
    ctx.fillRect(u(x), v(z), size * 1.3, size);
    if ((index < 3600 && elevation(x, z) > 6.5 && random() > .55) || index < 140) {
      if (Math.abs(x - riverX(z)) > 2.7) trees.push([x, z, .46 + random() * 1.20]);
    }
  }
  for (let row = 0; row < 7; row++) {
    for (let column = 0; column < 12; column++) {
      trees.push([-30 + column * 1.65 + row * .27, -18 + row * 1.75 - column * .26, .48 + random() * .31]);
    }
  }

  const stream = Array.from({ length: 166 }, (_, index) => {
    const z = index / 165 * depth - depth / 2;
    return [riverX(z), z];
  });
  path(stream);
  ctx.strokeStyle = '#384d48';
  ctx.lineWidth = 49;
  ctx.stroke();
  ctx.strokeStyle = '#2c514f';
  ctx.lineWidth = 30;
  ctx.stroke();
  ctx.strokeStyle = '#518a82';
  ctx.lineWidth = 19;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(148, 207, 175, .33)';
  ctx.lineWidth = 3;
  ctx.stroke();

  for (const points of [
    [[-58, 13], [-43, 11], [-29, 18], [-2, 15], [20, 11], [39, 6], [58, 2]],
    [[-37, 41], [-31, 22], [-30, 4], [-34, -20], [-32, -41]],
    [[-52, -8], [-39, -2], [-18, -6], [-2, -10], [21, -13], [36, -18], [58, -23]],
  ]) {
    path(points);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(38, 44, 29, .82)';
    ctx.lineWidth = 15;
    ctx.stroke();
    ctx.strokeStyle = '#99916d';
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.strokeStyle = '#b4a77c';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

function boundaries() {
  const edges = [
    [[-58, -41], [58, -41]], [[58, -41], [58, 41]], [[58, 41], [-58, 41]], [[-58, 41], [-58, -41]],
  ];
  const group = new THREE.Group();
  for (const [[x0, z0], [x1, z1]] of edges) {
    const positions: number[] = [];
    const colors: number[] = [];
    const top = new THREE.Color('#425244');
    const bottom = new THREE.Color('#172a24');
    const rim: THREE.Vector3[] = [];
    for (let index = 0; index <= 64; index++) {
      const fraction = index / 64;
      const x = THREE.MathUtils.lerp(x0, x1, fraction);
      const z = THREE.MathUtils.lerp(z0, z1, fraction);
      const y = elevation(x, z);
      rim.push(new THREE.Vector3(x, y + .04, z));
      if (index === 0) continue;
      const a = rim[index - 1];
      positions.push(a.x, floor, a.z, x, floor, z, x, y, z, a.x, floor, a.z, x, y, z, a.x, a.y, a.z);
      for (const color of [bottom, bottom, top, bottom, top, top]) colors.push(color.r, color.g, color.b);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    for (const offset of [0, .28, .6, .85]) {
      const line = rim.map((point) => new THREE.Vector3(point.x, THREE.MathUtils.lerp(point.y, floor, offset) + .02, point.z));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(line), new THREE.LineBasicMaterial({
        color: offset === 0 ? '#a1a889' : '#657158', opacity: offset === 0 ? .55 : .30, transparent: true,
      })));
    }
  }
  return group;
}

export function buildTerrain() {
  const group = new THREE.Group();
  const trees: [number, number, number][] = [];
  const geometry = new THREE.PlaneGeometry(width, depth, 116, 82).rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) {
    positions.setY(index, elevation(positions.getX(index), positions.getZ(index)));
  }
  geometry.computeVertexNormals();
  const map = texture(trees);
  group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map, roughness: 1 })), boundaries());

  const random = randomGenerator(113);
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ roughness: .95, flatShading: true }), trees.length);
  const dummy = new THREE.Object3D();
  trees.forEach(([x, z, size], index) => {
    dummy.position.set(x, elevation(x, z) + size * .57, z);
    dummy.scale.set(size * .6, size, size * .66);
    dummy.rotation.y = random() * Math.PI;
    dummy.updateMatrix();
    crown.setMatrixAt(index, dummy.matrix);
    crown.setColorAt(index, new THREE.Color(index % 3 === 0 ? '#526b42' : index % 3 === 1 ? '#314e3a' : '#658054'));
  });
  group.add(crown);

  const tank = new THREE.Group();
  const [x, z] = [-34, 7];
  tank.position.set(x, elevation(x, z), z);
  const tankBody = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.6, 1.6, 32),
    new THREE.MeshStandardMaterial({ color: '#3c776d', roughness: .58, metalness: .28 }));
  tankBody.position.y = .8;
  const tankTop = new THREE.Mesh(new THREE.CylinderGeometry(2.46, 2.46, .15, 32),
    new THREE.MeshStandardMaterial({ color: '#8ec4b4', roughness: .63 }));
  tankTop.position.y = 1.62;
  const tankRing = new THREE.Mesh(new THREE.TorusGeometry(2.05, .065, 8, 36), new THREE.MeshBasicMaterial({ color: '#b4ddc8' }));
  tankRing.rotation.x = -Math.PI / 2;
  tankRing.position.y = 1.72;
  const station = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.55, 2.6),
    new THREE.MeshStandardMaterial({ color: '#b8ac8a' }));
  station.position.set(-1, .8, -4.3);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.7, .18, 3.1), new THREE.MeshStandardMaterial({ color: '#254c60' }));
  roof.position.set(-1, 1.64, -4.3);
  tank.add(tankBody, tankTop, tankRing, station, roof);
  group.add(tank);
  return group;
}

export function trace(points: THREE.Vector3[], color: string, radius: number) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const geometry = new THREE.TubeGeometry(curve, Math.max(16, points.length * 6), radius, 5, false);
  return { curve, mesh: new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color })) };
}

export function disposeScene(scene: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  const textures = new Set<THREE.Texture>();
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (!mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      if ('map' in material && material.map instanceof THREE.Texture) textures.add(material.map);
    }
  });
  textures.forEach((map) => map.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}
