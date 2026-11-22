/**
 * Deterministic fleet simulation over the synthetic registry (fleet.json + harbours.json).
 * Every vessel loops through one trip cycle: alongside → hail out → transit out → fishing
 * → hail in → transit back → landing. Position, status and hail history are pure functions
 * of the demo clock, so any moment can be reproduced and the dashboard counters, the map
 * and the hail feed always agree.
 */
import type {
  Coast,
  DfoRegion,
  FleetFile,
  FleetVessel,
  Harbour,
  HarbourFile,
  LonLat,
} from './fleet'

export type VesselStatus = 'in-port' | 'outbound' | 'fishing' | 'inbound'
/** Which close-up scenery a vessel opens into. */
export type SceneryKind = 'offshore' | 'inshore' | 'harbour'

export interface LiveVessel {
  id: string
  name: string
  cfv: string
  coast: Coast
  region: DfoRegion
  lengthM: number
  gear: string
  species: string
  zone: 'offshore' | 'inshore'
  homePort: string
  homePortName: string
  area: string
  licences: number
  status: VesselStatus
  longitude: number
  latitude: number
  /** Degrees clockwise from north. */
  heading: number
  /** Knots. */
  speed: number
  /** Estimated catch on board, kg (hailed figure when inbound). */
  onboardKg: number
  /** Trip progress 0..1 within the current status leg. */
  progress: number
}

export interface HailEvent {
  key: string
  time: number
  kind: 'out' | 'in'
  vesselId: string
  name: string
  port: string
  area: string
  species: string
  coast: Coast
  region: DfoRegion
  /** Hail-in only: estimated landing, kg. */
  estimateKg: number
  from: LonLat
  to: LonLat
}

export interface FleetStats {
  vessels: number
  atSea: number
  fishing: number
  inPort: number
  inbound: number
  outbound: number
  hailOuts: number
  hailIns: number
  landingsKg: number
  byRegion: Record<DfoRegion, { atSea: number; inPort: number; vessels: number }>
  bySpecies: { species: string; atSea: number }[]
}

export type HailTotals = Record<
  'canada' | Coast,
  { hailOuts: number; hailIns: number; landingsKg: number }
>
export function emptyTotals(): HailTotals {
  const zero = () => ({ hailOuts: 0, hailIns: 0, landingsKg: 0 })
  return { canada: zero(), atlantic: zero(), pacific: zero() }
}
/** a + b − c, per scope and field. */
export function combineTotals(a: HailTotals, b: HailTotals, c: HailTotals): HailTotals {
  const out = emptyTotals()
  for (const scope of ['canada', 'atlantic', 'pacific'] as const)
    for (const key of ['hailOuts', 'hailIns', 'landingsKg'] as const)
      out[scope][key] = a[scope][key] + b[scope][key] - c[scope][key]
  return out
}

/** Demo seconds per real second: about one hail per second across ~2,800 vessels. */
export const SIM_RATE = 0.22
/** Length of the rolling "last 24 hours" window, demo seconds. */
export const DAY = 2400
const REGIONS: DfoRegion[] = ['NL', 'MAR', 'GLF', 'QC', 'PAC', 'ARC']

/** Fractions of the trip cycle: alongside, transit out, fishing, transit in. */
function legs(zone: 'offshore' | 'inshore') {
  return zone === 'inshore'
    ? { port: 0.5, out: 0.07, fish: 0.36, back: 0.07 }
    : { port: 0.32, out: 0.12, fish: 0.44, back: 0.12 }
}

/** Typical landing per trip, kg, before length scaling. */
const CATCH_PER_METRE: Record<string, number> = {
  Lobster: 45,
  'Snow crab': 520,
  'Northern shrimp': 900,
  Shrimp: 900,
  Scallop: 380,
  Cod: 140,
  Haddock: 260,
  Halibut: 120,
  'Atlantic halibut': 120,
  'Pacific halibut': 160,
  'Greenland halibut': 520,
  Turbot: 520,
  Herring: 1900,
  Capelin: 1600,
  Mackerel: 260,
  Redfish: 700,
  Swordfish: 90,
  Salmon: 420,
  Prawn: 40,
  'Spot prawn': 40,
  'Dungeness crab': 70,
  Sablefish: 260,
  Groundfish: 820,
  'Albacore tuna': 200,
}

function hash(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

const rad = Math.PI / 180
function distanceKm(a: LonLat, b: LonLat) {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * rad)
  const y = b[1] - a[1]
  return Math.hypot(x, y) * 111.2
}
function bearing(a: LonLat, b: LonLat) {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * rad)
  const y = b[1] - a[1]
  return (Math.atan2(x, y) / rad + 360) % 360
}

