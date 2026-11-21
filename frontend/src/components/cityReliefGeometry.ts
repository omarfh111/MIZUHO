export interface ReliefGrid {
  rows: number;
  cols: number;
  bounds: [west: number, south: number, east: number, north: number];
  elevations: (number | null)[];
}

export const verticalExaggeration = 3;

export function reliefGeometry(grid: ReliefGrid) {
  const { rows, cols, bounds: [west, south, east, north], elevations } = grid;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2 ||
      elevations.length !== rows * cols || !grid.bounds.every(Number.isFinite) ||
      west >= east || west < -180 || east > 180 || south >= north || south < -90 || north > 90) {
    return null;
  }
  const samples = elevations.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!samples.length) return null;
  const low = samples.reduce((min, value) => Math.min(min, value), Infinity);
  const high = samples.reduce((max, value) => Math.max(max, value), -Infinity);
  const latitude = (north + south) * Math.PI / 360;
  const widthMetres = (east - west) * 111195 * Math.cos(latitude);
  const depthMetres = (north - south) * 111195;
  const scale = 100 / Math.max(widthMetres, depthMetres);
  const width = widthMetres * scale;
  const depth = depthMetres * scale;
  const positions = new Float32Array(elevations.length * 3);
  const elevationsPresent = elevations.map(value => value !== null && Number.isFinite(value));
  const indices = [];
  const rim = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      positions[i * 3 + 0] = (col / (cols - 1) - 0.5) * width;
      const sample = elevations[i];
      positions[i * 3 + 1] = elevationsPresent[i] && sample !== null ? (sample - low) * scale * verticalExaggeration : 0;
      positions[i * 3 + 2] = (0.5 - row / (rows - 1)) * depth;
      if (col < cols - 1 && row < rows - 1) {
        const eastPoint = i + 1;
        const northPoint = i + cols;
        const northEastPoint = northPoint + 1;
        if (elevationsPresent[i] && elevationsPresent[eastPoint] && elevationsPresent[northPoint]) {
          indices.push(i, eastPoint, northPoint);
        }
        if (elevationsPresent[eastPoint] && elevationsPresent[northEastPoint] && elevationsPresent[northPoint]) {
          indices.push(eastPoint, northEastPoint, northPoint);
        }
      }
      if (col < cols - 1 && (row === 0 || row === rows - 1) && elevationsPresent[i] && elevationsPresent[i + 1]) {
        rim.push(i, i + 1);
      }
      if (row < rows - 1 && (col === 0 || col === cols - 1) && elevationsPresent[i] && elevationsPresent[i + cols]) {
        rim.push(i, i + cols);
      }
    }
  }
  return {
    positions, indices, rim, low, high, widthMetres, depthMetres,
    height: (high - low) * scale * verticalExaggeration, sampleCount: samples.length,
  };
}
