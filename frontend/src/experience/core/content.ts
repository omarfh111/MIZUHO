/**
 * Editorial copy. Every statement is qualitative or widely documented; the
 * experience never displays measurements, live values or invented telemetry.
 */

export const BRAND = 'MIZUHO';
export const TAGLINE = 'Renewable-powered water intelligence for Tunisian agriculture';

export interface Chapter {
  id: string;
  short: string;
  eyebrow: string;
  title: string[];
  body: string;
  /** Which side of the frame the copy occupies; the camera keeps that side quiet. */
  side: 'left' | 'right' | 'center';
  /** Accent of the chapter: water by default, sun for the renewable energy chapters. */
  tone?: 'water' | 'sun';
}

export const CHAPTERS: Chapter[] = [
  {
    id: 'drop',
    short: 'Cloud',
    eyebrow: 'Tunisia · A water-stressed country',
    title: ['Every drop', 'counts.'],
    body: 'Follow a single raindrop from cloud to crop, and see why every litre needs a plan.',
    side: 'left',
  },
  {
    id: 'rain',
    short: 'Rain',
    eyebrow: 'Rainfall',
    title: ['Rain falls', 'in the north.'],
    body: 'The north receives most of the country’s rain. The centre and the south stay arid.',
    side: 'right',
  },
  {
    id: 'river',
    short: 'River',
    eyebrow: 'Medjerda basin',
    title: ['One river', 'carries it.'],
    body: 'The Medjerda, Tunisia’s main river, gathers the north-west’s water on its way to the sea.',
    side: 'left',
  },
  {
    id: 'dams',
    short: 'Dams',
    eyebrow: 'Reservoirs',
    title: ['Dams hold', 'the year.'],
    body: 'Winter rain is stored behind dams such as Sidi Salem and Bou Heurtma for the dry months.',
    side: 'right',
  },
  {
    id: 'canals',
    short: 'Canals',
    eyebrow: 'Jendouba · Irrigated perimeter',
    title: ['Canals bring', 'it home.'],
    body: 'Gravity and pumps move stored water through canals to every plot.',
    side: 'left',
  },
  {
    id: 'energy',
    short: 'Energy',
    eyebrow: 'Renewable energy · Jendouba',
    tone: 'sun',
    title: ['Sun and wind', 'power the pumps.'],
    body: 'A solar field and wind turbines can drive irrigation with clean, local energy, where the grid is far away or costly.',
    side: 'right',
  },
  {
    id: 'renewables',
    short: 'Renewables',
    eyebrow: 'Renewable Tunisia',
    tone: 'sun',
    title: ['Clean energy', 'for every drop.'],
    body: 'Wind farms at Sidi Daoud and Bizerte and the Tozeur solar plant already feed the grid. Pairing irrigation with renewables cuts cost and emissions.',
    side: 'left',
  },
  {
    id: 'mizuho',
    short: 'MIZUHO',
    eyebrow: TAGLINE,
    title: [BRAND],
    body: 'Map, simulate and anticipate irrigation, powered by the sun and the wind.',
    side: 'center',
  },
];

export const LOADING_STAGES = {
  engine: 'Loading the 3D engine',
  terrain: 'Shaping Tunisia’s relief',
  valley: 'Building the irrigated valley',
  shaders: 'Compiling shaders',
  app: 'Preparing the observatory',
  ready: 'Ready',
} as const;

export type LoadingStage = keyof typeof LOADING_STAGES;

export const HONESTY_NOTE = 'Illustrative visualization · approximate positions · no live data';
