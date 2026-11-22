// Builds real-geography scenery for the close-up boat scene: public/scenery/<id>/
//   terrain.bin   513 × 513 little-endian Int16 heights in decimetres (row 0 = north edge)
//   landcover.bin 256 × 256 Uint8 land-cover classes (see LANDCOVER), same extent
//   scenery.json  metadata + OSM features in local metres (x = east, z = −north)
// Sources: AWS Terrain Tiles (terrarium) for elevation, OpenStreetMap (Overpass) for the
// coastline and features. Raw downloads are cached under ~/marine-assets-src/scenery/<id>/.
//
// Usage: node scripts/fetch-scenery.mjs [id] [--debug] [--manifest <file>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'public/scenery')
const CACHE = path.join(os.homedir(), 'marine-assets-src/scenery')
const USER_AGENT = 'asset-fetch/1.0'
const OVERPASS = 'https://overpass-api.de/api/interpreter'
const TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
const GRID = 513
const COVER = 256
const R = 6378137
const RAD = Math.PI / 180

/** Land-cover codes stored in landcover.bin. */
const LANDCOVER = {
  unknown: 0,
  sea: 1,
  wood: 2,
  scrub: 3,
  rock: 4,
  residential: 5,
  industrial: 6,
  grass: 7,
  beach: 8,
  wetland: 9,
  lake: 10,
}

const SCENES = {
  narrows: {
    name: 'The Narrows',
    place: "St. John's",
    province: 'NL',
    type: 'inshore',
    // ~1.5 km ESE of the gap between Signal Hill and Fort Amherst.
    center: { lat: 47.5618, lon: -52.6628 },
    sizeM: 8000,
    zoom: 13,
    forest: 'sparse-scrub',
    deckHeight: 2.2,
    recentre: { radius: 250 },
    // Inbound to St. John's: bow towards the Narrows.
    headingTowards: { lat: 47.5668, lon: -52.6815 },
    // Look through the Narrows: Signal Hill to the right, the South Side Hills to the left.
    viewTowards: { lat: 47.5668, lon: -52.6815 },
  },
  lunenburg: {
    name: 'Lunenburg Harbour',
    place: 'Lunenburg',
    province: 'NS',
    type: 'harbour',
    // Waterfront between the Fisheries Museum of the Atlantic and the Zwicker wharves.
    center: { lat: 44.3749, lon: -64.3085 },
    sizeM: 4000,
    zoom: 14,
    forest: 'sparse-scrub',
    deckHeight: 2.4,
    berth: { near: { lat: 44.3749, lon: -64.3085 }, floating: false },
    // Harbour mouth, between Battery Point and Kaulbach Head, from the open bay.
    entrance: { lat: 44.3615, lon: -64.2905 },
  },
  johnstone: {
    name: 'Johnstone Strait',
    place: 'Telegraph Cove',
    province: 'BC',
    type: 'inshore',
    center: { lat: 50.556, lon: -126.795 },
    sizeM: 10000,
    zoom: 13,
    forest: 'dense-conifer',
    deckHeight: 2.5,
    recentre: { radius: 1500 },
    // Westbound along the strait, towards Telegraph Cove and Broughton Strait.
    headingDeg: 282,
  },
  'prince-rupert': {
    name: 'Fairview Harbour',
    place: 'Prince Rupert',
    province: 'BC',
    type: 'harbour',
    // Fairview floats (Port Edward Harbour Authority), home of the commercial fleet.
    center: { lat: 54.2926, lon: -130.3548 },
    sizeM: 5000,
    zoom: 14,
    forest: 'dense-conifer',
    deckHeight: 4,
    berth: { near: { lat: 54.2928, lon: -130.3548 }, floating: true },
    // The float lines at Fairview are drawn untagged; they are floats (7 m tides).
    floatingNear: { lat: 54.2925, lon: -130.355, radius: 260 },
    entrance: { lat: 54.3005, lon: -130.3705 },
  },
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
// `--harbours`: also build every major harbour in public/data/harbours.json (berth at the
// harbour point, entrance at its approach), skipping ones already defined above.
if (args.includes('--harbours')) {
  const { harbours } = JSON.parse(fs.readFileSync('public/data/harbours.json', 'utf8'))
  for (const h of harbours) {
    if (!h.major || SCENES[h.id]) continue
    const pacific = h.coast === 'pacific'
    SCENES[h.id] = {
      name: `${h.name} Harbour`,
      place: h.name,
      province: h.province,
      type: 'harbour',
      center: { lat: h.lat, lon: h.lon },
      sizeM: 4000,
      zoom: 14,
      forest: pacific ? 'dense-conifer' : 'sparse-scrub',
      deckHeight: pacific ? 4 : 2.4,
      berth: { near: { lat: h.lat, lon: h.lon } },
      entrance: { lat: h.approach[1], lon: h.approach[0] },
    }
  }
}
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const manifestPath = option('--manifest') ?? path.join(CACHE, 'manifest-scenery.json')
const only = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--manifest')
if (only && !SCENES[only]) {
  console.error(`Unknown scene "${only}". Known: ${Object.keys(SCENES).join(', ')}`)
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round1 = (v) => Math.round(v * 10) / 10
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// ---------------------------------------------------------------- projection

function projector(c) {
  const kx = RAD * R * Math.cos(c.lat * RAD)
  const kz = RAD * R
  return {
    toLocal: (lon, lat) => [(((lon - c.lon + 540) % 360) - 180) * kx, -(lat - c.lat) * kz],
    toGeo: (x, z) => ({ lon: c.lon + x / kx, lat: c.lat - z / kz }),
  }
}

function bboxAround(c, halfM) {
  const dLat = halfM / (RAD * R)
  const dLon = halfM / (RAD * R * Math.cos(c.lat * RAD))
  return { s: c.lat - dLat, w: c.lon - dLon, n: c.lat + dLat, e: c.lon + dLon }
}

// ---------------------------------------------------------------- downloads

async function download(url, init = {}, attempts = 9) {
  let wait = 10
  for (let attempt = 1; ; attempt++) {
    let status
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(240_000),
      })
      if (res.ok) return Buffer.from(await res.arrayBuffer())
      status = res.status
      if (status === 404) return undefined
    } catch (error) {
      status = error.message
    }
    if (attempt >= attempts) throw new Error(`${url}: ${status}`)
    console.log(`  ${status}; retrying in ${wait}s`)
    await sleep(wait * 1000)
    wait = Math.min(wait * 1.7, 120)
  }
}

function overpassQuery(b) {
  const box = [b.s, b.w, b.n, b.e].map((v) => +v.toFixed(5)).join(',')
  return `[out:json][timeout:180][bbox:${box}];
(
  way["natural"="coastline"];
  nwr["natural"="water"];
  nwr["waterway"="riverbank"];
  nwr["building"];
  nwr["man_made"~"^(pier|quay|breakwater|groyne|lighthouse|tower|jetty)$"];
  nwr["historic"~"^(castle|tower|fort|monument|memorial)$"];
  nwr["tourism"="attraction"]["name"];
  nwr["landuse"~"^(forest|residential|industrial|commercial|harbour|port|grass|cemetery)$"];
  nwr["natural"~"^(wood|scrub|heath|bare_rock|beach|wetland|grassland|cliff)$"];
  nwr["leisure"~"^(marina|park)$"];
  nwr["seamark:type"~"harbour|landmark"];
);
out body geom qt;`
}

/** One Overpass query per scene, cached; reused while the cached box covers the request. */
async function loadOsm(id, need) {
  const dir = path.join(CACHE, id)
  fs.mkdirSync(dir, { recursive: true })
  const dataFile = path.join(dir, 'overpass.json')
  const queryFile = path.join(dir, 'overpass.query.json')
  if (fs.existsSync(dataFile) && fs.existsSync(queryFile)) {
    const [s, w, n, e] = JSON.parse(fs.readFileSync(queryFile, 'utf8')).bbox
    if (s <= need.s && w <= need.w && n >= need.n && e >= need.e)
      return JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  }
  console.log(`  Overpass query for ${id}`)
  const query = overpassQuery(need)
  const body = await download(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  })
  if (!body) throw new Error('Overpass returned nothing')
  const data = JSON.parse(body.toString('utf8'))
  fs.writeFileSync(dataFile, body)
  fs.writeFileSync(
    queryFile,
    JSON.stringify({ bbox: [need.s, need.w, need.n, need.e], query, retrieved: today() }),
  )
  return data
}

