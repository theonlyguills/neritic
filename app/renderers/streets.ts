/**
 * Street life for the coastal sceneries, from OpenStreetMap (public/scenery/<id>/streets.json,
 * scripts/fetch-streets.mjs): asphalt and gravel roads draped on the terrain with lane
 * markings, sidewalks where there are houses, wooden utility poles with sagging wires,
 * parked cars and pickups, and the town's gas stations (canopy, pumps, price sign).
 * Geometry is merged per material and cars are instanced, so the whole layer is a handful
 * of draw calls.
 */
import * as T from 'three'
import {
  Mesher,
  cap,
  colour,
  hash2,
  mulberry32,
  orientedBox,
  patch,
  pick,
  ringCentroid,
  weatheredMaterial,
  type V3,
  type XZ,
} from './scenery'

export interface StreetRoad {
  kind: string
  width: number
  surface: string
  service?: string
  bridge?: boolean
  points: XZ[]
}
export interface StreetsFile {
  roads: StreetRoad[]
  fuel: { x: number; z: number; polygon?: XZ[] }[]
  parking: { polygon: XZ[] }[]
  canopies: { polygon: XZ[] }[]
}

type HeightAt = (x: number, z: number) => number

/** 0 driveway/service/track, 1 residential, 2 collector, 3 arterial. */
function roadClass(r: StreetRoad) {
  if (/^(primary|trunk|motorway)/.test(r.kind)) return 3
  if (/^(secondary|tertiary)/.test(r.kind)) return 2
  if (/^(residential|unclassified|living_street|pedestrian)$/.test(r.kind)) return 1
  return 0
}

