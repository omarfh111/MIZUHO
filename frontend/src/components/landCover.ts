import type { LandCoverGrid } from '../types.ts';

export const landCover = new Map<number, { label: string; color: string }>([
  [10, { label: 'Tree cover', color: '#2b7153' }],
  [20, { label: 'Shrubland', color: '#b59254' }],
  [30, { label: 'Grassland', color: '#83a45e' }],
  [40, { label: 'Cropland', color: '#cbd789' }],
  [50, { label: 'Built-up', color: '#a198a4' }],
  [60, { label: 'Bare or sparse vegetation', color: '#d6b78a' }],
  [70, { label: 'Snow and ice', color: '#e1edee' }],
  [80, { label: 'Permanent water', color: '#468ca8' }],
  [90, { label: 'Herbaceous wetland', color: '#72a79d' }],
  [95, { label: 'Mangroves', color: '#3e9b79' }],
  [100, { label: 'Moss and lichen', color: '#b4b883' }],
]);

export function paintLandCover(canvas: HTMLCanvasElement, grid: LandCoverGrid) {
  canvas.width = grid.cols;
  canvas.height = grid.rows;
  const context = canvas.getContext('2d');
  if (!context) return false;
  grid.classes.forEach((code, index) => {
    context.fillStyle = (code != null ? landCover.get(code)?.color : undefined) ?? '#18221e';
    context.fillRect(index % grid.cols, Math.floor(index / grid.cols), 1, 1);
  });
  return true;
}
