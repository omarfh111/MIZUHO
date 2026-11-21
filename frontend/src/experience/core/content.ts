/**
 * Editorial copy. Every statement is qualitative or widely documented; the
 * experience never displays measurements, live values or invented telemetry.
 */

export const BRAND = 'MIZUHO';
export const TAGLINE = 'Water intelligence for Tunisian agriculture';

export interface Chapter {
  id: string;
  short: string;
  eyebrow: string;
  title: string[];
  body: string;
  /** Which side of the frame the copy occupies; the camera keeps that side quiet. */
  side: 'left' | 'right' | 'center';
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
    id: 'sun',
    short: 'Sun',
    eyebrow: 'Energy',
    title: ['The sun runs', 'the pumps.'],
    body: 'Solar arrays can power pumping where the grid is far away or costly.',
    side: 'right',
  },
  {
    id: 'mizuho',
    short: 'MIZUHO',
    eyebrow: TAGLINE,
    title: [BRAND],
    body: 'Map, simulate and anticipate irrigation continuity, before the canals run dry.',
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