/** Buildings near a point, from a coarse grid of centroids. */
function townIndex(centroids: XZ[], cell = 40) {
  const grid = new Map<string, number>()
  for (const [x, z] of centroids) {
    const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`
    grid.set(key, (grid.get(key) ?? 0) + 1)
  }
  return (x: number, z: number) => {
    const i = Math.floor(x / cell),
      j = Math.floor(z / cell)
    let n = 0
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) n += grid.get(`${i + di},${j + dj}`) ?? 0
    return n
  }
}

interface Sample {
  x: number
  z: number
  /** Unit direction along the road. */
  dx: number
  dz: number
  /** Distance along the road, m. */
  u: number
}

function resample(points: XZ[], step: number): Sample[] {
  const out: Sample[] = []
  let u = 0
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i]!
    const [bx, bz] = points[i + 1]!
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 1e-3) continue
    const n = Math.max(1, Math.ceil(len / step))
    for (let k = 0; k < n; k++) {
      const t = k / n
      out.push({
        x: ax + (bx - ax) * t,
        z: az + (bz - az) * t,
        dx: (bx - ax) / len,
        dz: (bz - az) / len,
        u: u + len * t,
      })
    }
    u += len
  }
  const last = points[points.length - 1]!
  const prev = out[out.length - 1]
  if (prev) out.push({ x: last[0], z: last[1], dx: prev.dx, dz: prev.dz, u })
  // Smooth directions at the joints (mitred ribbons without gaps).
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1]!,
      c = out[i + 1]!
    const dx = c.x - a.x,
      dz = c.z - a.z
    const l = Math.hypot(dx, dz) || 1
    out[i]!.dx = dx / l
    out[i]!.dz = dz / l
  }
  return out
}

function roadMaterial() {
  const material = new T.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  patch(material, {
    key: 'streets-road',
    vertexHeader: 'attribute vec4 aRoad;\nvarying vec4 vRoad;',
    vertexMain: 'vRoad = aRoad;',
    fragmentHeader: 'varying vec4 vRoad;',
    colour: /* glsl */ `
    {
      // aRoad: distance along (m), across (-1..1), width (m), class (0..3; -1 gravel; 9 sidewalk).
      float u = vRoad.x, s = vRoad.y, w = vRoad.z, k = vRoad.w;
      vec2 P = vSWorld.xz;
      float px = max(length(fwidth(P)), 1e-3);
      float detail = 1.0 - smoothstep(0.08, 0.7, px);
      vec3 c;
      if (k > 8.5) {
        // Concrete sidewalk with joints every 1.5 m.
        c = sRgb(vec3(0.64, 0.63, 0.6)) * mix(0.86, 1.05, sNoise(P * 0.9));
        c *= 1.0 - smoothstep(0.88, 1.0, fract(u / 1.5)) * 0.25 * detail;
      } else if (k < -0.5) {
        c = sRgb(vec3(0.46, 0.42, 0.36)) * mix(0.75, 1.15, sFbm(P * 0.6));
      } else {
        // Asphalt: patched and worn, darker in the wheel tracks, paler at the edges.
        float wear = sFbm(P * 0.12);
        c = sRgb(vec3(0.28, 0.285, 0.29)) * mix(0.82, 1.18, wear);
        c *= mix(1.0, 0.82, smoothstep(0.25, 0.0, abs(abs(s) - 0.45)) * 0.6);
        c = mix(c, sRgb(vec3(0.32, 0.31, 0.29)), smoothstep(0.82, 1.0, abs(s)) * 0.5);
        c *= mix(0.92, 1.06, sNoise(P * 3.1));
        float halfW = 0.5 * w;
        float across = s * halfW;
        // Dashed yellow centre line on collectors and arterials; white edge lines on arterials.
        float centre = step(1.5, k) * step(abs(across), 0.08) * step(fract(u / 9.0), 0.55);
        float edge = step(2.5, k) * step(halfW - 0.55, abs(across)) * step(abs(across), halfW - 0.4);
        vec3 paint = mix(sRgb(vec3(0.85, 0.66, 0.16)), sRgb(vec3(0.88, 0.88, 0.85)), edge);
        float marking = max(centre, edge) * detail * mix(0.6, 1.0, sNoise(P * 4.0));
        c = mix(c, paint, marking);
      }
      diffuseColor.rgb = c;
    }
    `,
  })
  return material
}

/** A small car or a pickup, bow +X, wheels on y = 0; white body, dark glass and tyres. */
function vehicleGeometry(pickup: boolean) {
  const m = new Mesher()
  const box = (x0: number, x1: number, y0: number, y1: number, w: number, rgb: T.Color) => {
    const z0 = -w / 2,
      z1 = w / 2
    const v = (x: number, y: number, z: number): V3 => [x, y, z]
    m.quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1), rgb, [0, 1, 0])
    m.quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), rgb, [0, 0, 1])
    m.quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0), rgb, [0, 0, -1])
    m.quad(v(x1, y0, z0), v(x1, y0, z1), v(x1, y1, z1), v(x1, y1, z0), rgb, [1, 0, 0])
    m.quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), rgb, [-1, 0, 0])
  }
  const body = colour('#ffffff'),
    glass = colour('#1d2226'),
    tyre = colour('#0e0e0e'),
    light = colour('#f2efe2')
  const L = pickup ? 5.4 : 4.5
  const W = pickup ? 1.95 : 1.8
  box(-L / 2, L / 2, 0.32, pickup ? 1.05 : 0.95, W, body)
  if (pickup) {
    box(-0.2, 1.6, 1.05, 1.82, W - 0.1, glass) // cab
    box(-0.15, 1.55, 1.8, 1.86, W - 0.16, body) // cab roof
    box(-L / 2, -0.25, 1.05, 1.35, W, body) // bed sides
  } else {
    box(-1.25, 1.05, 0.95, 1.45, W - 0.12, glass)
    box(-1.15, 0.95, 1.44, 1.5, W - 0.2, body) // roof
  }
  box(L / 2 - 0.02, L / 2 + 0.02, 0.6, 0.8, W - 0.4, light) // headlights band
  for (const x of [L / 2 - 0.85, -L / 2 + 0.85])
    for (const side of [-1, 1]) {
      const z = side * (W / 2 - 0.12)
      const r = 0.34
      for (let k = 0; k < 8; k++) {
        const a0 = (k / 8) * Math.PI * 2,
          a1 = ((k + 1) / 8) * Math.PI * 2
        const p = (a: number, dz: number): V3 => [x + Math.cos(a) * r, r + Math.sin(a) * r, z + dz]
        m.quad(p(a0, -0.13), p(a1, -0.13), p(a1, 0.13), p(a0, 0.13), tyre, [
          Math.cos((a0 + a1) / 2),
          Math.sin((a0 + a1) / 2),
          0,
        ])
        m.tri([x, r, z + 0.13 * side], p(a0, 0.13 * side), p(a1, 0.13 * side), tyre, [0, 0, side])
      }
    }
  return m.build()
}

const CAR_COLOURS = [
  '#e9e9e6',
  '#e9e9e6',
  '#d8d9d6',
  '#a8acaf',
  '#a8acaf',
  '#6b7074',
  '#3d4145',
  '#1a1c1e',
  '#1a1c1e',
  '#1f3550',
  '#2f5d8a',
  '#8e1f1f',
  '#6e1a17',
  '#4c5d43',
  '#b9a27f',
]

export function buildStreets(
  streets: StreetsFile,
  heightAt: HeightAt,
  buildings: XZ[],
  shadows: boolean,
  seed: number,
  /** House footprints: some get a car in the driveway beside them. */
  houses: XZ[][] = [],
  /** Share of parked cars kept (1 = all), for busy towns on modest GPUs. */
  carShare = 1,
) {
  const group = new T.Group()
  group.name = 'streets'
  const disposables: { dispose(): void }[] = []
  const rnd = mulberry32(seed)
  const town = townIndex(buildings)
  const roads = new Mesher({ aRoad: 4 })
  const fixtures = new Mesher() // poles, canopies, pumps, signs
  const wires: number[] = []
  /** Road corridors as rings, for keeping trees off the roads. */
  const corridors: XZ[][] = []
  const parked: { x: number; z: number; yaw: number; pickup: boolean }[] = []
  const ground = (x: number, z: number) => Math.max(heightAt(x, z), 0.4)

  const ordered = [...streets.roads].sort((a, b) => roadClass(a) - roadClass(b))
  for (const road of ordered) {
    const cls = roadClass(road)
    const gravel = /gravel|dirt|ground|unpaved|compacted|fine_gravel/.test(road.surface)
    const code = gravel ? -1 : cls
    const w = road.width
    const samples = resample(road.points, 4)
    if (samples.length < 2) continue
    // Higher classes sit a hair above lower ones where they cross.
    const lift = 0.14 + cls * 0.012
    const left: V3[] = [],
      right: V3[] = []
    for (const s of samples) {
      const nx = -s.dz,
        nz = s.dx
      const lx = s.x + nx * w * 0.5,
        lz = s.z + nz * w * 0.5
      const rx = s.x - nx * w * 0.5,
        rz = s.z - nz * w * 0.5
      const yc = road.bridge ? Math.max(heightAt(s.x, s.z), 2.2) : ground(s.x, s.z)
      left.push([lx, Math.max(ground(lx, lz), yc - 0.6) + lift, lz])
      right.push([rx, Math.max(ground(rx, rz), yc - 0.6) + lift, rz])
    }
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i]!,
        b = samples[i + 1]!
      roads.quad(left[i]!, left[i + 1]!, right[i + 1]!, right[i]!, colour('#ffffff'), [0, 1, 0], {
        aRoad: [
          [a.u, 1, w, code],
          [b.u, 1, w, code],
          [b.u, -1, w, code],
          [a.u, -1, w, code],
        ],
      })
    }
    const margin = cls >= 1 ? 2.5 : 1
    corridors.push([
      ...samples.map((s): XZ => [s.x - s.dz * (w / 2 + margin), s.z + s.dx * (w / 2 + margin)]),
      ...[...samples]
        .reverse()
        .map((s): XZ => [s.x + s.dz * (w / 2 + margin), s.z - s.dx * (w / 2 + margin)]),
    ])
    if (gravel || cls === 0) {
      // Driveways: a car near the house end, now and then.
      if (road.service === 'driveway' && rnd() < 0.55) {
        const end = samples[samples.length - 2]!
        parked.push({ x: end.x, z: end.z, yaw: Math.atan2(end.dz, end.dx), pickup: rnd() < 0.4 })
      }
      continue
    }
    // In town: sidewalks, kerb-side parking and utility poles.
    const inTown = samples.map((s) => town(s.x, s.z) >= 3)
    const walk = 1.7,
      kerb = 0.25
    for (const side of [1, -1]) {
      if (cls < 1) break
      for (let i = 0; i < samples.length - 1; i++) {
        if (!inTown[i] || !inTown[i + 1]) continue
        const edge = (s: Sample, off: number): V3 => {
          const x = s.x - s.dz * off * side,
            z = s.z + s.dx * off * side
          return [x, Math.max(ground(x, z), ground(s.x, s.z) - 0.4) + lift + 0.15, z]
        }
        const a = samples[i]!,
          b = samples[i + 1]!
        roads.quad(
          edge(a, w / 2 + kerb),
          edge(b, w / 2 + kerb),
          edge(b, w / 2 + kerb + walk),
          edge(a, w / 2 + kerb + walk),
          colour('#ffffff'),
          [0, 1, 0],
          {
            aRoad: [
              [a.u, 0, walk, 9],
              [b.u, 0, walk, 9],
              [b.u, 0, walk, 9],
              [a.u, 0, walk, 9],
            ],
          },
        )
      }
    }
    // Kerb-side parking on residential streets.
    if (cls === 1)
      for (let u = 6 + rnd() * 20; u < samples[samples.length - 1]!.u - 6; u += 14 + rnd() * 40) {
        const s = samples.find((x) => x.u >= u)
        if (!s || town(s.x, s.z) < 3 || rnd() > 0.6) continue
        const side = rnd() < 0.5 ? 1 : -1
        const off = w / 2 - 1.05
        parked.push({
          x: s.x - s.dz * off * side,
          z: s.z + s.dx * off * side,
          yaw: Math.atan2(s.dz, s.dx) + (side < 0 ? Math.PI : 0),
          pickup: rnd() < 0.35,
        })
      }
    // Utility poles on one side, about every 38 m, wires sagging between them.
    const poleSide = hash2(Math.round(samples[0]!.x), Math.round(samples[0]!.z)) < 0.5 ? 1 : -1
    const off = w / 2 + (inTown.some(Boolean) ? kerb + walk + 0.6 : 2.2)
    let previous: { top: V3; nx: number; nz: number } | undefined
    for (let u = 10; u < samples[samples.length - 1]!.u; u += 38) {
      const s = samples.find((x) => x.u >= u)
      if (!s) break
      const near = town(s.x, s.z)
      if (near < 1 && cls < 2) {
        previous = undefined
        continue
      }
      const nx = -s.dz * poleSide,
        nz = s.dx * poleSide
      const x = s.x + nx * off,
        z = s.z + nz * off
      const y = ground(x, z)
      if (heightAt(x, z) < 0.3) {
        previous = undefined
        continue
      }
      const pole = colour('#4e4035')
      fixtures.cylinder(x, z, y - 0.5, y + 10.5, 0.15, 0.12, 6, pole)
      // Crossarm across the road direction.
      const ax = s.dx,
        az = s.dz
      const arm = (k: number): V3 => [x + ax * k, y + 9.9, z + az * k]
      const arm2 = (k: number): V3 => [x + ax * k, y + 10.05, z + az * k]
      fixtures.quad(arm(-1.1), arm(1.1), arm2(1.1), arm2(-1.1), pole, [nx, 0, nz])
      fixtures.quad(arm(-1.1), arm(1.1), arm2(1.1), arm2(-1.1), pole, [-nx, 0, -nz])
      fixtures.quad(
        arm2(-1.1),
        arm2(1.1),
        [x + ax * 1.1 + nx * 0.1, y + 10.05, z + az * 1.1 + nz * 0.1],
        [x - ax * 1.1 + nx * 0.1, y + 10.05, z - az * 1.1 + nz * 0.1],
        pole,
        [0, 1, 0],
      )
      if (hash2(Math.round(x * 3), Math.round(z * 3)) < 0.18)
        fixtures.cylinder(
          x + nx * 0.45,
          z + nz * 0.45,
          y + 7.6,
          y + 8.8,
          0.3,
          0.3,
          8,
          colour('#7d8285'),
        )
      const top: V3 = [x, y + 10.05, z]
      if (previous) {
        const a = previous.top
        const span = Math.hypot(top[0] - a[0], top[2] - a[2])
        if (span < 60)
          for (const k of [-1, 0, 1]) {
            const ox = ax * k * 0.95,
              oz = az * k * 0.95
            const sag = 0.35 + span * 0.012
            let px = a[0] + ox,
              py = a[1] + (k === 0 ? 0.25 : 0),
              pz = a[2] + oz
            for (let t = 1; t <= 8; t++) {
              const f = t / 8
              const qx = a[0] + (top[0] - a[0]) * f + ox
              const qz = a[2] + (top[2] - a[2]) * f + oz
              const qy = a[1] + (top[1] - a[1]) * f + (k === 0 ? 0.25 : 0) - sag * 4 * f * (1 - f)
              wires.push(px, py, pz, qx, qy, qz)
              ;[px, py, pz] = [qx, qy, qz]
            }
          }
      }
      previous = { top, nx, nz }
    }
  }

  // Driveways: about a third of houses have a car or pickup beside them, nose to the street.
  const toStreet = streetFinder(streets)
  for (const ring of houses) {
    const [cx, cz] = ringCentroid(ring)
    if (hash2(Math.round(cx * 2), Math.round(cz * 2)) > 0.36) continue
    const dir = toStreet(cx, cz)
    if (!dir) continue
    let depth = 0,
      width = 0
    for (const [x, z] of ring) {
      depth = Math.max(depth, (x - cx) * dir[0] + (z - cz) * dir[1])
      width = Math.max(width, Math.abs(-(x - cx) * dir[1] + (z - cz) * dir[0]))
    }
    const side = hash2(Math.round(cz * 3), Math.round(cx * 3)) < 0.5 ? 1 : -1
    const x = cx + dir[0] * Math.max(0, depth - 3) - dir[1] * side * (width + 2.2)
    const z = cz + dir[1] * Math.max(0, depth - 3) + dir[0] * side * (width + 2.2)
    if (heightAt(x, z) < 0.5) continue
    parked.push({ x, z, yaw: Math.atan2(dir[1], dir[0]), pickup: rnd() < 0.42 })
  }

  // Parking lots: rows of stalls along the lot's long axis, some of them taken.
  for (const lot of streets.parking) {
    const box = orientedBox(lot.polygon)
    const lenU = box.maxU - box.minU,
      lenV = box.maxV - box.minV
    if (lenU * lenV < 120) continue
    const along = lenU >= lenV
    const [a0, a1] = along ? [box.minU, box.maxU] : [box.minV, box.maxV]
    const [b0, b1] = along ? [box.minV, box.maxV] : [box.minU, box.maxU]
    const at = (p: number, q: number): XZ =>
      along
        ? [p * box.ux - q * box.uz, p * box.uz + q * box.ux]
        : [q * box.ux - p * box.uz, q * box.uz + p * box.ux]
    // Asphalt pad.
    const ring = [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)]
    let filled = 0
    for (let q = b0 + 2.8; q < b1 - 2.5 && filled < 24; q += 6.5)
      for (let p = a0 + 1.6; p < a1 - 1.4 && filled < 24; p += 2.7) {
        if (rnd() > 0.5) continue
        const [x, z] = at(p, q)
        const yaw = along ? Math.atan2(box.ux, -box.uz) : Math.atan2(box.uz, box.ux)
        parked.push({ x, z, yaw: yaw + (rnd() < 0.5 ? Math.PI : 0), pickup: rnd() < 0.3 })
        filled++
      }
    roads.quad(
      [ring[0]![0], ground(ring[0]![0], ring[0]![1]) + 0.12, ring[0]![1]],
      [ring[1]![0], ground(ring[1]![0], ring[1]![1]) + 0.12, ring[1]![1]],
      [ring[2]![0], ground(ring[2]![0], ring[2]![1]) + 0.12, ring[2]![1]],
      [ring[3]![0], ground(ring[3]![0], ring[3]![1]) + 0.12, ring[3]![1]],
      colour('#ffffff'),
      [0, 1, 0],
      {
        aRoad: [
          [0, -1, 1, 0],
          [lenU, -1, 1, 0],
          [lenU, 1, 1, 0],
          [0, 1, 1, 0],
        ],
      },
    )
    corridors.push(ring)
  }

  // Gas stations: canopy on posts over two pump islands, and a price sign by the road.
  // A station is often mapped twice (site area and kiosk): one canopy per 40 m.
  const stations: StreetsFile['fuel'] = []
  for (const f of streets.fuel)
    if (!stations.some((o) => Math.hypot(o.x - f.x, o.z - f.z) < 40)) stations.push(f)
  for (const station of stations) {
    const canopy = streets.canopies.find((c) => {
      const [x, z] = ringCentroid(c.polygon)
      return Math.hypot(x - station.x, z - station.z) < 60
    })
    let ring: XZ[]
    if (canopy) ring = canopy.polygon
    else {
      // No mapped canopy: a 16 × 9 m one between the shop and the street, set back from the
      // kerb and square to the road (the mapped station is often the shop itself).
      let best = { d: Infinity, dx: 1, dz: 0, x: station.x, z: station.z, w: 6 }
      for (const road of streets.roads) {
        if (roadClass(road) < 1) continue
        for (let i = 0; i < road.points.length - 1; i++) {
          const [ax, az] = road.points[i]!
          const [bx, bz] = road.points[i + 1]!
          const l = Math.hypot(bx - ax, bz - az) || 1
          const t = Math.max(
            0,
            Math.min(1, ((station.x - ax) * (bx - ax) + (station.z - az) * (bz - az)) / (l * l)),
          )
          const px = ax + (bx - ax) * t,
            pz = az + (bz - az) * t
          const d = Math.hypot(px - station.x, pz - station.z)
          if (d < best.d)
            best = { d, dx: (bx - ax) / l, dz: (bz - az) / l, x: px, z: pz, w: road.width }
        }
      }
      const toward = Math.max(best.d, 1e-3)
      const back = best.w / 2 + 7.5
      const cx = best.x - ((best.x - station.x) / toward) * back
      const cz = best.z - ((best.z - station.z) / toward) * back
      const ux = best.dx,
        uz = best.dz
      ring = [
        [cx - ux * 8 + uz * 4.5, cz - uz * 8 - ux * 4.5],
        [cx + ux * 8 + uz * 4.5, cz + uz * 8 - ux * 4.5],
        [cx + ux * 8 - uz * 4.5, cz + uz * 8 + ux * 4.5],
        [cx - ux * 8 - uz * 4.5, cz - uz * 8 + ux * 4.5],
      ]
    }
    const box = orientedBox(ring)
    const along = box.maxU - box.minU >= box.maxV - box.minV
    const [a0, a1] = along ? [box.minU, box.maxU] : [box.minV, box.maxV]
    const [b0, b1] = along ? [box.minV, box.maxV] : [box.minU, box.maxU]
    const at = (p: number, q: number): XZ =>
      along
        ? [p * box.ux - q * box.uz, p * box.uz + q * box.ux]
        : [q * box.ux - p * box.uz, q * box.uz + p * box.ux]
    const [cx, cz] = at((a0 + a1) / 2, (b0 + b1) / 2)
    const base = ground(cx, cz)
    const top = base + 5.2
    const white = colour('#f1f1ee'),
      band = colour('#b3262a'),
      under = colour('#dcdcd6'),
      post = colour('#c9cbcc')
    const corners = [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)]
    cap(fixtures, corners, top + 0.7, white)
    cap(fixtures, corners, top, under, false)
    for (let i = 0; i < 4; i++) {
      const p = corners[i]!,
        q = corners[(i + 1) % 4]!
      const nx = q[1] - p[1],
        nz = -(q[0] - p[0])
      const l = Math.hypot(nx, nz) || 1
      const f: V3 = [nx / l, 0, nz / l]
      fixtures.quad(
        [p[0], top, p[1]],
        [q[0], top, q[1]],
        [q[0], top + 0.28, q[1]],
        [p[0], top + 0.28, p[1]],
        band,
        f,
      )
      fixtures.quad(
        [p[0], top + 0.28, p[1]],
        [q[0], top + 0.28, q[1]],
        [q[0], top + 0.7, q[1]],
        [p[0], top + 0.7, p[1]],
        white,
        f,
      )
    }
    // Concrete apron, posts and pump islands.
    cap(
      fixtures,
      [at(a0 - 4, b0 - 4), at(a1 + 4, b0 - 4), at(a1 + 4, b1 + 4), at(a0 - 4, b1 + 4)].map(
        (p): XZ => p,
      ),
      base + 0.1,
      colour('#8d8b86'),
    )
    for (const q of [b0 + (b1 - b0) * 0.3, b0 + (b1 - b0) * 0.7]) {
      for (const p of [a0 + (a1 - a0) * 0.25, a0 + (a1 - a0) * 0.75]) {
        const [x, z] = at(p, q)
        fixtures.cylinder(x, z, base, top, 0.22, 0.22, 8, post)
      }
      const [ix, iz] = at((a0 + a1) / 2, q)
      const ux = along ? box.ux : -box.uz,
        uz = along ? box.uz : box.ux
      const island: XZ[] = [
        [ix - ux * 3 - uz * 0.6, iz - uz * 3 + ux * 0.6],
        [ix + ux * 3 - uz * 0.6, iz + uz * 3 + ux * 0.6],
        [ix + ux * 3 + uz * 0.6, iz + uz * 3 - ux * 0.6],
        [ix - ux * 3 + uz * 0.6, iz - uz * 3 - ux * 0.6],
      ]
      cap(fixtures, island, base + 0.25, colour('#b5b3ad'))
      for (const k of [-1.4, 1.4]) {
        const px = ix + ux * k,
          pz = iz + uz * k
        fixtures.cylinder(px, pz, base + 0.25, base + 1.9, 0.42, 0.42, 4, white)
        fixtures.cylinder(px, pz, base + 1.9, base + 2.05, 0.44, 0.44, 4, band)
      }
      if (rnd() < 0.8) {
        parked.push({
          x: ix + uz * 2.4,
          z: iz - ux * 2.4,
          yaw: Math.atan2(uz, ux),
          pickup: rnd() < 0.5,
        })
      }
    }
    // Price sign on a pylon at the corner nearest the road.
    const [sx, sz] = at(a1 + 6, b0 - 5)
    const sy = ground(sx, sz)
    fixtures.cylinder(sx, sz, sy, sy + 4.2, 0.18, 0.18, 6, post)
    const ux = along ? box.ux : -box.uz,
      uz = along ? box.uz : box.ux
    const panel = (y0: number, y1: number, rgb: T.Color) => {
      for (const side of [1, -1])
        fixtures.quad(
          [sx - ux * 1.1, y0, sz - uz * 1.1],
          [sx + ux * 1.1, y0, sz + uz * 1.1],
          [sx + ux * 1.1, y1, sz + uz * 1.1],
          [sx - ux * 1.1, y1, sz - uz * 1.1],
          rgb,
          [-uz * side, 0, ux * side],
        )
    }
    panel(sy + 4.2, sy + 6.4, white)
    panel(sy + 6.4, sy + 7.0, band)
    corridors.push(corners)
  }

  // Meshes.
  const add = (m: Mesher, material: T.Material, name: string, cast: boolean) => {
    if (!m.vertexCount) return material.dispose()
    const geometry = m.build()
    const mesh = new T.Mesh(geometry, material)
    mesh.name = name
    mesh.castShadow = cast
    mesh.receiveShadow = shadows
    group.add(mesh)
    disposables.push(geometry, material)
  }
  add(roads, roadMaterial(), 'roads', false)
  add(fixtures, weatheredMaterial('fixtures', 0.6, 0.4), 'street-fixtures', false)
  if (wires.length) {
    const geometry = new T.BufferGeometry()
    geometry.setAttribute('position', new T.Float32BufferAttribute(wires, 3))
    const material = new T.LineBasicMaterial({ color: '#1a1a1a', transparent: true, opacity: 0.75 })
    const lines = new T.LineSegments(geometry, material)
    lines.name = 'wires'
    group.add(lines)
    disposables.push(geometry, material)
  }
  // Cars and pickups, instanced, sitting on the slope.
  const matrix = new T.Matrix4(),
    q = new T.Quaternion(),
    euler = new T.Euler(0, 0, 0, 'YXZ'),
    pos = new T.Vector3(),
    one = new T.Vector3(1, 1, 1),
    tint = new T.Color()
  // Thin evenly (by position hash) so every street keeps some cars.
  const kept = parked.filter((p) => hash2(Math.round(p.x * 7), Math.round(p.z * 7)) < carShare)
  for (const pickup of [false, true]) {
    const list = kept.filter((p) => p.pickup === pickup && heightAt(p.x, p.z) > 0.3)
    if (!list.length) continue
    const geometry = vehicleGeometry(pickup)
    const material = new T.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.35,
      metalness: 0.35,
    })
    const mesh = new T.InstancedMesh(geometry, material, list.length)
    list.forEach((p, i) => {
      const fx = Math.cos(p.yaw),
        fz = Math.sin(p.yaw)
      const front = ground(p.x + fx * 2, p.z + fz * 2),
        back = ground(p.x - fx * 2, p.z - fz * 2)
      euler.set(0, -p.yaw, Math.atan2(front - back, 4))
      q.setFromEuler(euler)
      pos.set(p.x, ground(p.x, p.z) + 0.12, p.z)
      mesh.setMatrixAt(i, matrix.compose(pos, q, one))
      mesh.setColorAt(
        i,
        tint.set(pick(CAR_COLOURS, hash2(Math.round(p.x * 5), Math.round(p.z * 5)))),
      )
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
    // Instanced across the whole town: as shadow casters they would put every car into the
    // shadow pass; the sun's shadow box only covers the hero's surroundings anyway.
    mesh.castShadow = false
    mesh.receiveShadow = shadows
    mesh.name = pickup ? 'pickups' : 'cars'
    group.add(mesh)
    disposables.push(geometry, material)
  }
  return {
    group,
    corridors,
    stats: { roads: streets.roads.length, cars: kept.length, wireSegments: wires.length / 6 },
    dispose() {
      for (const d of disposables) d.dispose()
    },
  }
}

/** Direction from a point to the nearest drivable street within ~40 m (front doors face it). */
export function streetFinder(streets: StreetsFile) {
  const cell = 20
  const grid = new Map<string, XZ[]>()
  for (const road of streets.roads) {
    if (roadClass(road) < 1) continue
    for (const s of resample(road.points, 6)) {
      const key = `${Math.floor(s.x / cell)},${Math.floor(s.z / cell)}`
      const list = grid.get(key) ?? []
      list.push([s.x, s.z])
      grid.set(key, list)
    }
  }
  return (x: number, z: number): [number, number] | undefined => {
    const i = Math.floor(x / cell),
      j = Math.floor(z / cell)
    let best: XZ | undefined
    let d = 40
    for (let di = -2; di <= 2; di++)
      for (let dj = -2; dj <= 2; dj++)
        for (const p of grid.get(`${i + di},${j + dj}`) ?? []) {
          const e = Math.hypot(p[0] - x, p[1] - z)
          if (e < d) [d, best] = [e, p]
        }
    if (!best || d < 0.5) return undefined
    return [(best[0] - x) / d, (best[1] - z) / d]
  }
}
