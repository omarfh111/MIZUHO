import * as THREE from 'three';

export interface StationVariant {
  tank_scale?: number;
  backup_active?: boolean;
}

export function tankDimensionScale(relativeVolume = 1) {
  // Preserve volume proportions over typical scenarios. Symbols are bounded for extreme inputs.
  return Number.isFinite(relativeVolume) && relativeVolume > 0 ? Math.min(2, Math.cbrt(relativeVolume)) : 1;
}

export function backupGenerator() {
  const unit = new THREE.Group();
  const housing = new THREE.MeshStandardMaterial({ color: '#d4a553', roughness: .6 });
  const metal = new THREE.MeshStandardMaterial({ color: '#495b57', metalness: .25 });
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(2.15, 1.28, 1.08), housing);
  cabinet.position.y = .71;
  unit.add(cabinet);
  for (let i = 0; i < 5; i++) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(.12, .48, .06), metal);
    vent.position.set(-.63 + i * .22, .76, .55);
    unit.add(vent);
  }
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(.13, .13, .75, 8), metal);
  exhaust.position.set(.63, 1.54, 0);
  unit.add(exhaust);
  unit.name = 'active-islandable-backup';
  unit.visible = false;
  return unit;
}
