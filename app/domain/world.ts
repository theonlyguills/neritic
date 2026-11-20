export type Coast = 'atlantic' | 'pacific'
export type ViewId = 'canada' | Coast | 'vessel'
export interface Position {
  longitude: number
  latitude: number
}
export interface Vessel {
  id: string
  name: string
  coast: Coast
  position: Position
  heading: number
  speed: number
  region: string
  localScene?: string
}
export interface Snapshot {
  time: number
  vessels: Vessel[]
}
export interface DataProvider {
  snapshot(time: number): Snapshot
  subscribe(listener: (snapshot: Snapshot) => void): () => void
}
export interface SceneDefinition {
  id: ViewId
  renderer: 'cesium' | 'three'
  title: string
  subtitle: string
  anchor: Position
  height: number
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
    title: 'A wider perspective.',
    subtitle: 'Two oceans. One connected view.',
    anchor: { longitude: -96, latitude: 57 },
    height: 7800000,
  },
  atlantic: {
    id: 'atlantic',
    renderer: 'cesium',
    title: 'Northwest Atlantic',
    subtitle: 'NAFO divisions · Regional activity',
    anchor: { longitude: -56, latitude: 48 },
    height: 2200000,
  },
  pacific: {
    id: 'pacific',
    renderer: 'cesium',
    title: 'Canadian Pacific',
    subtitle: 'Fisheries management areas · Regional activity',
    anchor: { longitude: -129, latitude: 51 },
    height: 1150000,
  },
  vessel: {
    id: 'vessel',
    renderer: 'three',
    title: 'Northern Light',
    subtitle: 'Grand Banks · Illustrative offshore scene',
    anchor: { longitude: -50, latitude: 46 },
    height: 60,
    local: {
      modelUrl: '/assets/stern-trawler-40m.glb',
      farModelUrl: '/assets/stern-trawler-40m-far.glb',
      crewUrl: '/assets/deck-crew.glb',
      sky: {
        // Poly Haven "Table Mountain 2"; sun measured in the image (see manifest).
        url: '/assets/table-mountain-sky.hdr',
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
const fleet: Vessel[] = [
  {
    id: 'nl-01',
    name: 'Northern Light',
    coast: 'atlantic',
    position: { longitude: -50, latitude: 46 },
    heading: 62,
    speed: 7.2,
    region: '3L',
    localScene: 'vessel',
  },
  {
    id: 'nl-02',
    name: 'Atlantic Dawn',
    coast: 'atlantic',
    position: { longitude: -53, latitude: 44 },
    heading: 110,
    speed: 5.8,
    region: '3O',
  },
  {
    id: 'nl-03',
    name: 'Labrador Star',
    coast: 'atlantic',
    position: { longitude: -53, latitude: 52 },
    heading: 145,
    speed: 6.4,
    region: '2J',
  },
  {
    id: 'nl-04',
    name: 'Cape Horizon',
    coast: 'atlantic',
    position: { longitude: -59, latitude: 45 },
    heading: 250,
    speed: 4.2,
    region: '4V',
  },
  {
    id: 'bc-01',
    name: 'Pacific Dawn',
    coast: 'pacific',
    position: { longitude: -128, latitude: 49 },
    heading: 310,
    speed: 6.1,
    region: 'Offshore',
  },
  {
    id: 'bc-02',
    name: 'Western Sound',
    coast: 'pacific',
    position: { longitude: -132, latitude: 52 },
    heading: 120,
    speed: 5.3,
    region: 'Offshore',
  },
  {
    id: 'bc-03',
    name: 'Cedar Bay',
    coast: 'pacific',
    position: { longitude: -130, latitude: 50.5 },
    heading: 80,
    speed: 7.0,
    region: 'Offshore',
  },
]
export function snapshotAt(time: number): Snapshot {
  return {
    time,
    vessels: fleet.map((v, i) => ({
      ...v,
      position: {
        longitude: v.position.longitude + Math.sin(time / 900 + i) * 0.012,
        latitude: v.position.latitude + Math.sin(time / 1100 + i) * 0.008,
      },
    })),
  }
}
export function createDemoProvider(): DataProvider {
  const start = Date.now()
  return {
    snapshot: snapshotAt,
    subscribe(fn) {
      fn(snapshotAt(0))
      const timer = setInterval(() => fn(snapshotAt((Date.now() - start) / 1000)), 1000)
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