interface Prepared {
  v: FleetVessel
  harbour: Harbour
  /** Harbour → approach → … → ground. */
  path: LonLat[]
  cumulative: number[]
  length: number
  legs: ReturnType<typeof legs>
  /** Alongside position: a little way from the harbour point toward its approach. */
  berth: LonLat
  catchKg: number
  /** Demo scenario: hero vessels hold a fixed status so the story is predictable. */
  pin?: { status: VesselStatus; progress: number }
}

/** Hero vessels used by the close-up scenes: a fixed status for a predictable walkthrough. */
export const HERO_PINS: Record<string, { status: VesselStatus; progress: number }> = {
  'nl-01': { status: 'fishing', progress: 0.4 },
  'nl-02': { status: 'fishing', progress: 0.5 },
  'ns-01': { status: 'in-port', progress: 0.85 },
  'bc-01': { status: 'fishing', progress: 0.3 },
  'bc-02': { status: 'inbound', progress: 0.97 },
}

export class FleetSimulation {
  readonly vessels: Prepared[]
  readonly harbours: Map<string, Harbour>
  readonly licences: FleetFile['licences']
  constructor(fleet: FleetFile, harbourFile: HarbourFile) {
    this.harbours = new Map(harbourFile.harbours.map((h) => [h.id, h]))
    this.licences = fleet.licences
    this.vessels = []
    for (const v of fleet.vessels) {
      const harbour = this.harbours.get(v.homePort)
      if (!harbour) continue
      const path: LonLat[] = [[harbour.lon, harbour.lat], ...v.route]
      const last = path[path.length - 1]!
      if (last[0] !== v.ground.lon || last[1] !== v.ground.lat)
        path.push([v.ground.lon, v.ground.lat])
      const cumulative = [0]
      for (let i = 1; i < path.length; i++)
        cumulative.push(cumulative[i - 1]! + distanceKm(path[i - 1]!, path[i]!))
      const toSea = harbour.approach
      const along = 0.05 + hash(v.id + 'berth') * 0.12
      const across = (hash(v.id + 'side') - 0.5) * 0.004
      const berth: LonLat = [
        harbour.lon + (toSea[0] - harbour.lon) * along + across,
        harbour.lat + (toSea[1] - harbour.lat) * along + across * 0.6,
      ]
      const rate = CATCH_PER_METRE[v.species] ?? 300
      this.vessels.push({
        v,
        harbour,
        path,
        cumulative,
        length: cumulative[cumulative.length - 1]!,
        legs: legs(v.zone),
        berth,
        catchKg: rate * v.lengthM,
        pin: HERO_PINS[v.id],
      })
    }
  }

  /** Point and heading at `km` along the outbound path. */
  private along(p: Prepared, km: number): { at: LonLat; heading: number } {
    const d = Math.max(0, Math.min(p.length, km))
    let i = 1
    while (i < p.cumulative.length - 1 && p.cumulative[i]! < d) i++
    const a = p.path[i - 1]!,
      b = p.path[i]!
    const span = p.cumulative[i]! - p.cumulative[i - 1]! || 1
    const f = (d - p.cumulative[i - 1]!) / span
    return { at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearing(a, b) }
  }

  /** Status and leg progress at demo time t. */
  private state(p: Prepared, t: number): { status: VesselStatus; progress: number; trip: number } {
    if (p.pin) return { ...p.pin, trip: 0 }
    const cycle = t / p.v.cycle + p.v.phase
    const trip = Math.floor(cycle)
    const u = cycle - trip
    const { port, out, fish } = p.legs
    if (u < port) return { status: 'in-port', progress: u / port, trip }
    if (u < port + out) return { status: 'outbound', progress: (u - port) / out, trip }
    if (u < port + out + fish) return { status: 'fishing', progress: (u - port - out) / fish, trip }
    return { status: 'inbound', progress: (u - port - out - fish) / p.legs.back, trip }
  }

  private tripCatch(p: Prepared, trip: number) {
    return Math.round((p.catchKg * (0.6 + hash(`${p.v.id}:${trip}`) * 0.8)) / 10) * 10
  }

