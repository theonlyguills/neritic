/**
 * Close-up scenes: where a vessel is drawn (open ocean, a real stretch of coast, a real
 * harbour) and which hull represents it. Coastal sceneries are built from real elevation
 * and OpenStreetMap data (scripts/fetch-scenery.mjs); weather and lighting are illustrative.
 */
import type { Coast } from './fleet'
import { sceneryFor, type LiveVessel, type SceneryKind } from './simulation'

export interface SkyConfig {
  url: string
  /** Sun disk position in the equirectangular image (see renderers/sun.ts). */
  sun: { u: number; elevation: number }
  /** World azimuth for the sun, degrees, atan2(z, x). */
  sunAzimuth: number
  /** Background brightness; the HDR is also the lighting environment. */
  intensity: number
  /** Directional sunlight intensity (soft under overcast). */
  sunlight: number
  /** Show the lens flare (only where the sky has a sun disk). */
  flare: boolean
}

export interface SceneryConfig {
  id: string
  kind: SceneryKind
  coast: Coast | 'any'
  /** Shown in the panel, e.g. "The Narrows, St. John’s NL". */
  place: string
  /** Real-geography terrain and features (public/scenery/<id>/), if any. */
  terrainUrl?: string
  sky: SkyConfig
  fog: { colour: string; density: number }
  /** Swell amplitude scale: 1 open ocean, ~0.1 inside a harbour. */
  seaState: number
  /** Sun bearing relative to the camera's look towards land, degrees (raking light). */
  sunOffsetDeg?: number
  /** Town nearby: the entrance is a long, slow flyover of it instead of the quick spiral. */
  tour?: boolean
  /** Lower-third caption shown during the entrance. */
  caption?: { title: string; line: string }
  /** Share of parked cars drawn (1 = all; busy towns are thinned for frame rate). */
  carShare?: number
  /** Other vessels working on the horizon (offshore). */
  distantShips: boolean
  gulls: number
}

export interface BoatModel {
  id: string
  url: string
  farUrl?: string
  lengthM: number
  beamM: number
  /** Main working deck above the waterline (deck sound sources). */
  deckHeight: number
  /** Keel-bottom to waterline (model min y sits this far below the water plane). */
  waterlineOffset: number
  /** Outfit with the trawler's crew, nets and deck gear. */
  trawlerDeck: boolean
  /**
   * Navigation lights in the hull's frame (metres, bow −Z, waterline y = 0), measured on
   * the model: sidelights on the wheelhouse, masthead, stern, optional deck work light.
   */
  /** Engine room in the hull's frame, and its size class (sound pitch and loudness). */
  engine: { position: [number, number, number]; size: 'large' | 'small' }
  navLights: {
    side: [number, number, number]
    masthead: [number, number, number]
    stern: [number, number, number]
    work?: [number, number, number]
  }
}

const TABLE_MOUNTAIN: SkyConfig = {
  // Poly Haven "Table Mountain 2"; sun measured in the image (see manifest).
  url: '/assets/table-mountain-sky.hdr',
  sun: { u: 0.6383, elevation: 7.26 },
  sunAzimuth: -109,
  intensity: 0.62,
  sunlight: 2.2,
  flare: true,
}
// Poly Haven pure skies (CC0); sun measured in each image (see manifest).
const LATE_AFTERNOON: SkyConfig = {
  url: '/assets/late-afternoon-sky.hdr',
  sun: { u: 0.6004, elevation: 19.08 },
  sunAzimuth: -109,
  intensity: 0.55,
  sunlight: 2.4,
  flare: true,
}
const BRIGHT_MORNING: SkyConfig = {
  url: '/assets/bright-morning-sky.hdr',
  sun: { u: 0.5973, elevation: 28.3 },
  sunAzimuth: -109,
  intensity: 0.5,
  sunlight: 2.6,
  flare: true,
}
const OVERCAST: SkyConfig = {
  url: '/assets/overcast-maritime-sky.hdr',
  sun: { u: 0.6084, elevation: 22.67 },
  sunAzimuth: -109,
  intensity: 0.75,
  sunlight: 0.9,
  flare: false,
}

/** Dusk for every scenery: Poly Haven "Industrial Sunset 02 (Pure Sky)", CC0; sun on the horizon. */
export const DUSK_SKY: SkyConfig = {
  url: '/assets/dusk-sky.hdr',
  sun: { u: 0.5999, elevation: 2.24 },
  sunAzimuth: -109,
  intensity: 0.22,
  sunlight: 1.0,
  flare: true,
}