const today = () => new Date().toISOString().slice(0, 10)

// Web Mercator tile maths.
const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z
const latToTileY = (lat, z) =>
  ((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2) * 2 ** z

/** Mosaic of terrarium tiles covering a geographic box; returns a bilinear sampler (metres). */
async function loadElevation(id, box, z) {
  const dir = path.join(CACHE, id, 'tiles')
  fs.mkdirSync(dir, { recursive: true })
  const x0 = Math.floor(lonToTileX(box.w, z)),
    x1 = Math.floor(lonToTileX(box.e, z))
  const y0 = Math.floor(latToTileY(box.n, z)),
    y1 = Math.floor(latToTileY(box.s, z))
  const tiles = new Map()
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const file = path.join(dir, `${z}-${tx}-${ty}.png`)
      if (!fs.existsSync(file)) {
        const body = await download(`${TILES}/${z}/${tx}/${ty}.png`)
        if (!body) throw new Error(`Missing terrain tile ${z}/${tx}/${ty}`)
        fs.writeFileSync(file, body)
        await sleep(60)
      }
      const png = PNG.sync.read(fs.readFileSync(file))
      const heights = new Float32Array(256 * 256)
      for (let i = 0; i < heights.length; i++)
        heights[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768
      tiles.set(`${tx},${ty}`, heights)
    }
  const pixel = (gx, gy) => {
    const tx = Math.floor(gx / 256),
      ty = Math.floor(gy / 256)
    const tile = tiles.get(`${clamp(tx, x0, x1)},${clamp(ty, y0, y1)}`)
    const px = clamp(gx - tx * 256, 0, 255),
      py = clamp(gy - ty * 256, 0, 255)
    return tile[py * 256 + px]
  }
  const count = (x1 - x0 + 1) * (y1 - y0 + 1)
  return {
    count,
    tiles: [...tiles.keys()].map((k) => `${z}/${k.replace(',', '/')}`),
    sample(lon, lat) {
      const fx = lonToTileX(lon, z) * 256 - 0.5,
        fy = latToTileY(lat, z) * 256 - 0.5
      const ix = Math.floor(fx),
        iy = Math.floor(fy)
      const tx = fx - ix,
        ty = fy - iy
      const a = pixel(ix, iy),
        b = pixel(ix + 1, iy),
        c = pixel(ix, iy + 1),
        d = pixel(ix + 1, iy + 1)
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    },
  }
}

// ---------------------------------------------------------------- OSM geometry

/** Joins way fragments (arrays of [lon, lat]) into closed rings by shared endpoints. */
function joinRings(fragments) {
  const pending = fragments.filter((f) => f.length > 1).map((f) => f.slice())
  const rings = []
  const same = (a, b) => a[0] === b[0] && a[1] === b[1]
  while (pending.length) {
    const ring = pending.shift()
    let grown = true
    while (!same(ring[0], ring.at(-1)) && grown) {
      grown = false
      for (let i = 0; i < pending.length; i++) {
        const f = pending[i]
        if (same(ring.at(-1), f[0])) ring.push(...f.slice(1))
        else if (same(ring.at(-1), f.at(-1))) ring.push(...f.reverse().slice(1))
        else continue
        pending.splice(i, 1)
        grown = true
        break
      }
    }
    if (same(ring[0], ring.at(-1)) && ring.length >= 4) rings.push(ring.slice(0, -1))
  }
  return rings
}

/** Areas of an element as outer rings of [lon, lat] (holes ignored), or a line, or a point. */
function shapeOf(e) {
  const pts = (g) => g.map((p) => [p.lon, p.lat])
  if (e.type === 'node') return { point: [e.lon, e.lat] }
  if (e.type === 'way' && e.geometry) {
    const line = pts(e.geometry)
    const closed =
      line.length >= 4 && line[0][0] === line.at(-1)[0] && line[0][1] === line.at(-1)[1]
    return closed ? { rings: [line.slice(0, -1)], line } : { line }
  }
  if (e.type === 'relation' && e.members) {
    const outer = e.members.filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner')
    return { rings: joinRings(outer.map((m) => pts(m.geometry))) }
  }
  return {}
}

function signedArea(ring) {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return a / 2
}

function centroid(ring) {
  let x = 0,
    z = 0
  for (const p of ring) {
    x += p[0]
    z += p[1]
  }
  return [x / ring.length, z / ring.length]
}

function pointInRing(x, z, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i],
      [xj, zj] = ring[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

function simplify(points, tolerance, closed) {
  if (points.length <= (closed ? 4 : 2)) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, az] = points[a],
      [bx, bz] = points[b]
    const dx = bx - ax,
      dz = bz - az
    const len = Math.hypot(dx, dz) || 1e-9
    let worst = -1,
      index = -1
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i][0] - ax) * dz - (points[i][1] - az) * dx) / len
      if (d > worst) {
        worst = d
        index = i
      }
    }
    if (worst > tolerance) {
      keep[index] = 1
      stack.push([a, index], [index, b])
    }
  }
  const out = points.filter((_, i) => keep[i])
  return closed && out.length < 3 ? points : out
}

/** Polygon around a polyline of the given width (mitred joints). */
function bufferLine(line, width) {
  const h = width / 2
  const left = [],
    right = []
  for (let i = 0; i < line.length; i++) {
    const prev = line[Math.max(0, i - 1)],
      next = line[Math.min(line.length - 1, i + 1)]
    let dx = next[0] - prev[0],
      dz = next[1] - prev[1]
    const len = Math.hypot(dx, dz) || 1
    dx /= len
    dz /= len
    // Mitre: scale the offset by 1 / cos(half the turning angle), capped.
    let scale = 1
    if (i > 0 && i < line.length - 1) {
      const ax = line[i][0] - prev[0],
        az = line[i][1] - prev[1]
      const al = Math.hypot(ax, az) || 1
      const cos = (ax * dx + az * dz) / al
      scale = Math.min(1 / Math.max(cos, 0.35), 2.5)
    }
    const nx = -dz * h * scale,
      nz = dx * h * scale
    left.push([line[i][0] + nx, line[i][1] + nz])
    right.push([line[i][0] - nx, line[i][1] - nz])
  }
  return [...left, ...right.reverse()]
}

const roundRing = (ring) => ring.map(([x, z]) => [round1(x), round1(z)])

/** Counter-clockwise in (x, z) means positive signed area by the shoelace sum below. */
function ccw(ring) {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring
}

// ---------------------------------------------------------------- grid helpers

/** Scan-converts a polygon (local metres) onto a grid; calls fn(index) for covered cells. */
function fillPolygon(ring, n, origin, cell, fn) {
  let minZ = Infinity,
    maxZ = -Infinity
  for (const p of ring) {
    minZ = Math.min(minZ, p[1])
    maxZ = Math.max(maxZ, p[1])
  }
  const j0 = Math.max(0, Math.ceil((minZ - origin) / cell)),
    j1 = Math.min(n - 1, Math.floor((maxZ - origin) / cell))
  for (let j = j0; j <= j1; j++) {
    const z = origin + j * cell
    const xs = []
    for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
      const [xi, zi] = ring[i],
        [xk, zk] = ring[k]
      if (zi > z !== zk > z) xs.push(xi + ((z - zi) * (xk - xi)) / (zk - zi))
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - origin) / cell)),
        i1 = Math.min(n - 1, Math.floor((xs[k + 1] - origin) / cell))
      for (let i = i0; i <= i1; i++) fn(j * n + i)
    }
  }
}