  vessel(p: Prepared, t: number): LiveVessel {
    const { status, progress, trip } = this.state(p, t)
    const v = p.v
    let at: LonLat = p.berth
    let heading = bearing([p.harbour.lon, p.harbour.lat], p.harbour.approach)
    let speed = 0
    let onboardKg = 0
    const ease = (x: number) => x * x * (3 - 2 * x)
    if (status === 'outbound') {
      ;({ at, heading } = this.along(p, ease(progress) * p.length))
      speed = 8 + hash(v.id + 'kn') * 4
    } else if (status === 'inbound') {
      const leg = this.along(p, (1 - ease(progress)) * p.length)
      at = leg.at
      heading = (leg.heading + 180) % 360
      speed = 8 + hash(v.id + 'kn') * 4
      onboardKg = this.tripCatch(p, trip)
    } else if (status === 'fishing') {
      // Work the ground: slow lazy loops, small inshore, wider offshore.
      const r = v.zone === 'inshore' ? 0.006 : 0.05
      const w = (t / 60) * (0.6 + hash(v.id + 'w')) + hash(v.id + 'p') * 6.28
      const coslat = Math.cos(v.ground.lat * rad)
      at = [
        v.ground.lon + (Math.sin(w) * r) / coslat,
        v.ground.lat + Math.sin(w * 0.7 + 1) * r * 0.6,
      ]
      heading = (Math.atan2(Math.cos(w) / coslat, Math.cos(w * 0.7 + 1) * 0.42) / rad + 360) % 360
      speed = 2 + hash(v.id + 'fk') * 2.5
      onboardKg = Math.round((this.tripCatch(p, trip) * progress) / 10) * 10
    }
    return {
      id: v.id,
      name: v.name,
      cfv: v.cfv,
      coast: v.coast,
      region: v.region,
      lengthM: v.lengthM,
      gear: v.gear,
      species: v.species,
      zone: v.zone,
      homePort: v.homePort,
      homePortName: p.harbour.name,
      area: v.ground.area,
      licences: v.licences,
      status,
      longitude: at[0],
      latitude: at[1],
      heading,
      speed: Math.round(speed * 10) / 10,
      onboardKg,
      progress,
    }
  }

  snapshot(t: number): LiveVessel[] {
    return this.vessels.map((p) => this.vessel(p, t))
  }

  /** Hail events with time in (from, to], oldest first. Pinned hero vessels do not hail. */
  hails(from: number, to: number): HailEvent[] {
    const events: HailEvent[] = []
    for (const p of this.vessels) {
      if (p.pin) continue
      const { port, out, fish } = p.legs
      for (const [kind, offset] of [
        ['out', port],
        ['in', port + out + fish],
      ] as const) {
        const first = Math.floor(from / p.v.cycle + p.v.phase - offset) + 1
        const last = Math.floor(to / p.v.cycle + p.v.phase - offset)
        for (let k = first; k <= last; k++) {
          const time = (k + offset - p.v.phase) * p.v.cycle
          const harbourAt: LonLat = [p.harbour.lon, p.harbour.lat]
          const groundAt: LonLat = [p.v.ground.lon, p.v.ground.lat]
          events.push({
            key: `${p.v.id}:${kind}:${k}`,
            time,
            kind,
            vesselId: p.v.id,
            name: p.v.name,
            port: p.harbour.name,
            area: p.v.ground.area,
            species: p.v.species,
            coast: p.v.coast,
            region: p.v.region,
            estimateKg: kind === 'in' ? this.tripCatch(p, k) : 0,
            from: kind === 'out' ? harbourAt : groundAt,
            to: kind === 'out' ? groundAt : harbourAt,
          })
        }
      }
    }
    return events.sort((a, b) => a.time - b.time)
  }

  /** Hail totals per scope over a window: the rolling 24 h counters. */
  hailTotals(events: HailEvent[]): HailTotals {
    const totals = emptyTotals()
    for (const e of events)
      for (const scope of [totals.canada, totals[e.coast]]) {
        if (e.kind === 'out') scope.hailOuts++
        else {
          scope.hailIns++
          scope.landingsKg += e.estimateKg
        }
      }
    return totals
  }

  /** Licences held by the vessel's licence holder (synthetic, stable per vessel). */
  licencesOf(id: string): Licence[] {
    const p = this.vessels.find((x) => x.v.id === id)
    if (!p) return []
    const v = p.v
    const number = (k: number) =>
      `${v.region}-${String(Math.floor(hash(`${v.id}:lic:${k}`) * 900000) + 100000)}`
    const list: Licence[] = [
      { number: number(0), species: v.species, gear: v.gear, area: v.ground.area, open: true },
    ]
    const pool = SIDE_LICENCES[v.region].filter(([sp]) => sp !== v.species)
    for (let k = 1; k < v.licences && pool.length; k++) {
      const [species, gear] = pool.splice(
        Math.floor(hash(`${v.id}:pick:${k}`) * pool.length),
        1,
      )[0]!
      list.push({
        number: number(k),
        species,
        gear,
        area: v.ground.area,
        open: hash(`${v.id}:season:${k}`) < 0.45,
      })
    }
    return list
  }

