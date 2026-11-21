import * as THREE from 'three';
import type { LandCoverGrid } from '../types.ts';
import type { RegionalFrame, RegionalLayout } from './regionalLayout.ts';
import type { SurfacePoint } from './surfaceSample.ts';
import { backupGenerator, tankDimensionScale } from './stationVariant.ts';

type Position = (point: SurfacePoint) => THREE.Vector3;

export function installRegionalEquipment(scene: THREE.Scene, layout: RegionalLayout, cover: LandCoverGrid, position: Position) {
  const steel = new THREE.MeshStandardMaterial({ color: '#b8c7b3', roughness: .6 });
  const concrete = new THREE.MeshStandardMaterial({ color: '#bcb09a' });
  const water = new THREE.MeshStandardMaterial({ color: '#29bbad', metalness: .25, roughness: .33 });
  const structure = new THREE.Group();
  structure.name = 'Hypothetical irrigation station';
  structure.position.copy(position(layout.station));
  scene.add(structure);
  const solid = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material,
    x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const base = solid(structure, new THREE.BoxGeometry(6.3, .5, 4.7), concrete, 0, .35, 0);
  const floor = base.position.y + .25;
  const reservoir = new THREE.Group();
  reservoir.position.set(-.8, floor, -.3);
  structure.add(reservoir);
  const rim = solid(reservoir, new THREE.CylinderGeometry(1.85, 1.85, 2.9, 24, 1, true), steel, 0, 1.45, 0);
  rim.material = new THREE.MeshStandardMaterial({ color: '#a7e0d1', transparent: true, opacity: .36, depthWrite: false });
  for (const height of [.13, 1.45, 2.83]) {
    const collar = solid(reservoir, new THREE.TorusGeometry(1.85, .075, 6, 24), steel, 0, height, 0);
    collar.rotation.x = Math.PI / 2;
  }
  const tank = solid(reservoir, new THREE.CylinderGeometry(1.74, 1.74, 1, 24), water, 0, 0, 0);
  for (const x of [-1.65, -1.1]) {
    solid(reservoir, new THREE.CylinderGeometry(.045, .045, 2.8, 6), steel, x, 1.48, 1.28);
  }
  for (let step = .4; step < 2.85; step += .43) {
    solid(reservoir, new THREE.BoxGeometry(.58, .055, .06), steel, -1.375, step, 1.28);
  }
  const backup = backupGenerator();
  backup.position.set(3.2, .35, 2.35);
  structure.add(backup);
  const pumpLamp = new THREE.MeshStandardMaterial({ color: '#6b8275' });
  const pumpEnamel = new THREE.MeshStandardMaterial({ color: '#267673', metalness: .3, roughness: .36 });
  solid(structure, new THREE.BoxGeometry(1.94, .17, 1), steel, 1.86, floor + .1, 1.17);
  const shaft = solid(structure, new THREE.CylinderGeometry(.36, .36, .9, 12), pumpEnamel, 2.12, floor + .53, 1.17);
  shaft.rotation.z = Math.PI / 2;
  for (let i = 0; i < 5; i++) {
    const bevel = solid(structure, new THREE.TorusGeometry(.36, .035, 5, 12), steel, 1.79 + i * .15, floor + .53, 1.17);
    bevel.rotation.y = Math.PI / 2;
  }
  const impeller = solid(structure, new THREE.CylinderGeometry(.52, .52, .32, 16), pumpEnamel, 1.43, floor + .56, 1.17);
  impeller.rotation.z = Math.PI / 2;
  solid(structure, new THREE.CylinderGeometry(.14, .14, .5, 9), steel, 1.43, floor + 1.12, 1.17);
  solid(structure, new THREE.SphereGeometry(.17, 8, 6), pumpLamp, 2.56, floor + .96, 1.17);
  const solar = new THREE.MeshStandardMaterial({ color: '#304e6c', metalness: .3, roughness: .3 });
  const cellLines = new THREE.MeshStandardMaterial({ color: '#8aadc4', metalness: .25 });
  const array = new THREE.Group();
  structure.add(array);
  for (let i = 0; i < 4; i++) {
    const panel = solid(array, new THREE.BoxGeometry(.74, .13, 1.65), solar, .55 + i * .82, floor + .61, -1.55);
    panel.rotation.x = -.26;
    for (let j = 1; j < 4; j++) solid(panel, new THREE.BoxGeometry(.72, .008, .022), cellLines, 0, .07, j * .4 - .8);
    solid(panel, new THREE.BoxGeometry(.018, .008, 1.6), cellLines, 0, .07, 0);
  }
  const grid = solid(structure, new THREE.BoxGeometry(.42, 3.35, .42), steel, 2.8, floor + 1.7, .25);
  const gridLamp = new THREE.MeshStandardMaterial({ color: '#a5a396' });
  solid(structure, new THREE.BoxGeometry(1, .36, .45), gridLamp, grid.position.x, floor + 3.3, .25);

  // One instanced draw per symbol family. The sample points represent land-cover classes.
  // No individual building, species or surveyed tree position is inferred from a pixel.
  for (const [classCode, geometry, color, height] of [
    [10, new THREE.IcosahedronGeometry(.73, 0), '#486e40', .75],
    [50, new THREE.BoxGeometry(1.2, .85, 1.02), '#b9aa90', .47],
  ] as const) {
    const points = [];
    for (let row = 2; row < cover.rows; row += 5) for (let col = 2; col < cover.cols; col += 5) {
      if (cover.classes[row * cover.cols + col] === classCode) points.push({
        u: (col + .5) / cover.cols, v: 1 - (row + .5) / cover.rows,
      });
    }
    if (!points.length) { geometry.dispose(); continue; }
    const group = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ color, flatShading: true }), points.length);
    const matrix = new THREE.Matrix4();
    points.forEach((p, i) => {
      const ground = position(p);
      group.setMatrixAt(i, matrix.makeTranslation(ground.x, ground.y + height, ground.z));
    });
    scene.add(group);
  }
  const pipes = layout.sectors.flatMap(sector => {
    if (sector.path.length < 2) return [];
    const curve = new THREE.CurvePath<THREE.Vector3>();
    const vertices = sector.path.map(p => position(p).add(new THREE.Vector3(0, .35, 0)));
    for (let i = 1; i < vertices.length; i++) curve.add(new THREE.LineCurve3(vertices[i - 1], vertices[i]));
    const pipe = new THREE.Mesh(new THREE.TubeGeometry(curve, vertices.length * 2, .24, 6, false),
      new THREE.MeshStandardMaterial({ color: '#538e81', roughness: .5 }));
    const outlet = vertices[vertices.length - 1];
    const valve = solid(scene, new THREE.CylinderGeometry(.62, .62, .65, 12), concrete, outlet.x, outlet.y, outlet.z);
    solid(scene, new THREE.TorusGeometry(.59, .14, 5, 12), steel, valve.position.x, outlet.y + .65, outlet.z);
    const pulse = new THREE.Mesh(new THREE.SphereGeometry(.51, 9, 6), new THREE.MeshBasicMaterial({ color: '#c5fff4' }));
    scene.add(pipe, pulse);
    return [{ id: sector.id, pipe, pulse, curve }];
  });
  return (frame: RegionalFrame | undefined, time: number) => {
    array.visible = frame?.pv_capacity_kwp !== 0;
    reservoir.scale.setScalar(tankDimensionScale(frame?.tank_scale));
    backup.visible = Boolean(frame?.backup_active);
    tank.visible = Boolean(frame && frame.tank_capacity_m3 > 0 && frame.tank_stock_m3 > 0);
    if (frame && tank.visible) {
      const height = 2.78 * THREE.MathUtils.clamp(frame.tank_stock_m3 / frame.tank_capacity_m3, 0, 1);
      tank.scale.y = height;
      tank.position.y = height / 2;
    }
    pumpLamp.color.setHex(frame && frame.pump_m3 > 0 ? 0xc1ec7f : 0x718372);
    gridLamp.color.setHex(frame ? (frame.grid_available ? 0xffdb75 : 0xcd7965) : 0xa5a396);
    let flowing = false;
    for (const { id, pulse, pipe, curve } of pipes) {
      pulse.visible = !!frame?.deliveries.some(d => d.plot_id === id && d.delivered_m3 > 0);
      pipe.material.color.setHex(pulse.visible ? 0x4edbbf : 0x548779);
      if (pulse.visible) { curve.getPointAt(time % 3600 / 3600, pulse.position); flowing = true; }
    }
    return flowing;
  };
}