/**
 * Land/sea classification from OSM coastline ways (land on the left of the way direction).
 * Coastline segments are rasterised as barriers, the rest is flood-filled into components,
 * and each component is voted land or water by probes on either side of every segment.
 * A nearest-segment distance transform then gives a signed distance (metres, + = land).
 */
function classify(coastWays, n, half, cell) {
  const origin = -half
  // Segments with land-side unit normals; neighbours within the same way for corners.
  const segs = []
  for (const way of coastWays) {
    const first = segs.length
    for (let i = 0; i + 1 < way.length; i++) {
      const [ax, az] = way[i],
        [bx, bz] = way[i + 1]
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 1e-6) continue
      // Land is to the left in map view; with z = −north that is (dz, −dx) in (x, z).
      segs.push({
        ax,
        az,
        bx,
        bz,
        len,
        nx: (bz - az) / len,
        nz: -(bx - ax) / len,
        prev: -1,
        next: -1,
      })
    }
    for (let k = first; k < segs.length; k++) {
      if (k > first) segs[k].prev = k - 1
      if (k + 1 < segs.length) segs[k].next = k + 1
    }
    const a = segs[first],
      b = segs.at(-1)
    if (a && b !== a && Math.hypot(a.ax - b.bx, a.az - b.bz) < 1e-6) {
      a.prev = segs.length - 1
      b.next = first
    }
  }
  const margin = half + cell * 3
  const relevant = segs.filter(
    (s) =>
      Math.max(s.ax, s.bx) > -margin &&
      Math.min(s.ax, s.bx) < margin &&
      Math.max(s.az, s.bz) > -margin &&
      Math.min(s.az, s.bz) < margin,
  )
  const indexOf = new Map(segs.map((s, i) => [s, i]))

  /** Distance from (x, z) to segment k, plus the side (+1 land, −1 water) by pseudo-normal. */
  function probe(k, x, z) {
    const s = segs[k]
    const dx = s.bx - s.ax,
      dz = s.bz - s.az
    const t = clamp(((x - s.ax) * dx + (z - s.az) * dz) / (s.len * s.len), 0, 1)
    const px = s.ax + dx * t,
      pz = s.az + dz * t
    let nx = s.nx,
      nz = s.nz
    if (t <= 0 && s.prev >= 0) {
      nx += segs[s.prev].nx
      nz += segs[s.prev].nz
    } else if (t >= 1 && s.next >= 0) {
      nx += segs[s.next].nx
      nz += segs[s.next].nz
    }
    const side = (x - px) * nx + (z - pz) * nz
    return { d: Math.hypot(x - px, z - pz), side: side >= 0 ? 1 : -1 }
  }

  const N = n * n
  const barrier = new Uint8Array(N)
  const nearest = new Int32Array(N).fill(-1)
  const dist = new Float32Array(N).fill(Infinity)
  const cellOf = (x, z) => {
    const i = Math.round((x - origin) / cell),
      j = Math.round((z - origin) / cell)
    return i < 0 || j < 0 || i >= n || j >= n ? -1 : j * n + i
  }
  const mark = (c, k) => {
    if (c < 0) return
    barrier[c] = 1
    const i = c % n,
      j = (c - i) / n
    const d = probe(k, origin + i * cell, origin + j * cell).d
    if (d < dist[c]) {
      dist[c] = d
      nearest[c] = k
    }
  }
  for (const s of relevant) {
    const k = indexOf.get(s)
    const steps = Math.max(1, Math.ceil(s.len / (cell / 4)))
    let prev = -1
    for (let q = 0; q <= steps; q++) {
      const x = s.ax + ((s.bx - s.ax) * q) / steps,
        z = s.az + ((s.bz - s.az) * q) / steps
      const c = cellOf(x, z)
      if (c >= 0 && prev >= 0 && c !== prev) {
        const pi = prev % n,
          ci = c % n
        // Diagonal step: close the gap so a 4-connected fill cannot leak through.
        if (pi !== ci && (prev - pi) / n !== (c - ci) / n) mark(((c - ci) / n) * n + pi, k)
      }
      mark(c, k)
      prev = c
    }
  }
  // Components of non-barrier cells.
  const comp = new Int32Array(N).fill(-1)
  let comps = 0
  const queue = new Int32Array(N)
  for (let start = 0; start < N; start++) {
    if (barrier[start] || comp[start] >= 0) continue
    let head = 0,
      tail = 0
    queue[tail++] = start
    comp[start] = comps
    while (head < tail) {
      const c = queue[head++]
      const i = c % n
      const neighbours = [i > 0 ? c - 1 : -1, i < n - 1 ? c + 1 : -1, c - n, c + n]
      for (const m of neighbours) {
        if (m < 0 || m >= N || barrier[m] || comp[m] >= 0) continue
        comp[m] = comps
        queue[tail++] = m
      }
    }
    comps++
  }
  const votes = new Float64Array(comps)
  for (const s of relevant) {
    const steps = Math.max(1, Math.round(s.len / cell))
    for (let q = 0; q < steps; q++) {
      const t = (q + 0.5) / steps
      const x = s.ax + (s.bx - s.ax) * t,
        z = s.az + (s.bz - s.az) * t
      for (const [sign, off] of [
        [1, 1.6],
        [-1, -1.6],
        [1, 2.6],
        [-1, -2.6],
      ]) {
        const c = cellOf(x + s.nx * off * cell, z + s.nz * off * cell)
        if (c >= 0 && !barrier[c]) votes[comp[c]] += sign
      }
    }
  }
  const land = new Uint8Array(N)
  for (let c = 0; c < N; c++) {
    if (barrier[c]) {
      const i = c % n,
        j = (c - i) / n
      land[c] = probe(nearest[c], origin + i * cell, origin + j * cell).side > 0 ? 1 : 0
    } else land[c] = votes[comp[c]] >= 0 ? 1 : 0
  }
  // Nearest-segment propagation (two raster passes, 8 neighbours): near-exact distances.
  const relax = (c, m) => {
    const k = nearest[m]
    if (k < 0) return
    const i = c % n,
      j = (c - i) / n
    const d = probe(k, origin + i * cell, origin + j * cell).d
    if (d < dist[c]) {
      dist[c] = d
      nearest[c] = k
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const c = j * n + i
        if (i > 0) relax(c, c - 1)
        if (j > 0) {
          relax(c, c - n)
          if (i > 0) relax(c, c - n - 1)
          if (i < n - 1) relax(c, c - n + 1)
        }
      }
    for (let j = n - 1; j >= 0; j--)
      for (let i = n - 1; i >= 0; i--) {
        const c = j * n + i
        if (i < n - 1) relax(c, c + 1)
        if (j < n - 1) {
          relax(c, c + n)
          if (i < n - 1) relax(c, c + n + 1)
          if (i > 0) relax(c, c + n - 1)
        }
      }
  }
  const signed = new Float32Array(N)
  for (let c = 0; c < N; c++) {
    const d = Number.isFinite(dist[c]) ? dist[c] : half * 4
    signed[c] = land[c] ? d : -d
  }

  /** Signed distance at an arbitrary point: exact near the coast, grid elsewhere. */
  function signedAt(x, z) {
    const c = cellOf(clamp(x, -half, half), clamp(z, -half, half))
    let best = Infinity,
      side = land[c] ? 1 : -1
    const i0 = c % n,
      j0 = (c - i0) / n
    for (let dj = -2; dj <= 2; dj++)
      for (let di = -2; di <= 2; di++) {
        const i = i0 + di,
          j = j0 + dj
        if (i < 0 || j < 0 || i >= n || j >= n) continue
        const k = nearest[j * n + i]
        if (k < 0) continue
        const p = probe(k, x, z)
        if (p.d < best) {
          best = p.d
          side = p.side
        }
      }
    if (best > cell * 2.5) return signed[c]
    return side * best
  }
  return { land, signed, signedAt, segments: relevant.length }
}

// ---------------------------------------------------------------- features