export const SCENERIES: Record<string, SceneryConfig> = {
  'grand-banks': {
    id: 'grand-banks',
    kind: 'offshore',
    coast: 'any',
    place: 'Offshore · open ocean',
    caption: {
      title: 'Grand Banks, NAFO 3L',
      line: 'Offshore groundfish grounds, about 300 km from St. John’s',
    },
    sky: TABLE_MOUNTAIN,
    fog: { colour: '#b3b8b9', density: 0.0003 },
    seaState: 1,
    distantShips: true,
    gulls: 18,
  },
  narrows: {
    id: 'narrows',
    kind: 'inshore',
    coast: 'atlantic',
    place: 'The Narrows, St. John’s NL',
    terrainUrl: '/scenery/narrows/',
    caption: {
      title: 'The Narrows · St. John’s, Newfoundland and Labrador',
      line: 'Signal Hill and Cabot Tower above the harbour mouth',
    },
    tour: true,
    sky: LATE_AFTERNOON,
    sunOffsetDeg: 55,
    fog: { colour: '#b9bfc0', density: 0.00016 },
    seaState: 0.55,
    distantShips: false,
    gulls: 22,
  },
  lunenburg: {
    id: 'lunenburg',
    kind: 'harbour',
    coast: 'atlantic',
    place: 'Lunenburg harbour NS',
    terrainUrl: '/scenery/lunenburg/',
    caption: {
      title: 'Lunenburg, Nova Scotia',
      line: 'Old Town Lunenburg · UNESCO World Heritage Site · home port of the Bluenose',
    },
    tour: true,
    sky: BRIGHT_MORNING,
    sunOffsetDeg: -60,
    fog: { colour: '#bcc2c2', density: 0.00012 },
    carShare: 0.5,
    seaState: 0.12,
    distantShips: false,
    gulls: 26,
  },
  johnstone: {
    id: 'johnstone',
    kind: 'inshore',
    coast: 'pacific',
    place: 'Johnstone Strait BC',
    terrainUrl: '/scenery/johnstone/',
    caption: {
      title: 'Johnstone Strait, British Columbia',
      line: 'Salmon seine grounds off Telegraph Cove',
    },
    sky: LATE_AFTERNOON,
    sunOffsetDeg: 50,
    fog: { colour: '#aeb8bc', density: 0.00014 },
    seaState: 0.4,
    distantShips: false,
    gulls: 14,
  },
  'prince-rupert': {
    id: 'prince-rupert',
    kind: 'harbour',
    coast: 'pacific',
    place: 'Prince Rupert harbour BC',
    terrainUrl: '/scenery/prince-rupert/',
    caption: {
      title: 'Prince Rupert, British Columbia',
      line: 'North Coast fishing harbour at the mouth of the Skeena',
    },
    tour: true,
    sky: OVERCAST,
    sunOffsetDeg: 30,
    fog: { colour: '#aeb7ba', density: 0.00013 },
    seaState: 0.12,
    distantShips: false,
    gulls: 24,
  },
}

export const BOATS: Record<string, BoatModel> = {
  trawler: {
    id: 'trawler',
    url: '/assets/stern-trawler-40m.glb',
    farUrl: '/assets/stern-trawler-40m-far.glb',
    lengthM: 47.5,
    beamM: 11.4,
    deckHeight: 5.5,
    waterlineOffset: 6.8,
    trawlerDeck: true,
    engine: { position: [0, 3.5, 6], size: 'large' },
    navLights: {
      side: [3.0, 11.3, -15.2],
      masthead: [0, 19.0, -8.6],
      stern: [0, 5.1, 23.7],
      work: [0.4, 5.9, 17.2],
    },
  },
  // "Alma Paulin Fishing Boat", Air Digital (CC BY 4.0): a scanned New Brunswick Cape Islander.
  'inshore-atlantic': {
    id: 'inshore-atlantic',
    url: '/assets/cape-islander.glb',
    farUrl: '/assets/cape-islander-far.glb',
    lengthM: 12.95,
    beamM: 4.03,
    deckHeight: 0.8,
    waterlineOffset: 0.55,
    trawlerDeck: false,
    // Under the wheelhouse floor, as on most Cape Islanders.
    engine: { position: [0, 0.4, -1.8], size: 'small' },
    navLights: { side: [1.45, 2.35, -3.4], masthead: [0, 2.72, -2.2], stern: [0, 1.0, 6.35] },
  },
  // "Fishing Vessel IV", agt14032013 (CC BY 4.0): a West Coast seiner.
  'inshore-pacific': {
    id: 'inshore-pacific',
    url: '/assets/pacific-seiner.glb',
    farUrl: '/assets/pacific-seiner-far.glb',
    lengthM: 17,
    beamM: 4.78,
    deckHeight: 1.1,
    waterlineOffset: 1.01,
    trawlerDeck: false,
    engine: { position: [0, 0.7, -2.6], size: 'small' },
    navLights: { side: [1.75, 2.3, -4.4], masthead: [0, 8.6, 0], stern: [0, 1.1, 8.45] },
  },
}

/** The crew figures used on the trawler's deck. */
export const CREW_URL = '/assets/deck-crew.glb'

/** Hull for a vessel: the trawler for big offshore boats, else the coast's inshore boat. */
export function boatFor(v: Pick<LiveVessel, 'lengthM' | 'coast'>): BoatModel {
  if (v.lengthM >= 26) return BOATS.trawler!
  return BOATS[`inshore-${v.coast}`] ?? BOATS.inshore ?? BOATS.trawler!
}

/** Scenery for a vessel, from its status and zone (see `sceneryFor`). */
export function sceneryForVessel(
  v: Pick<LiveVessel, 'status' | 'zone' | 'progress' | 'coast'>,
): SceneryConfig {
  const kind = sceneryFor(v)
  const match = Object.values(SCENERIES).find(
    (s) => s.kind === kind && (s.coast === v.coast || s.coast === 'any'),
  )
  return match ?? SCENERIES['grand-banks']!
}
