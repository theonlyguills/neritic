import type { Coast, FleetFile, Harbour, HarbourFile } from './fleet'
import {
  DAY,
  combineTotals,
  emptyTotals,
  FleetSimulation,
  type HailTotals,
  SIM_RATE,
  type FleetStats,
  type HailEvent,
  type LiveVessel,
} from './simulation'
import { url } from './base'
export type { Coast } from './fleet'
export type ViewId = 'canada' | Coast | 'vessel'
export interface Position {
  longitude: number
  latitude: number
}
export interface DataProvider {
  snapshot(time: number): Snapshot
  subscribe(listener: (snapshot: Snapshot) => void, interval?: number): () => void
}
export interface SceneDefinition {
  id: ViewId
  renderer: 'cesium' | 'three'
  title: string
  subtitle: string
  anchor: Position
  height: number
  /** Map views: camera looks at `anchor` from `height` metres away, tilted by `pitch`°. */
  pitch?: number
  local?: {
    modelUrl: string
    /** Optional low-detail hull for vessels on the horizon. */
    farModelUrl?: string
    lengthMetres: number
    /** Main working deck height above the waterline, metres (deck sound sources). */
    deckHeight: number
    /** Waterline beam, used for hull foam and roll sampling. */
    beamMetres: number
    waterlineOffset: number
    crewUrl: string
    sky: {
      url: string
      /** Sun disk position in the equirectangular image (see renderers/sun.ts). */
      sun: { u: number; elevation: number }
      /** World azimuth for the sun, degrees, atan2(z, x): chosen so presets face it. */
      sunAzimuth: number
    }
    cameras: Record<'elevated' | 'water' | 'deck', [number, number, number]>
    targets: Record<'elevated' | 'water' | 'deck', [number, number, number]>
  }
}
export const scenes: Record<ViewId, SceneDefinition> = {
  canada: {
    id: 'canada',
    renderer: 'cesium',
    title: 'Canada’s fisheries, live.',
    subtitle: 'Licences, hails and vessels on the water, coast to coast.',
    anchor: { longitude: -95, latitude: 54 },
    height: 8600000,
    pitch: -64,
  },
  atlantic: {
    id: 'atlantic',
    renderer: 'cesium',
    title: 'Northwest Atlantic',
    subtitle: 'NAFO divisions · Regional activity',
    anchor: { longitude: -57, latitude: 48.5 },
    height: 2600000,
    pitch: -68,
  },
  pacific: {
    id: 'pacific',
    renderer: 'cesium',
    title: 'Canadian Pacific',
    subtitle: 'Fisheries management areas · Regional activity',
    anchor: { longitude: -129, latitude: 51.5 },
    height: 1500000,
    pitch: -66,
  },
  vessel: {
    id: 'vessel',
    renderer: 'three',
    title: 'Northern Light',
    subtitle: 'Grand Banks · Illustrative offshore scene',
    anchor: { longitude: -50, latitude: 46 },
    height: 60,
    local: {
      modelUrl: url('/assets/stern-trawler-40m.glb'),
      farModelUrl: url('/assets/stern-trawler-40m-far.glb'),
      crewUrl: url('/assets/deck-crew.glb'),
      sky: {
        // Poly Haven "Table Mountain 2"; sun measured in the image (see manifest).
        url: url('/assets/table-mountain-sky.hdr'),
        sun: { u: 0.6383, elevation: 7.26 },
        sunAzimuth: -109,
      },
      lengthMetres: 47.5,
      beamMetres: 11.4,
      deckHeight: 5.5,
      waterlineOffset: 6.8,
      cameras: { elevated: [58, 20, 66], water: [52, 5, 58], deck: [-12, 14, 31] },
      targets: { elevated: [0, 9, 0], water: [0, 7, 0], deck: [0, 5, 14] },
    },
  },
}
export interface Snapshot {
  time: number
  vessels: LiveVessel[]
  stats: Record<'canada' | Coast, FleetStats>
  /** Most recent hails, newest first. */
  feed: HailEvent[]
  licences: FleetFile['licences']
  harbours: Harbour[]
  /** Rolling 24 h hail totals, carried forward incrementally between ticks. */
  hailTotals: HailTotals
}
export const emptySnapshot: Snapshot = {
  time: 0,
  vessels: [],
  stats: { canada: emptyStats(), atlantic: emptyStats(), pacific: emptyStats() },
  feed: [],
  licences: {
    total: 0,
    byRegion: { NL: 0, MAR: 0, GLF: 0, QC: 0, PAC: 0, ARC: 0 },
    bySpecies: {},
  },
  harbours: [],
  hailTotals: emptyTotals(),
}
function emptyStats(): FleetStats {
  return {
    vessels: 0,
    atSea: 0,
    fishing: 0,
    inPort: 0,
    inbound: 0,
    outbound: 0,
    hailOuts: 0,
    hailIns: 0,
    landingsKg: 0,
    byRegion: {
      NL: { atSea: 0, inPort: 0, vessels: 0 },
      MAR: { atSea: 0, inPort: 0, vessels: 0 },
      GLF: { atSea: 0, inPort: 0, vessels: 0 },
      QC: { atSea: 0, inPort: 0, vessels: 0 },
      PAC: { atSea: 0, inPort: 0, vessels: 0 },
      ARC: { atSea: 0, inPort: 0, vessels: 0 },
    },
    bySpecies: [],
  }
}
/**
 * The demo walkthrough: pinned vessels (HERO_PINS) whose close-up shows a chosen scene.
 * `scene` is the scenery the vessel must open (checked in tests/world.test.ts). Ids of the
 * non-hero vessels come from scripts/generate-fleet.mjs; re-check them after regenerating.
 */