const LEVEL = 3
function parseLength(value) {
  if (!value) return undefined
  const m = String(value)
    .replace(',', '.')
    .match(/^\s*([\d.]+)\s*(m|ft|')?/)
  if (!m) return undefined
  const v = parseFloat(m[1])
  return m[2] === 'ft' || m[2] === "'" ? v * 0.3048 : v
}

const HOUSE = new Set([
  'house',
  'detached',
  'semidetached_house',
  'terrace',
  'residential',
  'bungalow',
  'cabin',
  'farm',
])
const SHED = new Set(['shed', 'garage', 'garages', 'hut', 'boathouse', 'roof', 'carport', 'kiosk'])
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'manufacture', 'storage_tank', 'hangar'])
const COMMERCIAL = new Set(['commercial', 'retail', 'office', 'supermarket', 'hotel'])
const CIVIC = new Set([
  'school',
  'public',
  'civic',
  'hospital',
  'government',
  'university',
  'college',
])
const CHURCH = new Set(['church', 'chapel', 'cathedral', 'religious'])

function buildingKind(t, area) {
  const b = t.building
  if (CHURCH.has(b) || t.amenity === 'place_of_worship') return 'church'
  if (b === 'apartments' || b === 'dormitory') return 'apartments'
  if (SHED.has(b)) return 'shed'
  if (INDUSTRIAL.has(b) || t.man_made === 'storage_tank') return 'industrial'
  if (COMMERCIAL.has(b) || t.shop || t.tourism === 'hotel') return 'commercial'
  if (CIVIC.has(b) || t.amenity) return 'civic'
  if (HOUSE.has(b)) return 'house'
  if (area < 22) return 'shed'
  if (area > 900) return 'industrial'
  return 'house'
}

const NAMED_COLOURS = {
  white: '#f2f0ea',
  red: '#a3302a',
  blue: '#3a5f8a',
  green: '#4b6e4a',
  yellow: '#d8b04a',
  black: '#26272a',
  grey: '#8a8c8e',
  gray: '#8a8c8e',
  brown: '#6b4a33',
  beige: '#d9cdb0',
  orange: '#c8742e',
}
const colourOf = (v) => {
  if (!v) return undefined
  const s = String(v).trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((c) => c + c).join('')
  return NAMED_COLOURS[s]
}

function roofOf(t, kind, area, rng) {
  const shape = t['roof:shape']
  if (shape) {
    if (/gabled|gambrel|saltbox|round|dome/.test(shape)) return 'gable'
    if (/hip|pyramid|mansard/.test(shape)) return 'hip'
    if (/flat|skillion/.test(shape)) return 'flat'
  }
  if (kind === 'church') return 'gable'
  if (kind === 'shed') return area < 400 ? 'gable' : 'flat'
  if (kind === 'house') return area > 350 ? 'flat' : rng < 0.16 ? 'hip' : 'gable'
  if (kind === 'industrial') return area < 450 ? 'gable' : 'flat'
  if (kind === 'civic' || kind === 'commercial') return area < 300 ? 'gable' : 'flat'
  return 'flat'
}

function heightOf(t, kind, roof, area, rng) {
  const h = parseLength(t.height)
  if (h && h > 2 && h < 150) return h
  const levels = parseFloat(t['building:levels'])
  const pitch = roof === 'flat' ? 0.8 : Math.min(4.5, Math.sqrt(area) * 0.35)
  if (levels > 0 && levels < 40) return levels * LEVEL + pitch
  switch (kind) {
    case 'house':
      return (rng < 0.55 ? 2 : rng < 0.85 ? 1.5 : 1) * LEVEL + 0.6 + pitch
    case 'shed':
      return 2.6 + pitch * 0.8
    case 'apartments':
      return 4 * LEVEL + pitch
    case 'church':
      return 9 + pitch
    case 'industrial':
      return t.man_made === 'storage_tank' ? 12 : 6.5 + pitch
    case 'commercial':
    case 'civic':
      return 2 * LEVEL + 1 + pitch
    default:
      return 2 * LEVEL + pitch
  }
}

function hash01(x, z) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// ---------------------------------------------------------------- scene build

function analyse(id, cfg, osm, center) {
  const half = cfg.sizeM / 2
  const cell = cfg.sizeM / (GRID - 1)
  const { toLocal } = projector(center)
  const P = (pts) => pts.map(([lon, lat]) => toLocal(lon, lat))
  const coastWays = []
  const lakes = [],
    piers = [],
    breakwaters = [],
    buildings = [],
    landmarks = [],
    cover = []
  const inBox = (x, z, m = 0) => Math.abs(x) <= half + m && Math.abs(z) <= half + m
  const ringInBox = (ring, m = 0) => ring.some(([x, z]) => inBox(x, z, m))
  const floatingCentre = cfg.floatingNear && toLocal(cfg.floatingNear.lon, cfg.floatingNear.lat)
  for (const e of osm.elements) {
    const t = e.tags ?? {}
    const shape = shapeOf(e)
    if (t.natural === 'coastline' && shape.line) {
      coastWays.push(P(shape.line))
      continue
    }
    if (t.man_made === 'pier' || t.man_made === 'jetty') {
      let floating = t.floating === 'yes'
      const polys = []
      if (shape.rings && t.area !== 'no' && !t.highway)
        for (const r of shape.rings) polys.push(P(r))
      else if (shape.line) {
        const line = P(shape.line)
        if (
          floatingCentre &&
          !t.bridge &&
          !t.highway &&
          t.floating !== 'no' &&
          line.every(
            ([x, z]) =>
              Math.hypot(x - floatingCentre[0], z - floatingCentre[1]) < cfg.floatingNear.radius,
          )
        )
          floating = true
        const width = parseLength(t.width) ?? (t.highway ? 8 : floating ? 3 : t.bridge ? 4 : 5)
        polys.push(bufferLine(line, width))
      }
      for (const poly of polys)
        if (ringInBox(poly))
          piers.push({
            polygon: ccw(simplify(poly, 0.15, true)),
            floating,
            deckHeight: floating ? 0.5 : cfg.deckHeight,
            name: t.name,
          })
      continue
    }
    if (t.man_made === 'breakwater' || t.man_made === 'groyne') {
      const polys = shape.rings
        ? shape.rings.map(P)
        : shape.line
          ? [bufferLine(P(shape.line), parseLength(t.width) ?? (t.man_made === 'groyne' ? 5 : 9))]
          : []
      for (const poly of polys)
        if (ringInBox(poly))
          breakwaters.push({ polygon: ccw(simplify(poly, 0.3, true)), height: 2.6 })
      continue
    }
    const nameIsTower = /cabot tower/i.test(t.name ?? '')
    if (t.man_made === 'lighthouse' || nameIsTower) {
      let x, z, footprint
      if (shape.point) [x, z] = toLocal(...shape.point)
      else if (shape.rings?.length) {
        footprint = P(shape.rings[0])
        ;[x, z] = centroid(footprint)
      } else if (shape.line) [x, z] = centroid(P(shape.line))
      else continue
      if (!inBox(x, z)) continue
      const height =
        parseLength(t.height) ??
        (nameIsTower ? 16 : Math.max(10, parseLength(t['seamark:landmark:height']) ?? 0))
      landmarks.push({
        kind: nameIsTower ? 'stone-tower' : 'lighthouse',
        x,
        z,
        height: nameIsTower ? Math.max(height, 15) : Math.min(Math.max(height, 9), 30),
        name: t.name ?? (nameIsTower ? 'Cabot Tower' : 'Lighthouse'),
        footprint,
      })
      if (!t.building) continue
      if (nameIsTower) continue
    }
    if (t.building && shape.rings) {
      for (const r of shape.rings) {
        const ring = simplify(P(r), 0.3, true)
        if (ring.length < 3 || !inBox(...centroid(ring))) continue
        const area = Math.abs(signedArea(ring))
        if (area < 8 || area > 60000) continue
        const [cx, cz] = centroid(ring)
        const rng = hash01(cx, cz)
        const kind = buildingKind(t, area)
        const roof = roofOf(t, kind, area, rng)
        buildings.push({
          footprint: ccw(ring),
          height: heightOf(t, kind, roof, area, rng),
          roof,
          kind,
          colour: colourOf(t['building:colour']),
          roofColour: colourOf(t['roof:colour']),
          minHeight: parseLength(t.min_height),
          name: t.name,
          osm: `${e.type}/${e.id}`,
        })
      }
      continue
    }
    if (
      (t.natural === 'water' && t.water !== 'bay' && t.water !== 'harbour') ||
      t.waterway === 'riverbank'
    ) {
      for (const r of shape.rings ?? []) {
        const ring = P(r)
        if (!ringInBox(ring) || Math.abs(signedArea(ring)) < 1500) continue
        lakes.push({ polygon: ring, name: t.name })
      }
      continue
    }
    const coverClass =
      t.landuse === 'forest' || t.natural === 'wood'
        ? 'wood'
        : t.natural === 'scrub' || t.natural === 'heath'
          ? 'scrub'
          : t.natural === 'bare_rock'
            ? 'rock'
            : t.natural === 'beach'
              ? 'beach'
              : t.natural === 'wetland'
                ? 'wetland'
                : t.landuse === 'residential'
                  ? 'residential'
                  : /industrial|commercial|harbour|port/.test(t.landuse ?? '')
                    ? 'industrial'
                    : t.landuse === 'grass' ||
                        t.landuse === 'cemetery' ||
                        t.natural === 'grassland' ||
                        t.leisure === 'park'
                      ? 'grass'
                      : undefined
    if (coverClass && shape.rings)
      for (const r of shape.rings) {
        const ring = P(r)
        if (ringInBox(ring, cell * 4))
          cover.push({ cls: coverClass, ring, area: Math.abs(signedArea(ring)) })
      }
  }
  // The same light is sometimes mapped twice (light and structure): keep one.
  for (let i = landmarks.length - 1; i > 0; i--)
    if (
      landmarks
        .slice(0, i)
        .some(
          (l) =>
            l.kind === landmarks[i].kind &&
            Math.hypot(l.x - landmarks[i].x, l.z - landmarks[i].z) < 30,
        )
    )
      landmarks.splice(i, 1)
  // A building that contains a lighthouse or Cabot Tower is drawn by the landmark instead.
  const kept = buildings.filter(
    (b) =>
      !landmarks.some(
        (l) =>
          (l.kind === 'stone-tower' && pointInRing(l.x, l.z, b.footprint)) ||
          (l.kind === 'lighthouse' &&
            Math.abs(signedArea(b.footprint)) < 90 &&
            pointInRing(l.x, l.z, b.footprint)),
      ),
  )
  const classes = classify(coastWays, GRID, half, cell)
  return {
    half,
    cell,
    coastWays,
    classes,
    lakes,
    piers,
    breakwaters,
    buildings: kept,
    landmarks,
    cover,
    toLocal,
  }
}

