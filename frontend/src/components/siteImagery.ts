import manifest from '../assets/site-imagery/manifest.json';
import type { ReliefGrid } from './cityReliefGeometry.ts';

const assets = import.meta.glob<string>('../assets/site-imagery/*.webp', { eager: true, import: 'default' });
const records: Record<string, { asset: string; url: string; bounds: number[] }> = manifest;

export function siteImagery(id: string, relief: ReliefGrid) {
  const record = records[id];
  if (!record || record.bounds.some((v, i) => v !== relief.bounds[i])) return undefined;
  return { src: assets[`../assets/site-imagery/${record.asset}`], original: record.url };
}