  /** The vessel's most recent hails before demo time t, newest first. */
  history(id: string, t: number, count = 6): HailEvent[] {
    const p = this.vessels.find((x) => x.v.id === id)
    if (!p) return []
    const { port, out, fish } = p.legs
    const events: HailEvent[] = []
    const last = Math.floor(t / p.v.cycle + p.v.phase)
    for (let k = last; k > last - count && k >= -50; k--)
      for (const [kind, offset] of [
        ['in', port + out + fish],
        ['out', port],
      ] as const) {
        const time = (k + offset - p.v.phase) * p.v.cycle
        if (time > t) continue
        events.push({
          key: `${p.v.id}:${kind}:${k}`,
          time,
          kind,
          vesselId: p.v.id,
          name: p.v.name,
          port: p.harbour.name,
          area: p.v.ground.area,
          species: p.v.species,
          coast: p.v.coast,
          region: p.v.region,
          estimateKg: kind === 'in' ? this.tripCatch(p, k) : 0,
          from: [0, 0],
          to: [0, 0],
        })
      }
    return events.sort((a, b) => b.time - a.time).slice(0, count)
  }

  stats(vessels: LiveVessel[], hails: HailTotals, coast?: Coast): FleetStats {
    const byRegion = Object.fromEntries(
      REGIONS.map((r) => [r, { atSea: 0, inPort: 0, vessels: 0 }]),
    ) as FleetStats['byRegion']
    const species = new Map<string, number>()
    let atSea = 0,
      fishing = 0,
      inbound = 0,
      outbound = 0,
      count = 0
    for (const v of vessels) {
      if (coast && v.coast !== coast) continue
      count++
      const region = byRegion[v.region]
      region.vessels++
      if (v.status === 'in-port') {
        region.inPort++
        continue
      }
      atSea++
      region.atSea++
      if (v.status === 'fishing') fishing++
      else if (v.status === 'inbound') inbound++
      else outbound++
      species.set(v.species, (species.get(v.species) ?? 0) + 1)
    }
    const { hailOuts, hailIns, landingsKg } = hails[coast ?? 'canada']
    return {
      vessels: count,
      atSea,
      fishing,
      inPort: count - atSea,
      inbound,
      outbound,
      hailOuts,
      hailIns,
      landingsKg,
      byRegion,
      bySpecies: [...species]
        .map(([name, n]) => ({ species: name, atSea: n }))
        .sort((a, b) => b.atSea - a.atSea),
    }
  }
}

export interface Licence {
  number: string
  species: string
  gear: string
  area: string
  /** Season status at the demo date. */
  open: boolean
}

/** Other fisheries a licence holder in a region commonly also holds (synthetic). */
const SIDE_LICENCES: Record<DfoRegion, [string, string][]> = {
  NL: [
    ['Cod', 'Gillnet'],
    ['Capelin', 'Purse seine'],
    ['Lobster', 'Trap'],
    ['Mackerel', 'Handline'],
  ],
  MAR: [
    ['Lobster', 'Trap'],
    ['Haddock', 'Longline'],
    ['Herring', 'Purse seine'],
    ['Halibut', 'Longline'],
  ],
  GLF: [
    ['Lobster', 'Trap'],
    ['Herring', 'Gillnet'],
    ['Mackerel', 'Handline'],
    ['Snow crab', 'Trap'],
  ],
  QC: [
    ['Lobster', 'Trap'],
    ['Snow crab', 'Trap'],
    ['Greenland halibut', 'Gillnet'],
  ],
  PAC: [
    ['Salmon', 'Troll'],
    ['Spot prawn', 'Trap'],
    ['Dungeness crab', 'Trap'],
    ['Halibut', 'Longline'],
  ],
  ARC: [
    ['Turbot', 'Gillnet'],
    ['Shrimp', 'Bottom trawl'],
  ],
}

/** Which close-up scenery a vessel opens into, from where it is and what it is doing. */
export function sceneryFor(v: Pick<LiveVessel, 'status' | 'zone' | 'progress'>): SceneryKind {
  if (v.status === 'in-port') return 'harbour'
  if (v.status === 'inbound' && v.progress > 0.9) return 'harbour'
  if (v.status === 'outbound' && v.progress < 0.1) return 'harbour'
  return v.zone === 'inshore' ? 'inshore' : 'offshore'
}