/** Water cells reachable without crossing land, piers or breakwaters (path planning). */
function obstacleGrid(a, clearance) {
  const N = GRID * GRID
  const blocked = new Uint8Array(N)
  for (let c = 0; c < N; c++) if (a.classes.signed[c] > -clearance) blocked[c] = 1
  const cellOf = (x, z) => {
    const i = Math.round((x + a.half) / a.cell),
      j = Math.round((z + a.half) / a.cell)
    return i < 0 || j < 0 || i >= GRID || j >= GRID ? -1 : j * GRID + i
  }
  for (const p of [...a.piers, ...a.breakwaters]) {
    fillPolygon(p.polygon, GRID, -a.half, a.cell, (c) => (blocked[c] = 1))
    // Thin structures cover no cell centre: trace their outlines as 4-connected walls.
    const ring = p.polygon
    for (let k = 0; k < ring.length; k++) {
      const [ax, az] = ring[k],
        [bx, bz] = ring[(k + 1) % ring.length]
      const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / (a.cell / 4)) || 1
      let prev = -1
      for (let q = 0; q <= steps; q++) {
        const c = cellOf(ax + ((bx - ax) * q) / steps, az + ((bz - az) * q) / steps)
        if (c < 0) continue
        if (
          prev >= 0 &&
          c % GRID !== prev % GRID &&
          Math.floor(c / GRID) !== Math.floor(prev / GRID)
        )
          blocked[Math.floor(c / GRID) * GRID + (prev % GRID)] = 1
        blocked[c] = 1
        prev = c
      }
    }
  }
  return blocked
}

function findBerth(a, cfg, center) {
  const near = projector(center).toLocal(cfg.berth.near.lon, cfg.berth.near.lat)
  const boatLength = 14,
    halfBeam = 2.6,
    offset = 4
  const obstacles = [...a.piers.map((p) => p.polygon), ...a.breakwaters.map((b) => b.polygon)]
  const hits = (x, z) => obstacles.some((poly) => pointInRing(x, z, poly))
  const candidates = []
  for (const [index, pier] of a.piers.entries()) {
    if (cfg.berth.floating !== undefined && pier.floating !== cfg.berth.floating) continue
    const ring = pier.polygon
    for (let e = 0; e < ring.length; e++) {
      const p = ring[e],
        q = ring[(e + 1) % ring.length]
      const len = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (len < boatLength * 0.8) continue
      const ux = (q[0] - p[0]) / len,
        uz = (q[1] - p[1]) / len
      // Outward normal of a CCW ring in (x, z) with positive shoelace area.
      const nx = uz,
        nz = -ux
      for (let s = boatLength * 0.4; s <= len - boatLength * 0.4; s += 3) {
        const fx = p[0] + ux * s,
          fz = p[1] + uz * s
        const bx = fx + nx * offset,
          bz = fz + nz * offset
        let ok = !pointInRing(fx + nx * 0.5, fz + nz * 0.5, ring)
        // Hull outline samples must be in open water and clear of every structure.
        for (let u = -boatLength / 2; ok && u <= boatLength / 2; u += 1.75)
          for (const v of [-halfBeam, 0, halfBeam]) {
            const x = bx + ux * u + nx * v,
              z = bz + uz * u + nz * v
            if (a.classes.signedAt(x, z) > -0.8 || hits(x, z)) ok = false
          }
        if (!ok) continue
        // Room to manoeuvre off the berth: open water further out along the normal.
        let room = 0
        for (let d = offset + halfBeam; d < 60; d += 2) {
          const x = fx + nx * d,
            z = fz + nz * d
          if (a.classes.signedAt(x, z) > -1 || hits(x, z)) break
          room = d
        }
        if (room < 18) continue
        const distance = Math.hypot(bx - near[0], bz - near[1])
        candidates.push({
          x: bx,
          z: bz,
          ux,
          uz,
          face: [
            [fx - (ux * boatLength) / 2, fz - (uz * boatLength) / 2],
            [fx + (ux * boatLength) / 2, fz + (uz * boatLength) / 2],
          ],
          pier: index,
          score: distance - Math.min(room, 50) * 0.6,
        })
      }
    }
  }
  candidates.sort((p, q) => p.score - q.score)
  return candidates[0]
}