export const FEATURED: { id: string; setting: string; place: string; scene: string }[] = [
  { id: 'nl-01', setting: 'Offshore', place: 'Grand Banks, NAFO 3L', scene: 'grand-banks' },
  { id: 'nl-02', setting: 'Inshore', place: 'The Narrows, St. John’s', scene: 'narrows' },
  { id: 'ns-01', setting: 'Alongside', place: 'Lunenburg harbour', scene: 'lunenburg' },
  { id: 'nl-0039', setting: 'Alongside', place: 'Harbour Breton', scene: 'harbour-breton' },
  {
    id: 'nl-0001',
    setting: 'Alongside',
    place: 'Channel-Port aux Basques',
    scene: 'channel-port-aux-basques',
  },
  { id: 'nl-0080', setting: 'Alongside', place: 'Bay de Verde', scene: 'bay-de-verde' },
  {
    id: 'qc-0018',
    setting: 'Alongside',
    place: 'Cap-aux-Meules, Magdalen Islands',
    scene: 'cap-aux-meules',
  },
  { id: 'bc-01', setting: 'Inshore', place: 'Johnstone Strait', scene: 'johnstone' },
  { id: 'bc-02', setting: 'Arriving', place: 'Prince Rupert', scene: 'prince-rupert' },
  {
    id: 'pac-0259',
    setting: 'Alongside',
    place: 'Daajing Giids, Haida Gwaii',
    scene: 'daajing-giids',
  },
  { id: 'pac-0272', setting: 'Alongside', place: 'Comox', scene: 'comox' },
]
/** Wall-clock style time of day for the demo clock (24 h per DAY demo seconds). */
export function demoClock(time: number) {
  const hours = ((time / DAY) * 24 + 5.5) % 24
  const h = Math.floor(hours)
  const m = Math.floor((hours - h) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
/** Demo clock at page load: mid-"day", so the rolling counters start well populated. */
export const START_TIME = 7200
const FEED_LENGTH = 40
/** Build a snapshot at demo time t; `feed` carries over the previous snapshot's hails. */
export function snapshotAt(sim: FleetSimulation, time: number, previous?: Snapshot): Snapshot {
  const vessels = sim.snapshot(time)
  const since = previous?.time ?? time - DAY / 8
  const fresh = sim.hails(since, time)
  // The 24 h window slides: add what just happened, drop what fell out of the window.
  const hailTotals = previous
    ? combineTotals(
        previous.hailTotals,
        sim.hailTotals(fresh),
        sim.hailTotals(sim.hails(previous.time - DAY, time - DAY)),
      )
    : sim.hailTotals(sim.hails(time - DAY, time))
  return {
    time,
    vessels,
    stats: {
      canada: sim.stats(vessels, hailTotals),
      atlantic: sim.stats(vessels, hailTotals, 'atlantic'),
      pacific: sim.stats(vessels, hailTotals, 'pacific'),
    },
    feed: [...fresh.reverse(), ...(previous?.feed ?? [])].slice(0, FEED_LENGTH),
    licences: sim.licences,
    harbours: previous?.harbours ?? [...sim.harbours.values()],
    hailTotals,
  }
}
/** Load the synthetic registry and real harbour list, then tick the simulation. */
export async function loadDemoProvider(
  load: (url: string) => Promise<unknown> = (url) =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
      return r.json()
    }),
): Promise<DataProvider & { simulation: FleetSimulation }> {
  const [fleet, harbours] = await Promise.all([
    load(url('/data/fleet.json')) as Promise<FleetFile>,
    load(url('/data/harbours.json')) as Promise<HarbourFile>,
  ])
  const simulation = new FleetSimulation(fleet, harbours)
  return {
    simulation,
    snapshot: (time) => snapshotAt(simulation, time),
    subscribe(fn, interval = 1000) {
      const start = performance.now()
      let last = snapshotAt(simulation, START_TIME)
      fn(last)
      const timer = setInterval(() => {
        last = snapshotAt(
          simulation,
          START_TIME + ((performance.now() - start) / 1000) * SIM_RATE,
          last,
        )
        fn(last)
      }, interval)
      return () => clearInterval(timer)
    },
  }
}
/** Local east/up/north coordinates, metres. Suitable for bounded local scenes only. */
export function toLocal(position: Position, origin: Position) {
  const r = 6378137
  const rad = Math.PI / 180
  const delta = ((position.longitude - origin.longitude + 540) % 360) - 180
  return {
    x: delta * rad * r * Math.cos(origin.latitude * rad),
    y: 0,
    z: -(position.latitude - origin.latitude) * rad * r,
  }
}
export function validView(value: unknown): ViewId {
  return typeof value === 'string' && Object.hasOwn(scenes, value) ? (value as ViewId) : 'canada'
}