/** Shortest water path (8-connected Dijkstra, favouring mid-channel) between two cells. */
function waterPath(a, from, to) {
  const n = GRID,
    N = n * n
  const blocked = obstacleGrid(a, 4)
  const cellOf = ([x, z]) =>
    clamp(Math.round((z + a.half) / a.cell), 0, n - 1) * n +
    clamp(Math.round((x + a.half) / a.cell), 0, n - 1)
  const start = cellOf(from),
    goal = cellOf(to)
  // Snap endpoints to the nearest open cell.
  const snap = (c) => {
    if (!blocked[c]) return c
    let best = c,
      bestD = Infinity
    const i0 = c % n,
      j0 = (c - i0) / n
    for (let dj = -12; dj <= 12; dj++)
      for (let di = -12; di <= 12; di++) {
        const i = i0 + di,
          j = j0 + dj
        if (i < 0 || j < 0 || i >= n || j >= n || blocked[j * n + i]) continue
        if (di * di + dj * dj < bestD) {
          bestD = di * di + dj * dj
          best = j * n + i
        }
      }
    return best
  }
  const s = snap(start),
    g = snap(goal)
  const cost = new Float64Array(N).fill(Infinity)
  const prev = new Int32Array(N).fill(-1)
  const heap = [[0, s]]
  cost[s] = 0
  const push = (item) => {
    heap.push(item)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p][0] <= heap[i][0]) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = () => {
    const top = heap[0],
      last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1,
          r = l + 1
        let m = i
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  while (heap.length) {
    const [c0, c] = pop()
    if (c === g) break
    if (c0 > cost[c]) continue
    const i = c % n,
      j = (c - i) / n
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue
        const ii = i + di,
          jj = j + dj
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue
        const m = jj * n + ii
        if (blocked[m] && m !== g) continue
        // No corner cutting between two blocked cells.
        if (di && dj && blocked[j * n + ii] && blocked[jj * n + i]) continue
        const depth = -a.classes.signed[m]
        const step = Math.hypot(di, dj) * (1 + 25 / Math.max(depth, 4))
        if (cost[c] + step < cost[m]) {
          cost[m] = cost[c] + step
          prev[m] = c
          push([cost[m], m])
        }
      }
  }
  if (prev[g] < 0 && g !== s) return undefined
  const path = []
  for (let c = g; c >= 0; c = prev[c]) {
    const i = c % n
    path.push([-a.half + i * a.cell, -a.half + ((c - i) / n) * a.cell])
    if (c === s) break
  }
  return path.reverse()
}

function chaikin(points, rounds) {
  let p = points
  for (let r = 0; r < rounds; r++) {
    const q = [p[0]]
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, az] = p[i],
        [bx, bz] = p[i + 1]
      q.push(
        [ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25],
        [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75],
      )
    }
    q.push(p.at(-1))
    p = q
  }
  return p
}

const bearingOf = (dx, dz) => (((Math.atan2(dx, -dz) / RAD) % 360) + 360) % 360

function rasteriseCover(a, heights) {
  const n = COVER,
    cell = (a.half * 2) / (n - 1)
  const out = new Uint8Array(n * n)
  // Large, generic classes first; specific, smaller areas paint over them.
  const order = ['residential', 'industrial', 'grass', 'wood', 'scrub', 'wetland', 'rock', 'beach']
  const sorted = a.cover
    .slice()
    .sort((p, q) => order.indexOf(p.cls) - order.indexOf(q.cls) || q.area - p.area)
  for (const c of sorted) fillPolygon(c.ring, n, -a.half, cell, (i) => (out[i] = LANDCOVER[c.cls]))
  for (const l of a.lakes)
    fillPolygon(l.polygon, n, -a.half, cell, (i) => (out[i] = LANDCOVER.lake))
  // Sea from the corrected terrain (bilinear lookup of the main grid).
  const ratio = (GRID - 1) / (n - 1)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const gi = Math.round(i * ratio),
        gj = Math.round(j * ratio)
      if (!a.classes.land[gj * GRID + gi] && heights[gj * GRID + gi] < 0)
        out[j * n + i] = LANDCOVER.sea
    }
  return out
}

async function build(id) {
  const cfg = SCENES[id]
  console.log(`\n${id}: ${cfg.name}, ${cfg.place} ${cfg.province}`)
  const pad = cfg.type === 'harbour' ? 900 : 1400
  const osm = await loadOsm(id, bboxAround(cfg.center, cfg.sizeM / 2 + pad))
  let center = { ...cfg.center }
  let a = analyse(id, cfg, osm, center)
  // Pass 1: put the hero position at the origin.
  if (cfg.type === 'harbour') {
    const berth = findBerth(a, cfg, center)
    if (!berth) throw new Error(`${id}: no berth found`)
    center = projector(center).toGeo(berth.x, berth.z)
  } else if (cfg.recentre) {
    let best = { s: -Infinity, x: 0, z: 0 }
    const r = cfg.recentre.radius
    const n = GRID
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = -a.half + i * a.cell,
          z = -a.half + j * a.cell
        if (x * x + z * z > r * r) continue
        // Most open water, mildly preferring the configured spot.
        const s = -a.classes.signed[j * n + i] - Math.hypot(x, z) * 0.15
        if (s > best.s) best = { s, x, z }
      }
    center = projector(center).toGeo(best.x, best.z)
  }
  center = { lat: +center.lat.toFixed(6), lon: +center.lon.toFixed(6) }
  a = analyse(id, cfg, osm, center)
  const { half, cell } = a
  const { toGeo, toLocal } = projector(center)
  console.log(
    `  centre ${center.lat}, ${center.lon}; ${a.classes.segments} coast segments, ${a.buildings.length} buildings, ${a.piers.length} piers`,
  )

  // Elevation.
  const corners = [toGeo(-half - cell, -half - cell), toGeo(half + cell, half + cell)]
  const box = { n: corners[0].lat, w: corners[0].lon, s: corners[1].lat, e: corners[1].lon }
  const dem = await loadElevation(id, box, cfg.zoom)
  const N = GRID * GRID
  const raw = new Float32Array(N)
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      const g = toGeo(-half + i * cell, -half + j * cell)
      raw[j * GRID + i] = dem.sample(g.lon, g.lat)
    }
  const demAt = (x, z) => {
    const fi = clamp((x + half) / cell, 0, GRID - 1.001),
      fj = clamp((z + half) / cell, 0, GRID - 1.001)
    const i = Math.floor(fi),
      j = Math.floor(fj),
      u = fi - i,
      v = fj - j
    const c = j * GRID + i
    return (
      (raw[c] * (1 - u) + raw[c + 1] * u) * (1 - v) +
      (raw[c + GRID] * (1 - u) + raw[c + GRID + 1] * u) * v
    )
  }

  // Coastline correction.
  const { signed, land } = a.classes
  const h = new Float32Array(N)
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      const c = j * GRID + i
      const s = signed[c]
      if (land[c]) {
        // The DEM smears cliffs seaward and low: near the shore, borrow height from
        // slightly inland (along the distance gradient) so cliffs stay steep at the OSM line.
        let v = raw[c]
        if (s < cell * 3.5) {
          const gx = (signed[c + (i < GRID - 1 ? 1 : 0)] - signed[c - (i > 0 ? 1 : 0)]) / (2 * cell)
          const gz =
            (signed[c + (j < GRID - 1 ? GRID : 0)] - signed[c - (j > 0 ? GRID : 0)]) / (2 * cell)
          const gl = Math.hypot(gx, gz) || 1
          const reach = cell * 3.5 - s
          const inland = demAt(
            -half + i * cell + (gx / gl) * reach,
            -half + j * cell + (gz / gl) * reach,
          )
          v = Math.max(v, inland * (0.5 + 0.5 * clamp(s / (cell * 3.5), 0, 1)))
        }
        // Low shores rise to typical wharf/road level within a few tens of metres.
        h[c] = Math.max(v, 0.6 + Math.min(s * 0.07, 2.2))
      } else {
        const d = -s
        const depth = Math.min(2 + d * 0.12 + 26 * (1 - Math.exp(-d / 140)), 90)
        h[c] = Math.min(-depth, raw[c] < -depth ? raw[c] : -depth)
      }
    }
  // Feather: water vertices next to land drop so the linear zero crossing between them
  // falls on the OSM coastline (steep cliffs continue underwater).
  const feathered = h.slice()
  for (let j = 1; j < GRID - 1; j++)
    for (let i = 1; i < GRID - 1; i++) {
      const c = j * GRID + i
      if (land[c]) continue
      let sum = 0,
        count = 0
      for (const m of [
        c - 1,
        c + 1,
        c - GRID,
        c + GRID,
        c - GRID - 1,
        c - GRID + 1,
        c + GRID - 1,
        c + GRID + 1,
      ]) {
        if (!land[m]) continue
        const sa = Math.max(signed[m], 0.5),
          sb = Math.max(-signed[c], 0.5)
        sum += (-h[m] * sb) / sa
        count++
      }
      if (count) feathered[c] = clamp(Math.min(h[c], sum / count), -90, -2)
    }
  h.set(feathered)

  // Lakes: flatten to the DEM's low point inside the polygon, just under a flat surface.
  const lakes = []
  for (const lake of a.lakes) {
    const [cx, cz] = centroid(lake.polygon)
    if (a.classes.signedAt(cx, cz) < 0) continue // sea inlets mapped as water
    const cells = []
    fillPolygon(lake.polygon, GRID, -half, cell, (c) => cells.push(c))
    if (cells.length < 4) continue
    const levels = cells.map((c) => raw[c]).sort((p, q) => p - q)
    const level = Math.max(levels[Math.floor(levels.length * 0.1)], 0.6)
    for (const c of cells) if (land[c]) h[c] = Math.min(h[c], level - 1.5)
    lakes.push({
      polygon: roundRing(ccw(simplify(lake.polygon, 1.5, true))),
      level: round1(level),
      name: lake.name,
    })
  }

  const heightAt = (x, z) => {
    const fi = clamp((x + half) / cell, 0, GRID - 1.001),
      fj = clamp((z + half) / cell, 0, GRID - 1.001)
    const i = Math.floor(fi),
      j = Math.floor(fj),
      u = fi - i,
      v = fj - j
    const c = j * GRID + i
    return (
      (h[c] * (1 - u) + h[c + 1] * u) * (1 - v) + (h[c + GRID] * (1 - u) + h[c + GRID + 1] * u) * v
    )
  }

  // Structures on piers stand on the deck; others on the ground.
  const pierAt = (x, z) => a.piers.find((p) => pointInRing(x, z, p.polygon))
  const buildings = []
  for (const b of a.buildings) {
    const [cx, cz] = centroid(b.footprint)
    const pier = pierAt(cx, cz)
    const ground = b.footprint.map(([x, z]) => heightAt(x, z))
    const mean = ground.reduce((s, v) => s + v, 0) / ground.length
    let base = pier ? Math.max(pier.deckHeight, mean) : mean
    if (!pier && heightAt(cx, cz) < 0) base = Math.max(base, 1.2) // built out over the water
    buildings.push({
      footprint: roundRing(b.footprint),
      height: round1(b.height),
      base: round1(Math.max(base, 0.5)),
      roof: b.roof,
      kind: b.kind,
      ...(b.colour ? { colour: b.colour } : {}),
      ...(b.roofColour ? { roofColour: b.roofColour } : {}),
      ...(b.name ? { name: b.name } : {}),
    })
  }
  // Lighthouses often stand on a breakwater or a pier head.
  const structureTop = (x, z) =>
    Math.max(
      pierAt(x, z)?.deckHeight ?? -Infinity,
      ...a.breakwaters.filter((b) => pointInRing(x, z, b.polygon)).map((b) => b.height),
    )
  const landmarks = a.landmarks.map((l) => ({
    kind: l.kind,
    x: round1(l.x),
    z: round1(l.z),
    base: round1(Math.max(heightAt(l.x, l.z), structureTop(l.x, l.z), 0.5)),
    height: round1(l.height),
    name: l.name,
    ...(l.footprint ? { footprint: roundRing(ccw(simplify(l.footprint, 0.3, true))) } : {}),
  }))

  // Boat.
  const boat = { x: 0, z: 0, headingDeg: 0, lengthM: 14 }
  let arrival
  let berthFace
  if (cfg.type === 'harbour') {
    const berth = findBerth(a, cfg, center)
    if (!berth) throw new Error(`${id}: berth lost after recentring`)
    boat.x = round1(berth.x)
    boat.z = round1(berth.z)
    berthFace = berth.face.map(([x, z]) => [round1(x), round1(z)])
    const entrance = toLocal(cfg.entrance.lon, cfg.entrance.lat)
    // Approach parallel to the face, ending alongside the berth.
    const options = [
      [berth.ux, berth.uz],
      [-berth.ux, -berth.uz],
    ]
    let bestPath
    for (const [ux, uz] of options) {
      const nx = berth.x - berth.face[0][0] - ux * 0,
        nz = berth.z - berth.face[0][1]
      // Offset direction away from the face (normal), for the run-in point.
      const side = Math.sign(nx * -uz + nz * ux) || 1
      const runIn = [berth.x - ux * 45 + -uz * side * 6, berth.z - uz * 45 + ux * side * 6]
      const path = waterPath(a, entrance, runIn)
      if (!path) continue
      let length = 0
      for (let k = 1; k < path.length; k++)
        length += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1])
      if (!bestPath || length < bestPath.length) bestPath = { path, length, ux, uz, runIn }
    }
    if (bestPath) {
      const coarse = simplify(bestPath.path, cell * 0.8, false)
      const prep = [berth.x - bestPath.ux * 20, berth.z - bestPath.uz * 20]
      const smooth = chaikin([...coarse.slice(0, -1), bestPath.runIn, prep], 3)
      arrival = [...smooth, [berth.x, berth.z]].map(([x, z]) => [round1(x), round1(z)])
      boat.headingDeg = round1(bearingOf(bestPath.ux, bestPath.uz))
    } else boat.headingDeg = round1(bearingOf(berth.ux, berth.uz))
    boat.faceOffsetM = 4
  } else if (cfg.headingTowards) {
    const [tx, tz] = toLocal(cfg.headingTowards.lon, cfg.headingTowards.lat)
    boat.headingDeg = round1(bearingOf(tx, tz))
  } else if (cfg.headingDeg !== undefined) boat.headingDeg = cfg.headingDeg

  // Most scenic direction: the skyline's elevation angle, smoothed over ±25°, plus
  // (in harbours) how much of the town is in that direction.
  const skyline = new Float32Array(180)
  const town = new Float32Array(180)
  for (let k = 0; k < 180; k++) {
    const b = k * 2 * RAD
    const dx = Math.sin(b),
      dz = -Math.cos(b)
    let best = 0
    for (let d = 120; d < half * 1.4; d += cell * 0.75) {
      const x = boat.x + dx * d,
        z = boat.z + dz * d
      if (Math.abs(x) > half || Math.abs(z) > half) break
      best = Math.max(best, Math.atan2(heightAt(x, z) - 12, d))
    }
    skyline[k] = best
  }
  for (const b of buildings) {
    const [x, z] = centroid(b.footprint)
    const d = Math.hypot(x - boat.x, z - boat.z)
    if (d < 20 || d > 1200) continue
    town[Math.floor(bearingOf(x - boat.x, z - boat.z) / 2) % 180] += 1 / Math.max(d, 80)
  }
  let viewBearingDeg = 0,
    bestScore = -Infinity
  for (let k = 0; k < 180; k++) {
    let s = 0,
      t = 0
    for (let w = -12; w <= 12; w++) {
      s += skyline[(k + w + 180) % 180]
      t += town[(k + w + 180) % 180]
    }
    const score = s / 25 + (cfg.type === 'harbour' ? t * 0.5 : 0)
    if (score > bestScore) {
      bestScore = score
      viewBearingDeg = k * 2
    }
  }
  if (cfg.viewTowards) {
    const [vx, vz] = toLocal(cfg.viewTowards.lon, cfg.viewTowards.lat)
    viewBearingDeg = Math.round(bearingOf(vx - boat.x, vz - boat.z))
  }

  // Outputs.
  const dir = path.join(OUT, id)
  fs.mkdirSync(dir, { recursive: true })
  const terrain = new Int16Array(N)
  let minH = Infinity,
    maxH = -Infinity
  for (let c = 0; c < N; c++) {
    terrain[c] = clamp(Math.round(h[c] * 10), -32768, 32767)
    minH = Math.min(minH, h[c])
    maxH = Math.max(maxH, h[c])
  }
  const terrainBuffer = Buffer.from(terrain.buffer)
  if (os.endianness() !== 'LE') terrainBuffer.swap16()
  fs.writeFileSync(path.join(dir, 'terrain.bin'), terrainBuffer)
  const coverGrid = rasteriseCover(a, h)
  fs.writeFileSync(path.join(dir, 'landcover.bin'), coverGrid)

  const meta = {
    id,
    name: cfg.name,
    place: cfg.place,
    province: cfg.province,
    type: cfg.type,
    center: { lon: center.lon, lat: center.lat },
    sizeM: cfg.sizeM,
    grid: GRID,
    cellM: +cell.toFixed(4),
    terrain: {
      file: 'terrain.bin',
      format: 'int16le',
      unit: 'decimetre',
      layout: 'row-major; row 0 at z = -sizeM/2 (north), column 0 at x = -sizeM/2 (west)',
    },
    landcover: { file: 'landcover.bin', size: COVER, classes: LANDCOVER },
    heightRange: [round1(minH), round1(maxH)],
    forest: cfg.forest,
    boat,
    ...(berthFace ? { berthFace } : {}),
    ...(arrival ? { arrival } : {}),
    viewBearingDeg,
    features: {
      buildings,
      piers: a.piers.map((p) => ({
        polygon: roundRing(p.polygon),
        deckHeight: p.deckHeight,
        floating: p.floating,
        ...(p.name ? { name: p.name } : {}),
      })),
      breakwaters: a.breakwaters.map((b) => ({ polygon: roundRing(b.polygon), height: b.height })),
      landmarks,
      lakes,
    },
    attribution: [
      '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
      'Terrain Tiles (Mapzen/Tilezen joerd, AWS Open Data, https://registry.opendata.aws/terrain-tiles): Canada terrain data contains information licensed under the Open Government Licence – Canada (CDEM, Natural Resources Canada); global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration; GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.',
    ],
    sources: {
      osm: { retrieved: osmRetrieved(id), via: 'Overpass API' },
      terrain: { tiles: `${TILES}/{z}/{x}/{y}.png`, zoom: cfg.zoom, count: dem.count },
    },
  }
  const json = JSON.stringify(meta)
  fs.writeFileSync(path.join(dir, 'scenery.json'), json)
  console.log(
    `  wrote terrain ${terrainBuffer.length} B, landcover ${coverGrid.length} B, json ${json.length} B; heights ${meta.heightRange}; view ${viewBearingDeg}°; boat ${JSON.stringify(boat)}`,
  )
  if (flag('--debug')) writeDebug(id, a, h, meta)
  return { id, dir, meta, dem }
}

function osmRetrieved(id) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(CACHE, id, 'overpass.query.json'), 'utf8')).retrieved ??
      today()
    )
  } catch {
    return today()
  }
}

/** Top-down debug image: hillshade, sea, features, boat and arrival (cache dir only). */
function writeDebug(id, a, h, meta) {
  const n = GRID
  const png = new PNG({ width: n, height: n })
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      const v = h[c]
      const dx = h[Math.min(c + 1, c - i + n - 1)] - h[Math.max(c - 1, c - i)]
      const shade = clamp(0.75 - dx * 0.02, 0.3, 1.2)
      let rgb
      if (v < 0) rgb = [20, 50 + Math.max(0, 60 + v), 110 + Math.max(0, 60 + v)]
      else
        rgb = [Math.min(255, 90 + v * 0.6), Math.min(255, 110 + v * 0.3), 70].map((x) => x * shade)
      png.data.set([...rgb.map((x) => clamp(x, 0, 255)), 255], c * 4)
    }
  const put = (x, z, rgb) => {
    const i = Math.round((x + a.half) / a.cell),
      j = Math.round((z + a.half) / a.cell)
    if (i >= 0 && j >= 0 && i < n && j < n) png.data.set([...rgb, 255], (j * n + i) * 4)
  }
  for (const b of meta.features.buildings)
    for (const [x, z] of b.footprint) put(x, z, [240, 60, 60])
  for (const p of meta.features.piers)
    for (const [x, z] of p.polygon) put(x, z, p.floating ? [255, 255, 0] : [255, 160, 0])
  for (const b of meta.features.breakwaters)
    for (const [x, z] of b.polygon) put(x, z, [200, 200, 200])
  for (const l of meta.features.landmarks)
    for (let k = -3; k <= 3; k++) put(l.x + k * a.cell, l.z, [255, 0, 255])
  for (const p of meta.arrival ?? []) put(p[0], p[1], [0, 255, 255])
  for (let k = -4; k <= 4; k++) {
    put(k * a.cell, 0, [255, 255, 255])
    put(0, k * a.cell, [255, 255, 255])
  }
  const b = meta.viewBearingDeg * RAD
  for (let d = 0; d < 1500; d += a.cell) put(Math.sin(b) * d, -Math.cos(b) * d, [255, 255, 255])
  fs.writeFileSync(path.join(CACHE, id, 'debug.png'), PNG.sync.write(png))
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

const results = []
const failed = []
for (const id of Object.keys(SCENES)) {
  if (only && id !== only) continue
  // Batch runs (--harbours) carry on past a place that cannot be built.
  if (flag('--skip-existing') && fs.existsSync(path.join('public', 'scenery', id, 'scenery.json')))
    continue
  try {
    results.push(await build(id))
  } catch (error) {
    if (!flag('--harbours')) throw error
    failed.push(id)
    console.error(`  ${id} failed: ${error instanceof Error ? error.message : error}`)
  }
}
if (failed.length) console.error(`Failed: ${failed.join(', ')}`)

const entries = []
for (const { id, dir, meta } of results) {
  const rel = (f) => `scenery/${id}/${f}`
  entries.push(
    {
      file: rel('terrain.bin'),
      source: `${TILES}/{z}/{x}/{y}.png (z${meta.sources.terrain.zoom}, ${meta.sources.terrain.count} tiles) + OpenStreetMap natural=coastline`,
      license:
        'Terrain Tiles: Canada terrain data contains information licensed under the Open Government Licence – Canada (CDEM, NRCan); ETOPO1 (NOAA), GMTED2010/SRTM (USGS). Coastline © OpenStreetMap contributors, ODbL 1.0',
      processing: `Terrarium tiles mosaicked and resampled to a ${GRID}x${GRID} grid (${meta.sizeM} m square, centred on ${meta.center.lat}, ${meta.center.lon}); water/land reclassified from OSM coastline (water <= -2 m, land >= +0.6 m, feathered); int16 LE decimetres`,
      sha256: sha256(path.join(dir, 'terrain.bin')),
    },
    {
      file: rel('landcover.bin'),
      source: 'OpenStreetMap via Overpass API (landuse/natural areas) + OSM coastline',
      license: '© OpenStreetMap contributors, ODbL 1.0',
      processing: `Rasterised ${COVER}x${COVER} uint8 land-cover classes`,
      sha256: sha256(path.join(dir, 'landcover.bin')),
    },
    {
      file: rel('scenery.json'),
      source:
        'OpenStreetMap via Overpass API (buildings, piers, breakwaters, lighthouses, landmarks, lakes)',
      license: '© OpenStreetMap contributors, ODbL 1.0',
      processing: `Features converted to local metres (x east, z south) around ${meta.center.lat}, ${meta.center.lon}; retrieved ${meta.sources.osm.retrieved}`,
      sha256: sha256(path.join(dir, 'scenery.json')),
    },
  )
}
let previous = []
try {
  previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).assets ?? []
} catch {
  previous = []
}
const files = new Set(entries.map((e) => e.file))
const assets = [...previous.filter((e) => !files.has(e.file)), ...entries].sort((p, q) =>
  p.file.localeCompare(q.file),
)
fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
fs.writeFileSync(manifestPath, JSON.stringify({ retrieved: today(), assets }, null, 2) + '\n')
console.log(`\nManifest entries: ${manifestPath}`)
