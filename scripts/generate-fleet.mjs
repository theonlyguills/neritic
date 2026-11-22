/**
 * Builds public/data/harbours.json (real DFO Small Craft Harbours locations) and
 * public/data/fleet.json (an entirely synthetic, illustrative fleet) for the Neritic demo.
 *
 *   node scripts/generate-fleet.mjs            # regenerate from the cached sources in scripts/data
 *   node scripts/generate-fleet.mjs --prepare  # re-download and rebuild scripts/data (network)
 *
 * Deterministic: a seeded PRNG drives every choice, so two runs give byte-identical output.
 * No CFIS system or record is used; vessel names, CFV numbers, licences and positions are
 * invented. Routes are found with A* on a conservative water raster built from Natural Earth
 * land, so every route point and segment is on water.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'scripts/data')
const SEED = 20261124
const GENERATED = '2026-11-21'
const UA = 'asset-fetch/1.0'
const KM_PER_DEG = 111.2
const RAD = Math.PI / 180

/** Raster domains; the land cache is clipped to these boxes. */
const DOMAINS = {
  atlantic: { lon0: -72, lat0: 39, lon1: -40, lat1: 72, res: 0.02, seed: [-50, 42] },
  pacific: { lon0: -140, lat0: 46, lon1: -121, lat1: 57, res: 0.01, seed: [-135, 50] },
}

// ---------------------------------------------------------------------------------------------
// Source preparation (--prepare): Natural Earth land + minor islands, DFO Small Craft Harbours.
// ---------------------------------------------------------------------------------------------

const NE_BASE = 'https://naturalearth.s3.amazonaws.com/10m_physical'
const SCH_BASE =
  'https://egisp.dfo-mpo.gc.ca/arcgis/rest/services/open_data_donnees_ouvertes/small_craft_harbours_en/MapServer'

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
}

/** Sutherland–Hodgman clip of one ring to a lon/lat box. */
function clipRing(ring, [x0, y0, x1, y1]) {
  const edges = [(p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1]
  const cut = [
    (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])],
    (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])],
    (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0],
    (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1],
  ]
  let out = ring
  for (let k = 0; k < 4 && out.length; k++) {
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]
      const prev = input[(i + input.length - 1) % input.length]
      const inCur = edges[k](cur)
      const inPrev = edges[k](prev)
      if (inCur) {
        if (!inPrev) out.push(cut[k](prev, cur))
        out.push(cur)
      } else if (inPrev) out.push(cut[k](prev, cur))
    }
  }
  return out
}

/** Ring → flat integer array (degrees × 1e4), duplicates removed; null if degenerate. */
function packRing(ring) {
  const flat = []
  let px = NaN
  let py = NaN
  for (const [x, y] of ring) {
    const ix = Math.round(x * 1e4)
    const iy = Math.round(y * 1e4)
    if (ix === px && iy === py) continue
    flat.push(ix, iy)
    px = ix
    py = iy
  }
  if (flat.length >= 4 && flat[0] === flat[flat.length - 2] && flat[1] === flat[flat.length - 1])
    flat.length -= 2
  return flat.length >= 6 ? flat : null
}

async function prepare() {
  const { read } = await import('shapefile')
  const tmp = mkdtempSync(join(tmpdir(), 'fleet-src-'))
  try {
    const domains = {}
    for (const [key, d] of Object.entries(DOMAINS))
      domains[key] = { bbox: [d.lon0, d.lat0, d.lon1, d.lat1], polygons: [] }
    for (const name of ['ne_10m_land', 'ne_10m_minor_islands']) {
      const zip = join(tmp, `${name}.zip`)
      writeFileSync(zip, await download(`${NE_BASE}/${name}.zip`))
      execFileSync('unzip', ['-o', '-q', zip, '-d', join(tmp, name)])
      const fc = await read(join(tmp, name, `${name}.shp`))
      for (const f of fc.features) {
        const polys =
          f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
        for (const poly of polys) {
          for (const dom of Object.values(domains)) {
            const [x0, y0, x1, y1] = dom.bbox
            let bx0 = Infinity,
              by0 = Infinity,
              bx1 = -Infinity,
              by1 = -Infinity
            for (const [x, y] of poly[0]) {
              bx0 = Math.min(bx0, x)
              by0 = Math.min(by0, y)
              bx1 = Math.max(bx1, x)
              by1 = Math.max(by1, y)
            }
            if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue
            const rings = []
            for (const [ri, ring] of poly.entries()) {
              const packed = packRing(clipRing(ring, dom.bbox))
              if (packed) rings.push(packed)
              else if (ri === 0) break
            }
            if (rings.length) dom.polygons.push(rings)
          }
        }
      }
    }
    const land = {
      source:
        'Natural Earth 10m land (5.1.1) and 10m minor islands (4.1.0); public domain; clipped to the raster domains',
      scale: 1e4,
      domains,
    }
    writeFileSync(join(DATA, 'land.json'), JSON.stringify(land))
    const harbours = []
    for (const layer of [0, 1]) {
      const url = `${SCH_BASE}/${layer}/query?where=1%3D1&outFields=*&outSR=4326&f=json&resultRecordCount=2000`
      const json = JSON.parse((await download(url)).toString('utf8'))
      for (const { attributes: a } of json.features) {
        if (!['NL', 'NS', 'PE', 'NB', 'QC', 'BC', 'NU'].includes(a.Province)) continue
        harbours.push({
          number: a.Harbour_number,
          name: a.Harbour_Name,
          province: a.Province,
          type: a.Harbour_Type,
          lon: a.Longitude,
          lat: a.Latitude,
        })
      }
    }
    harbours.sort((a, b) => a.number - b.number)
    writeFileSync(
      join(DATA, 'sch-harbours.json'),
      `{"source":"${SCH_BASE}","license":"Open Government Licence – Canada","harbours":[\n${harbours
        .map((h) => JSON.stringify(h))
        .join(',\n')}\n]}\n`,
    )
    console.log(
      `land.json: ${Object.entries(domains)
        .map(([k, d]) => `${k} ${d.polygons.length} polygons`)
        .join(', ')}; sch-harbours.json: ${harbours.length} harbours`,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv.includes('--prepare')) {
  await prepare()
  process.exit(0)
}

// ---------------------------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------------------------

function hashString(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** An independent stream per purpose, so one change does not reshuffle everything. */
const rngFor = (key) => mulberry32(hashString(`${SEED}:${key}`))
const between = (rng, a, b) => a + rng() * (b - a)
const intBetween = (rng, a, b) => a + Math.floor(rng() * (b - a + 1))
const pick = (rng, list) => list[Math.floor(rng() * list.length)]
function pickWeighted(rng, items, weight) {
  const total = items.reduce((s, it) => s + weight(it), 0)
  let r = rng() * total
  for (const it of items) {
    r -= weight(it)
    if (r <= 0) return it
  }
  return items[items.length - 1]
}
const round = (n, dp) => Number(n.toFixed(dp))
const r4 = (n) => round(n, 4)

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

function distanceKm([lon1, lat1], [lon2, lat2]) {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * RAD)
  return Math.hypot(x, lat2 - lat1) * KM_PER_DEG
}
function offset([lon, lat], bearingDeg, km) {
  const b = bearingDeg * RAD
  return [
    lon + (km * Math.sin(b)) / (KM_PER_DEG * Math.cos(lat * RAD)),
    lat + (km * Math.cos(b)) / KM_PER_DEG,
  ]
}
function ringContains(ring, x, y) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
/** Polygon/MultiPolygon features with a bbox, for point-in-polygon labelling. */
function indexFeatures(geojson) {
  return geojson.features.map((f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity
    for (const p of polys)
      for (const [x, y] of p[0]) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    return { label: f.properties.label, polys, bbox: [x0, y0, x1, y1] }
  })
}
function labelAt(index, [x, y]) {
  for (const f of index) {
    const [x0, y0, x1, y1] = f.bbox
    if (x < x0 || x > x1 || y < y0 || y > y1) continue
    for (const p of f.polys) {
      if (!ringContains(p[0], x, y)) continue
      if (p.slice(1).some((hole) => ringContains(hole, x, y))) continue
      return f.label
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Water raster: a cell is water only if no land polygon touches it (conservative), so any
// segment that stays inside water cells is on water.
// ---------------------------------------------------------------------------------------------

/** Calls fn(i, j) for every cell a segment (in grid units) touches; stops if fn returns false. */
function forEachCell(x1, y1, x2, y2, fn) {
  if (x1 > x2) [x1, y1, x2, y2] = [x2, y2, x1, y1]
  const i0 = Math.floor(x1)
  const i1 = Math.floor(x2)
  for (let i = i0; i <= i1; i++) {
    let ya = y1
    let yb = y2
    if (x2 !== x1) {
      const xa = Math.max(x1, i)
      const xb = Math.min(x2, i + 1)
      ya = y1 + ((y2 - y1) * (xa - x1)) / (x2 - x1)
      yb = y1 + ((y2 - y1) * (xb - x1)) / (x2 - x1)
    }
    const j0 = Math.floor(Math.min(ya, yb))
    const j1 = Math.floor(Math.max(ya, yb))
    for (let j = j0; j <= j1; j++) if (fn(i, j) === false) return false
  }
  return true
}

class Grid {
  constructor(name, d, polygons) {
    Object.assign(this, { name, lon0: d.lon0, lat0: d.lat0, res: d.res })
    this.w = Math.round((d.lon1 - d.lon0) / d.res)
    this.h = Math.round((d.lat1 - d.lat0) / d.res)
    const n = this.w * this.h
    this.land = new Uint8Array(n)
    this.ocean = new Uint8Array(n)
    this.dist = new Float32Array(n)
    this.dxKm = Float64Array.from(
      { length: this.h },
      (_, j) => d.res * KM_PER_DEG * Math.cos((this.lat0 + (j + 0.5) * d.res) * RAD),
    )
    this.dyKm = d.res * KM_PER_DEG
    this.rasterize(polygons)
    this.floodOcean(this.cellOf(d.seed))
    this.distanceField()
    this.g = new Float64Array(n)
    this.from = new Int32Array(n)
    this.stamp = new Uint32Array(n)
    this.closed = new Uint32Array(n)
    this.search = 0
  }
  contains([lon, lat]) {
    const x = (lon - this.lon0) / this.res
    const y = (lat - this.lat0) / this.res
    return x >= 1 && y >= 1 && x < this.w - 1 && y < this.h - 1
  }
  cellOf([lon, lat]) {
    const i = Math.floor((lon - this.lon0) / this.res)
    const j = Math.floor((lat - this.lat0) / this.res)
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1
    return j * this.w + i
  }
  center(idx) {
    const i = idx % this.w
    const j = (idx - i) / this.w
    return [r4(this.lon0 + (i + 0.5) * this.res), r4(this.lat0 + (j + 0.5) * this.res)]
  }
  isOcean(p) {
    const idx = this.cellOf(p)
    return idx >= 0 && this.ocean[idx] === 1
  }
  clearance(p) {
    const idx = this.cellOf(p)
    return idx >= 0 && this.ocean[idx] ? this.dist[idx] : 0
  }
  rasterize(polygons) {
    const { w, h, land } = this
    const mark = (i, j) => {
      if (i >= 0 && j >= 0 && i < w && j < h) land[j * w + i] = 1
    }
    for (const rings of polygons) {
      const gr = rings.map((flat) => {
        const pts = []
        for (let k = 0; k < flat.length; k += 2)
          pts.push([
            (flat[k] / 1e4 - this.lon0) / this.res,
            (flat[k + 1] / 1e4 - this.lat0) / this.res,
          ])
        return pts
      })
      let ymin = Infinity
      let ymax = -Infinity
      for (const ring of gr)
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k]
          const b = ring[(k + 1) % ring.length]
          forEachCell(a[0], a[1], b[0], b[1], mark)
          ymin = Math.min(ymin, a[1])
          ymax = Math.max(ymax, a[1])
        }
      // Interior: cells whose centre is inside (even-odd over this polygon's rings).
      const j0 = Math.max(0, Math.floor(ymin))
      const j1 = Math.min(h - 1, Math.ceil(ymax))
      const rows = Array.from({ length: j1 - j0 + 1 }, () => [])
      for (const ring of gr)
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k]
          const b = ring[(k + 1) % ring.length]
          if (a[1] === b[1]) continue
          const lo = Math.min(a[1], b[1])
          const hi = Math.max(a[1], b[1])
          for (
            let j = Math.max(j0, Math.ceil(lo - 0.5));
            j <= Math.min(j1, Math.ceil(hi - 0.5) - 1);
            j++
          ) {
            const yc = j + 0.5
            rows[j - j0].push(a[0] + ((b[0] - a[0]) * (yc - a[1])) / (b[1] - a[1]))
          }
        }
      for (let r = 0; r < rows.length; r++) {
        const xs = rows[r].sort((p, q) => p - q)
        const j = j0 + r
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const ia = Math.max(0, Math.ceil(xs[k] - 0.5))
          const ib = Math.min(w - 1, Math.ceil(xs[k + 1] - 0.5) - 1)
          for (let i = ia; i <= ib; i++) land[j * w + i] = 1
        }
      }
    }
  }
  floodOcean(seed) {
    const { w, h, land, ocean } = this
    if (seed < 0 || land[seed]) throw new Error(`${this.name}: ocean seed is on land`)
    const queue = new Int32Array(w * h)
    let head = 0
    let tail = 0
    queue[tail++] = seed
    ocean[seed] = 1
    while (head < tail) {
      const idx = queue[head++]
      const i = idx % w
      const j = (idx - i) / w
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ni = i + di
        const nj = j + dj
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue
        const n = nj * w + ni
        if (land[n] || ocean[n]) continue
        ocean[n] = 1
        queue[tail++] = n
      }
    }
  }
  /** Approximate distance to the nearest non-ocean cell, km (two-pass chamfer). */
  distanceField() {
    const { w, h, ocean, dist, dxKm, dyKm } = this
    for (let k = 0; k < w * h; k++) dist[k] = ocean[k] ? 1e9 : 0
    const relax = (idx, n, c) => {
      if (dist[n] + c < dist[idx]) dist[idx] = dist[n] + c
    }
    for (let j = 0; j < h; j++) {
      const dx = dxKm[j]
      const dd = Math.hypot(dx, dyKm)
      for (let i = 0; i < w; i++) {
        const idx = j * w + i
        if (!ocean[idx]) continue
        if (i > 0) relax(idx, idx - 1, dx)
        if (j > 0) {
          relax(idx, idx - w, dyKm)
          if (i > 0) relax(idx, idx - w - 1, dd)
          if (i < w - 1) relax(idx, idx - w + 1, dd)
        }
      }
    }
    for (let j = h - 1; j >= 0; j--) {
      const dx = dxKm[j]
      const dd = Math.hypot(dx, dyKm)
      for (let i = w - 1; i >= 0; i--) {
        const idx = j * w + i
        if (!ocean[idx]) continue
        if (i < w - 1) relax(idx, idx + 1, dx)
        if (j < h - 1) {
          relax(idx, idx + w, dyKm)
          if (i < w - 1) relax(idx, idx + w + 1, dd)
          if (i > 0) relax(idx, idx + w - 1, dd)
        }
      }
    }
  }
  /** True if the segment touches only ocean cells with at least minClear km clearance. */
  segmentClear(a, b, minClear = 0) {
    const { w, h, ocean, dist } = this
    return forEachCell(
      (a[0] - this.lon0) / this.res,
      (a[1] - this.lat0) / this.res,
      (b[0] - this.lon0) / this.res,
      (b[1] - this.lat0) / this.res,
      (i, j) => {
        if (i < 0 || j < 0 || i >= w || j >= h) return false
        const idx = j * w + i
        return ocean[idx] === 1 && dist[idx] >= minClear - 1e-6
      },
    )
  }
  /** A* over ocean cells, 8-connected (diagonals only between two ocean orthogonals). */
  astar(startP, goalP) {
    const { w, ocean, dist, g, from, stamp, closed, dxKm, dyKm } = this
    const start = this.cellOf(startP)
    const goal = this.cellOf(goalP)
    if (start < 0 || goal < 0 || !ocean[start] || !ocean[goal]) return null
    const s = ++this.search
    const gi = goal % w
    const gj = (goal - gi) / w
    const hx = dxKm[gj]
    const heap = new MinHeap()
    g[start] = 0
    from[start] = -1
    stamp[start] = s
    heap.push(0, start)
    const penalty = (idx) => 1 + 2 * Math.max(0, 1 - dist[idx] / 3)
    while (heap.size) {
      const idx = heap.pop()
      if (closed[idx] === s) continue
      closed[idx] = s
      if (idx === goal) break
      const i = idx % w
      const j = (idx - i) / w
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue
          const ni = i + di
          const nj = j + dj
          if (ni < 0 || nj < 0 || ni >= w || nj >= this.h) continue
          const n = nj * w + ni
          if (!ocean[n] || closed[n] === s) continue
          if (di && dj && (!ocean[j * w + ni] || !ocean[nj * w + i])) continue
          const dx = di ? dxKm[j] : 0
          const dy = dj ? dyKm : 0
          const cost = Math.hypot(dx, dy) * penalty(n)
          const ng = g[idx] + cost
          if (stamp[n] === s && ng >= g[n]) continue
          stamp[n] = s
          g[n] = ng
          from[n] = idx
          const hh = Math.hypot((gi - ni) * hx, (gj - nj) * dyKm)
          heap.push(ng + 1.15 * hh, n)
        }
    }
    if (closed[goal] !== s) return null
    const cells = []
    for (let c = goal; c !== -1; c = from[c]) cells.push(c)
    return cells.reverse()
  }
  /**
   * Route from a to b: A* cells, then string-pulled so that no shortcut is closer to land
   * than the A* path it replaces (capped at 1.5 km). Returns rounded lon/lat points.
   */
  route(a, b, maxPoints = 25) {
    const cells = this.astar(a, b)
    if (!cells) return null
    const pts = [a, ...cells.slice(1, -1).map((c) => this.center(c)), b]
    const clear = [
      this.dist[cells[0]],
      ...cells.slice(1, -1).map((c) => this.dist[c]),
      this.dist[cells[cells.length - 1]],
    ]
    for (const cap of [1.5, 0.75, 0]) {
      const out = [pts[0]]
      let i = 0
      while (i < pts.length - 1) {
        let best = i + 1
        let minC = Math.min(clear[i], clear[i + 1])
        for (let j = i + 2; j < pts.length; j++) {
          minC = Math.min(minC, clear[j])
          if (this.segmentClear(pts[i], pts[j], Math.min(cap, minC))) best = j
          else if (j - best > 60) break
        }
        out.push(pts[best])
        i = best
      }
      if (out.length <= maxPoints) return out
    }
    return null
  }
}

class MinHeap {
  constructor() {
    this.keys = []
    this.vals = []
  }
  get size() {
    return this.keys.length
  }
  push(key, val) {
    const { keys, vals } = this
    let i = keys.length
    keys.push(key)
    vals.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= key) break
      keys[i] = keys[p]
      vals[i] = vals[p]
      i = p
    }
    keys[i] = key
    vals[i] = val
  }
  pop() {
    const { keys, vals } = this
    const top = vals[0]
    const key = keys.pop()
    const val = vals.pop()
    if (keys.length) {
      let i = 0
      const n = keys.length
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && keys[c + 1] < keys[c]) c++
        if (keys[c] >= key) break
        keys[i] = keys[c]
        vals[i] = vals[c]
        i = c
      }
      keys[i] = key
      vals[i] = val
    }
    return top
  }
}

// ---------------------------------------------------------------------------------------------
// Load sources
// ---------------------------------------------------------------------------------------------

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const landData = readJson(join(DATA, 'land.json'))
const t0 = Date.now()
const grids = {
  atlantic: new Grid('atlantic', DOMAINS.atlantic, landData.domains.atlantic.polygons),
  pacific: new Grid('pacific', DOMAINS.pacific, landData.domains.pacific.polygons),
}
console.log(`rasters ready in ${Date.now() - t0} ms`)

// ---------------------------------------------------------------------------------------------
// Harbours: a curated selection of DFO Small Craft Harbours (exact SCH names), with display
// names. Flags: M = major, f = French-speaking, x = mixed, e = English (Quebec), g = Gulf NS,
// w = wide approach search.
// ---------------------------------------------------------------------------------------------

const HARBOURS = {
  NL: [
    ["St. John's (Prosser Rock)", "St. John's", 'M'],
    ['Petty Harbour'],
    ['Bay Bulls'],
    ['Witless Bay'],
    ['Torbay'],
    ['Pouch Cove'],
    ['Ferryland'],
    ['Fermeuse'],
    ['Renews'],
    ['Trepassey'],
    ['Portugal Cove South'],
    ["St. Bride's"],
    ['Placentia'],
    ["Arnold's Cove"],
    ['Southern Harbour'],
    ['Harbour Grace', 0, 'M'],
    ['Bay de Verde', 0, 'M'],
    ['Old Perlican'],
    ['Carbonear'],
    ['Port de Grave'],
    ["Heart's Content"],
    ['Winterton'],
    ['Catalina', 0, 'M'],
    ['Bonavista', 0, 'M'],
    ['Greenspond'],
    ['Wesleyville'],
    ['Valleyfield'],
    ['Carmanville'],
    ['Fogo'],
    ["Joe Batt's Arm"],
    ['Twillingate', 0, 'M'],
    ['Summerford'],
    ['La Scie'],
    ['Fleur de Lys'],
    ['Englee'],
    ['Conche'],
    ['St. Anthony', 0, 'M'],
    ['Griquet'],
    ["Cook's Harbour"],
    ["Flower's Cove"],
    ['Anchor Point'],
    ['Port au Choix', 0, 'M'],
    ['Port Saunders'],
    ['Rocky Harbour'],
    ['Trout River'],
    ["Cox's Cove"],
    ['Channel-Port aux Basques', 0, 'M'],
    ['Isle aux Morts'],
    ['Rose Blanche'],
    ['Burgeo'],
    ['Ramea'],
    ['Harbour Breton', 0, 'M'],
    ['Hermitage'],
    ['Belleoram'],
    ['Fortune'],
    ['Grand Bank', 0, 'M'],
    ['Lamaline'],
    ['Burin'],
    ['Lawn'],
    ['St. Lawrence'],
    ["L'Anse-au-Loup"],
    ['Forteau'],
    ["Mary's Harbour"],
    ['St. Lewis'],
    ['Cartwright'],
    ['Black Tickle'],
    ['Makkovik'],
    ['Nain'],
  ],
  NS: [
    ["Lunenburg - Fishermen's Wharf", 'Lunenburg', 'M'],
    ['Yarmouth Bar', 'Yarmouth', 'M'],
    ['Wedge Point (Wedgeport)', 'Wedgeport', 'x'],
    ['Meteghan', 0, 'Mx'],
    ['Saulnierville', 0, 'x'],
    ['Little River (Digby County)', 'Little River'],
    ['Westport (Irishtown)', 'Westport'],
    ['Sandford'],
    ['Lower East Pubnico', 0, 'Mx'],
    ['Dennis Point (Lower West Pubnico)', 'Dennis Point', 'x'],
    ["Clark's Harbour", 0, 'M'],
    ['Shag Harbour'],
    ['Lower Woods Harbour'],
    ['Upper Port la Tour', 'Port La Tour'],
    ['Lockeport'],
    ['Gunning Cove'],
    ['Port Medway'],
    ['Kraut Point (Riverport)', 'Riverport'],
    ['Blandford (Shoal Cove)', 'Blandford'],
    ['Sambro', 0, 'M'],
    ['Peggys Cove'],
    ['Terence Bay'],
    ['Eastern Passage'],
    ['Owls Head'],
    ['Sonora'],
    ['Port Bickerton East', 'Port Bickerton'],
    ['Canso'],
    ['Larrys River'],
    ['Petit-de-Grat', 0, 'f'],
    ["Little Harbour (L'Ardoise)", "L'Ardoise", 'x'],
    ['Main-À-Dieu', 'Main-à-Dieu'],
    ['Louisbourg', 0, 'M'],
    ['Port Morien'],
    ['Glace Bay'],
    ['North Sydney-Ballast Grounds', 'North Sydney'],
    ['Neils Harbour'],
    ['Ingonish Ferry (South Ingonish)', 'Ingonish'],
    ['Dingwall'],
    ['Bay St. Lawrence'],
    ['Parkers Cove'],
    ['Delaps Cove'],
    ['Halls Harbour'],
    ['Advocate', 'Advocate Harbour'],
    ['Sandy Cove East', 'Sandy Cove'],
    ['Cheticamp (La Digue)', 'Chéticamp', 'Mfg'],
    ['Grand Etang', 'Grand-Étang', 'fg'],
    ['Margaree Harbour (Belle Côte)', 'Margaree Harbour', 'g'],
    ['Inverness (Mcisaac Pond)', 'Inverness', 'g'],
    ['Mabou Harbour', 0, 'g'],
    ['Little Judique Ponds', 'Judique', 'g'],
    ['Pleasant Bay', 0, 'g'],
    ['Pictou Landing', 0, 'g'],
    ["Caribou Ferry - Fishermen's Facilities", 'Caribou', 'g'],
    ['Toney River', 0, 'g'],
    ['Arisaig', 0, 'g'],
    ["Ballantynes Cove (Mcnair's Cove)", 'Ballantynes Cove', 'g'],
    ['Havre Boucher', 0, 'xg'],
    ['Pugwash', 0, 'g'],
  ],
  NB: [
    ["North Head -Fishermen's Wharf", 'North Head', 'M'],
    ["Seal Cove-Fishermen's Wharves", 'Seal Cove'],
    ['Ingalls Head'],
    ['Wilsons Beach'],
    ['Head Harbour'],
    ['Back Bay'],
    ['Blacks Harbour'],
    ['Beaver Harbour'],
    ['Dipper Harbour'],
    ['Chance Harbour'],
    ['St. Martins'],
    ['Alma'],
    ['Caraquet', 0, 'Mf'],
    ['Shippagan', 0, 'Mf'],
    ['Lamèque', 0, 'f'],
    ['Petit Shippagan', 'Petit-Shippagan', 'f'],
    ['Le Goulet', 0, 'f'],
    ['Miscou', 0, 'f'],
    ['Anse-Bleue', 0, 'f'],
    ['Petit-Rocher', 0, 'f'],
    ['Neguac', 'Néguac', 'x'],
    ['Val-Comeau', 0, 'f'],
    ['Escuminac', 0, 'x'],
    ['Pointe-Sapin', 0, 'f'],
    ['Richibucto', 0, 'x'],
    ['Cap-Lumière (Richibucto Cape)', 'Cap-Lumière', 'f'],
    ['Cap-des-Caissie', 0, 'f'],
    ['Sainte-Marie-Sur-Mer', 'Sainte-Marie-sur-Mer', 'f'],
    ['Stonehaven', 0, 'x'],
    ['Cape Tormentine'],
  ],
  PE: [
    ['Tignish', 0, 'M'],
    ['Alberton (Northport)', 'Alberton'],
    ['Miminegash'],
    ['Skinners Pond'],
    ['Abrams Village', 0, 'x'],
    ['Malpeque Cove (Malpeque)', 'Malpeque'],
    ['North Rustico', 0, 'M'],
    ['Covehead'],
    ['Naufrage'],
    ['North Lake'],
    ["Georgetown - Fishermen's Wharf", 'Georgetown'],
    ['Wood Islands'],
    ['Victoria'],
    ['Beach Point'],
    ['French River'],
  ],
  QC: [
    ['Rivère-au-Renard', 'Rivière-au-Renard', 'M'],
    ['Grande-Rivère - Havre', 'Grande-Rivière', 'M'],
    ["L'Anse-à-Beaufils"],
    ['Ste-Thérèse-de-Gaspé (Petite Rivière Est)', 'Sainte-Thérèse-de-Gaspé'],
    ['Newport (Pointe)', 'Newport', 'x'],
    ['Paspébiac - Quai des Pêcheurs et Débarcadère', 'Paspébiac'],
    ['Carleton-Section des Pêcheurs', 'Carleton-sur-Mer'],
    ['Port-Daniel-Est (À Bona)', 'Port-Daniel', 'x'],
    ['Cloridorme'],
    ['Mont-Louis Ouest', 'Mont-Louis'],
    ['Ste-Anne-des-Monts - Havre Polyvalent', 'Sainte-Anne-des-Monts'],
    ['Cap-Chat - Nouveau Havre', 'Cap-Chat'],
    ['Matane (Nouveau Havre)-Quai des Pêcheurs', 'Matane', 'M'],
    ['Les Mechins -Quai des Pêcheurs', 'Les Méchins'],
    ['Sept-Îles (Parc Bunge)', 'Sept-Îles', 'M'],
    ['Baie Comeau (Havre Polyvalent)', 'Baie-Comeau'],
    ['Les Escoumins (Basques)', 'Les Escoumins'],
    ['Baie-Trinité'],
    ['Rivère au Tonnerre (Rivère)', 'Rivière-au-Tonnerre'],
    ['Havre-St-Pierre', 'Havre-Saint-Pierre'],
    ['Mingan'],
    ['Natashquan'],
    ['Kegaska - Quai Débarcadère', 'Kegaska', 'e'],
    ['Harrington Harbour', 0, 'e'],
    ["Tête-à-La-Baleine (Fishermen'S Wharf)", 'Tête-à-la-Baleine'],
    ['La Tabatiere-Section des Pêche', 'La Tabatière'],
    ['Old Fort Bay-Quai des Pêcheurs', 'Old Fort Bay', 'e'],
    ['Rivère St-Paul (Village)', 'Rivière-Saint-Paul', 'e'],
    ['Middle Bay', 0, 'e'],
    ['Blanc Sablon-Grand Quai des Pêcheurs', 'Blanc-Sablon', 'x'],
    ['Cap-Aux-Meules (Port Polyvalent)', 'Cap-aux-Meules', 'M'],
    ['Grande Entree', 'Grande-Entrée'],
    ["Etang-du-Nord (L'Etang-du-Nord)", "L'Étang-du-Nord"],
    ['Havre-Aubert - Installation de Pêche Côtière', 'Havre-Aubert'],
    ['Grosse-Île (Cap du Dauphin)', 'Grosse-Île', 'e'],
    ["Île D'Entree (L'Île-d'Entree)", "Île d'Entrée", 'e'],
  ],
  BC: [
    ['Prince Rupert (Fairview Bay)', 'Prince Rupert', 'M'],
    ['Port Edward'],
    ["Lax Kw'Alaams", "Lax Kw'alaams"],
    ['Oona River'],
    ['Hartley Bay'],
    ['Masset (Delkatla Slough)', 'Masset'],
    ['Queen Charlotte', 'Daajing Giids'],
    ['Klemtu'],
    ['Bella Bella (Martins Cove)', 'Bella Bella'],
    ['Port Hardy', 0, 'M'],
    ['Port Mcneill', 'Port McNeill'],
    ['Sointula', 0, 'M'],
    ['Alert Bay'],
    ['Kelsey Bay'],
    ['Campbell River', 0, 'M'],
    ['Quathiaski Cove'],
    ['Heriot Bay'],
    ['Lund'],
    ['Powell River South', 'Powell River'],
    ['Secret Cove'],
    ['Madeira Park'],
    ['Gibsons'],
    ['Comox'],
    ['French Creek'],
    ['Fanny Bay'],
    ['Ladysmith'],
    ['Cowichan Bay'],
    ['Ganges (Inner Harbour)', 'Ganges'],
    ['Sooke'],
    ['Steveston (Gulf of Georgia)', 'Steveston', 'M'],
    ['Ladner (Delta)', 'Ladner'],
    ['Vancouver (False Creek)', 'Vancouver'],
    ['Ucluelet West', 'Ucluelet', 'M'],
    ['Tofino (4Th Street) - Floats', 'Tofino'],
    ['Bamfield West', 'Bamfield'],
    ['Winter Harbour - Wharf and Floats', 'Winter Harbour'],
    ['Zeballos'],
    ['Maaqtusiis (Marktosis)', 'Maaqtusiis'],
  ],
  NU: [['Pangnirtung', 0, 'Mw'], ['Clyde River']],
}
/** Not in the SCH layer: Canadian Geographical Names Database (NRCan) positions. */
const CGNDB_HARBOURS = [
  { key: 'JCRUA', name: 'Telegraph Cove', province: 'BC', lon: -126.83, lat: 50.548333 },
  { key: 'OATRP', name: 'Iqaluit', province: 'NU', lon: -68.516667, lat: 63.75 },
  { key: 'OAUGJ', name: 'Qikiqtarjuaq', province: 'NU', lon: -64.028056, lat: 67.554722 },
]

const slug = (text) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

function regionOf(province, lat, flags) {
  if (province === 'NL') return 'NL'
  if (province === 'QC') return 'QC'
  if (province === 'PE') return 'GLF'
  if (province === 'BC') return 'PAC'
  if (province === 'NU') return 'ARC'
  if (province === 'NB') return lat < 45.7 ? 'MAR' : 'GLF'
  return flags.includes('g') ? 'GLF' : 'MAR'
}

/**
 * A point on open water 1–4 km off the harbour: the straight leg from the harbour may cross
 * the coarse coastline only at its start (the harbour basin), never after reaching water.
 */
function findApproach(grid, at, maxKm = 4) {
  let best = null
  for (let km = 1; km <= maxKm + 1e-9; km += 0.25)
    for (let b = 0; b < 360; b += 5) {
      const p = offset(at, b, km).map(r4)
      if (!grid.isOcean(p)) continue
      let landPrefix = 0
      let sawWater = false
      let ok = true
      const steps = Math.ceil(km / 0.05)
      for (let s = 0; s <= steps; s++) {
        const q = [at[0] + ((p[0] - at[0]) * s) / steps, at[1] + ((p[1] - at[1]) * s) / steps]
        if (grid.isOcean(q)) sawWater = true
        else if (sawWater) {
          ok = false
          break
        } else landPrefix = (km * s) / steps
      }
      if (!ok) continue
      const clear = Math.min(grid.clearance(p), 3)
      const score = landPrefix * 3 + Math.abs(km - 2.2) * 0.6 - clear
      if (!best || score < best.score - 1e-9) best = { p, score }
    }
  return best?.p ?? null
}

function buildHarbours() {
  const sch = readJson(join(DATA, 'sch-harbours.json')).harbours
  const list = []
  const add = (name, province, lon, lat, flags) => {
    const region = regionOf(province, lat, flags)
    const coast = region === 'PAC' ? 'pacific' : 'atlantic'
    const at = [r4(lon), r4(lat)]
    // 'w': a fjord the 0.02° raster closes (Pangnirtung); the approach is at the fjord mouth.
    const approach =
      findApproach(grids[coast], at) ??
      findApproach(grids[coast], at, 7) ??
      (flags.includes('w') ? findApproach(grids[coast], at, 14) : null)
    if (!approach) {
      console.warn(`  no approach for ${name}, dropped`)
      return
    }
    let lang = 'en'
    if (flags.includes('f') || (province === 'QC' && !flags.includes('e') && !flags.includes('x')))
      lang = 'fr'
    else if (flags.includes('x')) lang = 'mix'
    list.push({
      id: slug(name),
      name,
      province,
      region,
      coast,
      lon: at[0],
      lat: at[1],
      approach,
      major: flags.includes('M'),
      lang,
    })
  }
  for (const [province, rows] of Object.entries(HARBOURS))
    for (const [schName, display, flags = ''] of rows) {
      const src = sch.find((h) => slug(h.name) === slug(schName) && h.province === province)
      if (!src) throw new Error(`SCH harbour not found: ${schName} (${province})`)
      add(display || schName, province, src.lon, src.lat, flags)
    }
  for (const h of CGNDB_HARBOURS) add(h.name, h.province, h.lon, h.lat, '')
  const ids = new Set()
  for (const h of list) {
    if (ids.has(h.id)) throw new Error(`duplicate harbour id ${h.id}`)
    ids.add(h.id)
  }
  return list
}

const harbours = buildHarbours()
const harbourById = new Map(harbours.map((h) => [h.id, h]))
for (const id of [
  'lunenburg',
  'prince-rupert',
  'st-johns',
  'petty-harbour',
  'steveston',
  'telegraph-cove',
  'alert-bay',
])
  if (!harbourById.has(id)) throw new Error(`required harbour missing: ${id}`)
console.log(
  `${harbours.length} harbours (${harbours.filter((h) => h.major).length} major) in ${Date.now() - t0} ms`,
)

// ---------------------------------------------------------------------------------------------
// Fishing grounds. Offshore grounds are drawn inside named banks / shelf-edge areas; inshore
// grounds lie 3–20 km from the home harbour's approach.
// ---------------------------------------------------------------------------------------------

const nafo = indexFeatures(readJson(join(ROOT, 'public/data/atlantic.geojson')))
const pfma = indexFeatures(readJson(join(ROOT, 'public/data/pacific.geojson')))

/** [lon, lat, radius km]; `open`: may lie outside the PFMA polygons (albacore, far offshore). */
const BANKS = {
  // Newfoundland and Labrador
  grandBank3L: [-50.4, 46.7, 60],
  avalonChannel: [-51.9, 47.1, 30],
  neShelf3L: [-50.0, 48.2, 50],
  funkIslandBank: [-51.8, 49.9, 45],
  funkIslandDeep: [-52.6, 49.5, 25],
  stAnthonyBasin: [-54.4, 51.4, 30],
  belleIsleBank: [-54.6, 52.3, 30],
  hawkeChannel: [-54.2, 53.2, 35],
  cartwrightChannel: [-55.3, 54.0, 30],
  hamiltonBank: [-54.8, 54.4, 40],
  hopedaleChannel: [-58.0, 56.0, 35],
  slope3K: [-51.0, 51.0, 50],
  slope2J: [-52.6, 53.6, 45],
  flemishPass: [-47.2, 47.2, 35],
  flemishCap: [-45.0, 47.0, 50],
  stPierreBank: [-55.4, 46.2, 35],
  greenBank: [-54.8, 45.5, 30],
  burgeoBank: [-57.6, 47.0, 25],
  laurentianSlope: [-57.2, 45.4, 35],
  halibutChannel: [-55.6, 45.1, 25],
  grandBank3O: [-52.0, 45.2, 40],
  grandBank3N: [-50.6, 45.3, 35],
  esquimanChannel: [-59.3, 49.4, 35],
  // Maritimes
  georgesBank: [-66.25, 41.85, 30],
  brownsBank: [-65.9, 42.7, 30],
  germanBank: [-66.2, 43.25, 15],
  laHaveBank: [-64.4, 42.85, 30],
  rosewayBank: [-65.1, 43.05, 20],
  emeraldBank: [-62.9, 43.9, 30],
  westernBank: [-61.6, 43.4, 30],
  sableIslandBank: [-60.6, 43.65, 40],
  banquereau: [-58.8, 44.4, 45],
  misaineBank: [-59.5, 45.0, 25],
  cabotStrait4Vn: [-59.7, 46.4, 25],
  easternShore4W: [-60.6, 44.85, 30],
  scotianSlopeA: [-61.8, 42.7, 45],
  scotianSlopeB: [-63.8, 42.4, 40],
  scotianSlopeC: [-59.0, 43.5, 35],
  swordfishA: [-62.5, 42.0, 50],
  swordfishB: [-60.0, 42.5, 50],
  swordfishC: [-64.8, 41.8, 40],
  georgesBasinEdge: [-65.9, 42.3, 25],
  // Gulf and Quebec
  shediacValley: [-64.0, 47.55, 20],
  bradelleBank: [-63.3, 47.35, 25],
  orphanBank: [-62.9, 48.3, 25],
  magdalenShallows: [-62.7, 46.95, 25],
  septIlesCrab: [-66.2, 49.7, 25],
  lowerNorthShore: [-60.5, 49.9, 25],
  septIlesShrimp: [-66.8, 49.55, 20],
  honguedoStrait: [-64.6, 49.35, 20],
  // Arctic (NAFO 0A/0B)
  davisStrait0B: [-59.8, 64.3, 50],
  cumberlandSlope0B: [-60.0, 65.6, 40],
  baffinBay0A: [-61.5, 68.0, 50],
  baffinBay0AN: [-63.5, 70.2, 40],
  resolutionShrimp0B: [-61.5, 62.5, 40],
  // Pacific
  hecateNorth: [-131.1, 54.0, 30],
  hecateSouth: [-130.7, 53.0, 30],
  queenCharlotteSound: [-129.3, 51.4, 40],
  wcviShelfNorth: [-128.1, 49.7, 25],
  laPerouseBank: [-125.9, 48.55, 20],
  haidaGwaiiSlope: [-133.3, 53.2, 30],
  capeStJames: [-131.2, 51.6, 25],
  triangleIsland: [-129.4, 50.7, 25],
  wcviSlope: [-127.3, 48.9, 30],
  wcviTroll: [-127.2, 49.3, 25],
  wcviHake: [-126.5, 48.8, 30],
  albacoreSouth: [-129.5, 48.4, 60, 'open'],
  albacoreNorth: [-130.3, 49.6, 50, 'open'],
}

/** Canada–US line through the Gulf of Maine (approximate Hague line), lon by lat. */
const HAGUE = [
  [-66.95, 45.1],
  [-67.0, 44.75],
  [-67.27, 44.18],
  [-67.73, 42.88],
  [-67.47, 42.52],
  [-65.68, 40.45],
]
/** Approximate Canada–Greenland boundary, lon by lat (Canadian side is west). */
const GREENLAND = [
  [-57.5, 60],
  [-57.6, 64],
  [-57.5, 66.5],
  [-59.0, 68],
  [-60.6, 70],
  [-62.5, 72],
]
function lonOnLine(line, lat) {
  for (let k = 0; k + 1 < line.length; k++) {
    const [xa, ya] = line[k]
    const [xb, yb] = line[k + 1]
    if ((lat <= ya && lat >= yb) || (lat >= ya && lat <= yb))
      return xa + ((xb - xa) * (lat - ya)) / (yb - ya || 1)
  }
  return null
}
/** Keeps grounds in Canadian-fished waters (not US, St-Pierre-et-Miquelon or Greenland). */
function canadianWaters(coast, [lon, lat], open = false) {
  if (coast === 'pacific') return open ? lat > 48.4 : labelAt(pfma, [lon, lat]) !== null
  if (lon < -65.5 && lat < 45.2 && lat > 40.45) {
    const edge = lonOnLine(HAGUE, lat)
    if (edge !== null && lon < edge + 0.05) return false
  }
  if (distanceKm([lon, lat], [-56.18, 46.78]) < 25 || distanceKm([lon, lat], [-56.35, 47.02]) < 25)
    return false
  if (lat < 46.7 && lat > 43.3 && lon > -56.7 && lon < -55.95) return false
  if (lat > 60) {
    const edge = lonOnLine(GREENLAND, Math.min(lat, 72))
    if (edge !== null && lon > edge - 0.3) return false
  }
  return true
}

const fallbackAreas = new Map()
function areaOf(coast, p) {
  const label = labelAt(coast === 'pacific' ? pfma : nafo, p)
  if (label) return label
  const fallback =
    coast === 'pacific' ? 'Offshore Pacific' : p[1] > 47.8 && p[0] < -64 ? '4T' : 'Atlantic'
  fallbackAreas.set(fallback, (fallbackAreas.get(fallback) ?? 0) + 1)
  return fallback
}
const routeKm = (route) => route.slice(1).reduce((s, p, i) => s + distanceKm(route[i], p), 0)

function offshoreGround(rng, fishery, harbour) {
  const grid = grids[harbour.coast]
  const banks = fishery.banks.map((id) => {
    if (!BANKS[id]) throw new Error(`unknown bank ${id}`)
    const [lon, lat, r, open] = BANKS[id]
    return { id, at: [lon, lat], r, open: open === 'open' }
  })
  const scale = fishery.scale ?? 250
  for (let attempt = 0; attempt < 80; attempt++) {
    const bank = pickWeighted(rng, banks, (b) =>
      Math.exp(-distanceKm(harbour.approach, b.at) / scale),
    )
    const p = offset(bank.at, rng() * 360, bank.r * Math.sqrt(rng())).map(r4)
    if (!grid.contains(p) || !grid.isOcean(p) || grid.clearance(p) <= 26) continue
    if (!canadianWaters(harbour.coast, p, bank.open)) continue
    const route = grid.route(harbour.approach, p)
    if (!route) continue
    return { ground: p, route }
  }
  throw new Error(`no offshore ground for ${fishery.key} from ${harbour.id}`)
}

function inshoreGround(rng, fishery, harbour) {
  const grid = grids[harbour.coast]
  const [k0, k1] = fishery.km ?? [3, 20]
  for (let attempt = 0; attempt < 400; attempt++) {
    const relax = attempt > 200
    const km = between(rng, relax ? Math.min(k0, 3) : k0, k1)
    const p = offset(harbour.approach, rng() * 360, km).map(r4)
    if (!grid.contains(p) || !grid.isOcean(p)) continue
    const clear = grid.clearance(p)
    if (clear < (relax ? 0.4 : 0.8) || clear > 24) continue
    if (!canadianWaters(harbour.coast, p)) continue
    const route = grid.route(harbour.approach, p, attempt < 300 ? 4 : 6)
    if (!route) continue
    if (routeKm(route) > 2.2 * distanceKm(harbour.approach, p) + 4) continue
    return { ground: p, route }
  }
  throw new Error(`no inshore ground for ${fishery.key} from ${harbour.id}`)
}

// ---------------------------------------------------------------------------------------------
// Vessel names, in the styles of the Atlantic English, Acadian/Quebec French, BC and Nunavut
// fleets. Invented; checked for uniqueness only.
// ---------------------------------------------------------------------------------------------

const EN_GIRLS =
  'Kaitlyn Melissa Brittany Ashley Amanda Courtney Jessica Kayla Megan Sarah Emily Hannah Chelsea Samantha Danielle Nicole Jennifer Tara Stacey Krista Tanya Shauna Holly Leah Paige Morgan Brooke Abby Madison Chloe Olivia Ava Emma Hailey Kelsey Jillian Rebecca Erin Shannon Natalie Kristen Lindsay Mandy Tina Carla Darlene Brenda Joanne Wanda Debbie Sandra Gail Marilyn Linda Lorraine Cheryl Rhonda Valerie Heather Charlotte Ella Avery Lily Grace Sophie Jenna Kylie Rachel Alyssa Brianna Taylor Kendra Kimberly Jocelyn Marissa Allison Caitlin Lauren Robyn Bethany Kirsten Mallory Sadie Ruby Isla Harper Nora Evelyn Maggie Hazel Josie Maddie Brooklyn Haley Cassidy Desiree Krystal Tiffany Shelby'.split(
    ' ',
  )
const MIDDLE =
  'Lynn Marie Anne Rose Jean Mae Leigh Dawn Ann Louise Faith Grace Jane Kay Elizabeth Lee'.split(
    ' ',
  )
const SURNAMES =
  'Hickey Power Walsh Kearley Pittman Foley Hynes Dalton Penney Rideout Pardy Oldford Squires Snook Mercer Noseworthy Burry Keeping Nickerson Atkinson Goreham Swim Symonds Crowell Hatfield Newell Ryan Kennedy Tobin Brake Hodder Parsons Butler Dicks Gillis MacKinnon MacLeod Fougere Malone Croucher Stockley Hiscock Abbott Durnford Strickland Sheppard Cluett Fudge Spurrell'.split(
    ' ',
  )
const EN_ADJ =
  'Northern Atlantic Southern Eastern Sea Ocean Bay Island Coastal Golden Silver Morning True Lucky Proud Rising Bold Steady Blue Western Misty Tidal Offshore Harbour Wild Fair Restless Gulf North Star'.split(
    ' ',
  )
const EN_NOUN =
  'Venture Pursuit Harvester Star Spirit Pride Quest Endeavour Provider Dawn Light Breeze Tide Wave Hunter Rover Explorer Voyager Challenger Legacy Promise Dream Hope Mist Gale Swell Ranger Wanderer Defender Enterprise Destiny Horizon Reward Seeker Lass Belle Chance Charger Warrior Trader Sunrise Mariner Navigator Bounty Fortune Prospect Pioneer Endurance'.split(
    ' ',
  )
const EN_SINGLE =
  'Endurance Perseverance Tenacity Determination Persistence Integrity Resolute Intrepid Defiant Gallant Relentless Fortitude Valiant Liberty Serenity Tradition Independence Providence Reliance Diligence Resolve Vigilant Steadfast'.split(
    ' ',
  )
const ATL_PLACES = {
  NL: "Grand Banks|Avalon|Bonavista|Notre Dame|Placentia|Fortune Bay|Baccalieu|Funk Island|Belle Isle|Labrador|Conception Bay|Trinity Bay|White Bay|Cape St. Mary's|Cape Freels|Exploits|Hamilton|Torngat|Gander Bay|Bay of Islands".split(
    '|',
  ),
  MAR: 'Fundy|Cape Sable|Scotian|Sable Island|Georges|Browns|Banquereau|Cape Breton|Bras d’Or|Grand Manan|Digby Neck|Brier Island|Seal Island|Tusket|Baccaro|Chebucto|Canso|Mahone Bay|LaHave|Sambro'.split(
    '|',
  ),
  GLF: 'Northumberland|Cabot|Margaree|Malpeque|Gulf|Island|Hillsborough|Miramichi|Cardigan|Chaleur|Pictou|Merigomish|Acadian|Shediac|Kouchibouguac'.split(
    '|',
  ),
  QC: 'Gaspé|Anticosti|Mingan|Côte-Nord|Magdalen|Chaleur|Percé|Bonaventure|Belle Isle|Natashquan'.split(
    '|',
  ),
  ARC: 'Baffin|Cumberland|Davis Strait|Frobisher|Arctic|Nunavut|Qikiqtaaluk|Cape Dyer|Broughton Island|Baffin Bay'.split(
    '|',
  ),
}
const KIN_N = ['Two', 'Three', 'Four', 'Five']
const KIN = 'Brothers Sisters Sons Daughters Grandsons Granddaughters Girls Boys'.split(' ')

const FR_GIRLS =
  'Marie-Ève|Marie-Pier|Marie-Claude|Marie-Josée|Marie-Soleil|Marie-Hélène|Marie-Lou|Marie-Christine|Anne-Marie|Sophie|Julie|Isabelle|Nathalie|Chantal|Josée|Mélanie|Geneviève|Valérie|Annie|Karine|Véronique|Émilie|Catherine|Audrey|Caroline|Mélissa|Maude|Josianne|Roxanne|Sabrina|Stéphanie|Andréanne|Gabrielle|Léa|Rosalie|Laurie|Camille|Océane|Noémie|Line|Lise|Ginette|Monique|Jocelyne|Francine|Renée|Rachelle|Natacha|Joanie|Mylène|Sylvie|Brigitte|Huguette|Danika|Mireille|Solange|Évangéline|Yvette|Gisèle|Florence|Juliette|Maïka|Kassandra|Vanessa|Rébecca'.split(
    '|',
  )
const FR_BOYS =
  'Jean-Guy|Réjean|Gilles|Rémi|Mathieu|Olivier|Alexis|Gabriel|Samuel|Maxime|Étienne|Hugo|Félix|Jérémie|Luc|Marc-André|Rodrigue|Aurèle|Donat|Gérard|Normand|Raymond|Roméo|Léandre|Fernand|Euclide|Valmont|Zacharie|Benoît|Rosaire'.split(
    '|',
  )
const FR_LE =
  'Gaspésien|Madelinot|Côtier|Hardi|Brave|Vaillant|Nordet|Suroît|Courageux|Persévérant|Matelot|Capitaine|Pêcheur|Fidèle|Téméraire|Fougueux|Goéland|Cormoran|Fou de Bassan|Marsouin|Pionnier|Patriote|Voyageur|Grand Large|Mistral|Corsaire|Défi|Phare|Bon Vent|Grand Bleu|Loup de Mer|Boréal|Rorqual|Crabier|Homardier|Acadien|Aventurier|Intrépide|Espadon|Éclaireur|Audacieux|Insulaire|Héritier|Océan'.split(
    '|',
  )
const FR_LA =
  'Madelinienne|Gaspésienne|Belle Rose|Mouette|Sirène|Vague|Marée|Brise|Perle|Sterne|Boussole|Rafale|Grande Ourse|Fierté|Nordique|Côtière|Belle Acadie|Bourrasque|Vigie|Marjolaine|Acadienne|Hirondelle|Aurore|Écume|Espérance|Océane|Étoile du Nord|Insulaire'.split(
    '|',
  )
const FR_PHRASE =
  "Fleur de Lys|Étoile de la Mer|Vent du Large|Fleur de Mer|Rose des Vents|Perle de l'Est|Marée Haute|Écume de Mer|Bel Horizon|Belle Saison|Bonne Espérance|Soleil Levant|Esprit Libre|Ciel Bleu|Belle Mer|Mer Calme|Petit Navire|Cap Lumière|Cap Noir|Cap d'Espoir|Cap Rouge|Cap Blanc|Cap Bon Ami|Cap Enragé|Cap des Rosiers|Cap aux Os|Cap de la Madeleine|Les Trois Frères|Les Deux Sœurs|Les Jumeaux|Les Quatre Fils|Les Trois Sœurs|Les Cinq Frères|Vent d'Ouest|Bonne Pêche|Nouvelle Aube|Fille du Vent|Grand Banc|Belle Prise".split(
    '|',
  )
const FR_NOUN =
  'Étoile|Brise|Vague|Marée|Aurore|Mouette|Sirène|Perle|Espérance|Fierté|Lumière|Rose'.split('|')
const FR_SUFFIX = {
  GLF: ['du Nord', 'du Large', 'du Golfe', 'de la Baie', 'acadienne', 'de Lamèque', 'de Miscou'],
  MAR: ['du Large', "de l'Est", 'de la Baie', 'acadienne', 'de Clare'],
  NL: ['du Large'],
}
function frSuffixes(region, harbour) {
  if (region !== 'QC') return FR_SUFFIX[region] ?? FR_SUFFIX.GLF
  if (harbour.lon > -62.2 && harbour.lat < 47.8)
    return ['des Îles', 'madelinienne', 'du Large', 'du Golfe']
  if (harbour.lat < 49.3) return ['de Gaspé', 'gaspésienne', 'du Large', 'du Golfe']
  return ['du Nord', 'du Large', 'du Golfe', 'de la Côte-Nord']
}
const FR_HUMAN = (rng) => (rng() < 0.85 ? pick(rng, FR_GIRLS) : `Capitaine ${pick(rng, FR_BOYS)}`)
const BC_PRE_SOUTH =
  'Pacific Western Ocean Northern Island Coastal Sea Silver Blue Golden Misty Orca Raven Eagle Cedar Chinook Coho Sockeye Tidal Johnstone Quadra Malcolm Cormorant Kyuquot Nootka Clayoquot Barkley Georgia Discovery Broughton Fraser Juan'.split(
    ' ',
  )
const BC_PRE_NORTH =
  'Pacific Western Ocean Northern Island Coastal North Coast Silver Misty Orca Raven Eagle Cedar Chinook Coho Sockeye Skeena Nass Hecate Chatham Haida Dixon Porcher Laredo Milbanke Kitkatla Banks Island'.split(
    ' ',
  )
const BC_NOUN =
  'Harvester Spirit Pearl Dawn Venture Provider Pride Star Queen Maid Mist Wind Tide Rover Hunter Ranger Sunrise Light Sound Breeze Legacy Voyager Quest Warrior Rose Dream Challenger Gem Bounty Endeavour Lady Belle Prince Princess Wave Chief Explorer Navigator'.split(
    ' ',
  )
const BC_SINGLE =
  'Sea Otter|Snow Goose|Kingfisher|Sea Wolf|Storm Petrel|Shearwater|Murrelet|Albatross|Kittiwake|Tyee|Salmon Queen|Silver Bay|Ocean Pearl|Sea Lion|Westerly|Northern Lights|Sea Mist|Tidewater'.split(
    '|',
  )
const BC_GIRLS = [...EN_GIRLS.slice(0, 60), 'Ingrid', 'Freya', 'Kirsti', 'Mila', 'Nadia', 'Yuki']
const INUKTITUT = 'Tariuq|Siqiniq|Qilak|Aujaq|Nanuq|Tuktu|Ukiuq|Natsiq|Qilalugaq|Aqsarniit'.split(
  '|',
)

const BANNED = /clearwater|ocean choice|high ?liner|cooke|canfisco|royal greenland|organic ocean/i

function nameCandidate(rng, style, region, harbour) {
  const r = rng()
  if (style === 'fr') {
    if (r < 0.18) return FR_HUMAN(rng)
    if (r < 0.36) {
      const w = pick(rng, FR_LE)
      return /^[AEÉIOU]/.test(w) ? `L'${w}` : `Le ${w}`
    }
    if (r < 0.52) {
      const w = pick(rng, FR_LA)
      return /^[AEÉIOU]/.test(w) ? `L'${w}` : `La ${w}`
    }
    if (r < 0.7) return pick(rng, FR_PHRASE)
    if (r < 0.86) return `${pick(rng, FR_NOUN)} ${pick(rng, frSuffixes(region, harbour))}`
    if (r < 0.92) return `Fierté de ${harbour.name}`.replace(/de ([AEÉIOUÎ])/, "d'$1")
    return `Miss ${pick(rng, FR_GIRLS)}`
  }
  if (style === 'bc') {
    const pre = harbour.lat > 52 ? BC_PRE_NORTH : BC_PRE_SOUTH
    if (r < 0.5) return `${pick(rng, pre)} ${pick(rng, BC_NOUN)}`
    if (r < 0.62) return `Miss ${pick(rng, BC_GIRLS)}`
    if (r < 0.72)
      return `${pick(rng, BC_GIRLS)} ${pick(rng, ['Rose', 'Marie', 'Lynn', 'Dawn', 'Mae'])}`
    if (r < 0.84) return pick(rng, BC_SINGLE)
    if (r < 0.92) return `${harbour.name.replace(/ \(.*\)/, '')} ${pick(rng, BC_NOUN)}`
    return `${pick(rng, KIN_N)} ${pick(rng, KIN)}`
  }
  if (style === 'arc') {
    if (r < 0.35) return pick(rng, INUKTITUT)
    return `${pick(rng, ATL_PLACES.ARC)} ${pick(rng, EN_NOUN)}`
  }
  // Atlantic English
  if (r < 0.13) return `Miss ${pick(rng, EN_GIRLS)}`
  if (r < 0.19) return `Lady ${pick(rng, EN_GIRLS)}`
  if (r < 0.27) return `${pick(rng, EN_GIRLS)} ${pick(rng, MIDDLE)}`
  if (r < 0.3) {
    const first = pick(rng, EN_GIRLS)
    return `${first} & ${pick(
      rng,
      EN_GIRLS.filter((g) => g !== first),
    )}`
  }
  if (r < 0.58) return `${pick(rng, EN_ADJ)} ${pick(rng, EN_NOUN)}`
  if (r < 0.68) return `${pick(rng, ATL_PLACES[region] ?? ATL_PLACES.NL)} ${pick(rng, EN_NOUN)}`
  if (r < 0.75) return `${harbour.name} Pride`
  if (r < 0.81) return pick(rng, EN_SINGLE)
  if (r < 0.87) return `${pick(rng, KIN_N)} ${pick(rng, KIN)}`
  if (r < 0.93)
    return `${pick(rng, SURNAMES)} ${pick(rng, ['Legacy', 'Pride', 'Brothers', 'Venture'])}`
  return `${pick(rng, ['Sea', 'Ocean', 'Bay', 'Island'])} ${pick(rng, EN_NOUN)}`
}

const usedNames = new Set()
const NUMERALS = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']
function vesselName(rng, region, harbour) {
  let style = 'en'
  if (region === 'PAC') style = 'bc'
  else if (region === 'ARC') style = rng() < 0.6 ? 'arc' : 'en'
  else {
    const fr = { fr: 0.85, mix: 0.5, en: 0.02 }[harbour.lang]
    if (rng() < fr) style = 'fr'
  }
  // A numeral marks a successor boat: only on a name already in the registry, and rarely.
  const take = (name) => {
    usedNames.add(name.toLowerCase())
    return name
  }
  let collided = false
  for (let attempt = 0; attempt < 80; attempt++) {
    const name = nameCandidate(rng, style, region, harbour)
    if (BANNED.test(name)) continue
    if (!usedNames.has(name.toLowerCase())) return take(name)
    const first = !collided
    collided = true
    if (first && rng() < 0.08) {
      const next = NUMERALS.map((n) => `${name} ${n}`).find((n) => !usedNames.has(n.toLowerCase()))
      if (next && !next.endsWith(' IV')) return take(next)
    }
  }
  const base = nameCandidate(rng, style, region, harbour)
  for (const numeral of NUMERALS) {
    const name = `${base} ${numeral}`
    if (!usedNames.has(name.toLowerCase())) return take(name)
  }
  throw new Error('could not find a unique vessel name')
}

// ---------------------------------------------------------------------------------------------
// Fisheries: who fishes what, where, from which harbours, with which vessels.
// ---------------------------------------------------------------------------------------------

const REGIONS = ['NL', 'MAR', 'GLF', 'QC', 'PAC', 'ARC']
const inRegion =
  (region, test = () => true) =>
  (h) =>
    h.region === region && test(h)
const ids = (text) => text.split(' ')
const MAGDALENS = ids(
  'cap-aux-meules grande-entree letang-du-nord havre-aubert grosse-ile ile-dentree',
)
const LOWER_NORTH_SHORE = ids(
  'kegaska harrington-harbour tete-a-la-baleine la-tabatiere old-fort-bay riviere-saint-paul middle-bay blanc-sablon',
)
const GASPE = ids(
  'riviere-au-renard grande-riviere lanse-a-beaufils sainte-therese-de-gaspe newport paspebiac carleton-sur-mer port-daniel cloridorme',
)
const AREA_19 = ids('cheticamp grand-etang margaree-harbour inverness pleasant-bay')

/**
 * n: vessels; len: metres; lic: licences held; ports: harbour ids or a filter; banks (offshore)
 * or km (inshore distance from the approach); weight: extra harbour weighting.
 */
// prettier-ignore
const FISHERIES = [
  // --- Newfoundland and Labrador ---
  { key: 'nl-lobster', region: 'NL', species: 'Lobster', gear: 'Trap', zone: 'inshore', n: 330, len: [9, 13.7], lic: [2, 5], km: [3, 10], ports: inRegion('NL', (h) => h.lat < 52.5) },
  { key: 'nl-crab-in', region: 'NL', species: 'Snow crab', gear: 'Trap', zone: 'inshore', n: 150, len: [10, 13.7], lic: [3, 6], km: [6, 20], ports: inRegion('NL', (h) => h.lat < 54) },
  { key: 'nl-crab-off', region: 'NL', species: 'Snow crab', gear: 'Trap', zone: 'offshore', n: 135, len: [14, 19.8], lic: [3, 6], ports: ids('bay-de-verde harbour-grace port-de-grave carbonear old-perlican catalina bonavista valleyfield wesleyville greenspond twillingate fogo joe-batts-arm la-scie st-anthony englee st-johns bay-bulls fermeuse trepassey cartwright marys-harbour harbour-breton fortune grand-bank burin'), banks: ids('grandBank3L avalonChannel neShelf3L funkIslandBank belleIsleBank hawkeChannel hamiltonBank stPierreBank greenBank'), scale: 200 },
  { key: 'nl-cod-gillnet', region: 'NL', species: 'Cod', gear: 'Gillnet', zone: 'inshore', n: 160, len: [9, 13], lic: [2, 4], km: [3, 15], ports: inRegion('NL') },
  { key: 'nl-cod-handline', region: 'NL', species: 'Cod', gear: 'Handline', zone: 'inshore', n: 60, len: [9, 11.5], lic: [1, 3], km: [3, 12], ports: inRegion('NL', (h) => h.lat < 52.5) },
  { key: 'nl-capelin', region: 'NL', species: 'Capelin', gear: 'Purse seine', zone: 'inshore', n: 40, len: [12, 19.8], lic: [2, 4], km: [3, 15], ports: inRegion('NL', (h) => h.lat > 47.3 && h.lat < 50.5 && h.lon > -56.5) },
  { key: 'nl-shrimp-large', region: 'NL', species: 'Northern shrimp', gear: 'Bottom trawl', zone: 'offshore', n: 10, len: [55, 75], lic: [1, 3], ports: ids('st-johns harbour-grace st-anthony'), banks: ids('hopedaleChannel cartwrightChannel hawkeChannel stAnthonyBasin funkIslandDeep flemishCap'), scale: 1000 },
  { key: 'nl-shrimp-mid', region: 'NL', species: 'Northern shrimp', gear: 'Bottom trawl', zone: 'offshore', n: 40, len: [15, 19.8], lic: [2, 4], ports: ids('port-au-choix port-saunders st-anthony la-scie twillingate englee cartwright conche anchor-point'), banks: ids('esquimanChannel stAnthonyBasin hawkeChannel cartwrightChannel funkIslandDeep'), scale: 250 },
  { key: 'nl-turbot-gillnet', region: 'NL', species: 'Greenland halibut', gear: 'Gillnet', zone: 'offshore', n: 45, len: [14, 19.8], lic: [2, 5], ports: ids('twillingate la-scie fogo st-anthony bonavista catalina englee cartwright'), banks: ids('slope3K slope2J funkIslandDeep stAnthonyBasin'), scale: 300 },
  { key: 'nl-turbot-trawl', region: 'NL', species: 'Greenland halibut', gear: 'Bottom trawl', zone: 'offshore', n: 4, len: [45, 65], lic: [1, 3], ports: ids('st-johns harbour-grace'), banks: ids('flemishPass slope3K'), scale: 1000 },
  { key: 'nl-redfish', region: 'NL', species: 'Redfish', gear: 'Bottom trawl', zone: 'offshore', n: 15, len: [28, 50], lic: [1, 3], ports: ids('st-johns harbour-breton burin grand-bank fortune'), banks: ids('laurentianSlope halibutChannel flemishCap'), scale: 400 },
  { key: 'nl-groundfish-trawl', region: 'NL', species: 'Groundfish', gear: 'Bottom trawl', zone: 'offshore', n: 10, len: [30, 55], lic: [1, 3], ports: ids('st-johns harbour-grace burin'), banks: ids('grandBank3O grandBank3N grandBank3L'), scale: 600 },
  // --- Maritimes ---
  { key: 'mar-lobster', region: 'MAR', species: 'Lobster', gear: 'Trap', zone: 'inshore', n: 448, len: [10, 14.6], lic: [2, 5], km: [3, 12], ports: inRegion('MAR'), weight: (h) => (h.lon < -65.3 && h.lat < 44.5 ? 3 : 1) },
  { key: 'mar-scallop-off', region: 'MAR', species: 'Scallop', gear: 'Dredge', zone: 'offshore', n: 18, len: [30, 45], lic: [1, 3], ports: ids('lunenburg riverport saulnierville yarmouth'), banks: ids('georgesBank brownsBank germanBank sableIslandBank banquereau'), scale: 500 },
  { key: 'mar-scallop-in', region: 'MAR', species: 'Scallop', gear: 'Dredge', zone: 'inshore', n: 30, len: [13.5, 19.8], lic: [1, 3], km: [5, 20], ports: ids('little-river sandy-cove westport parkers-cove delaps-cove halls-harbour north-head seal-cove alma dennis-point') },
  { key: 'mar-haddock', region: 'MAR', species: 'Haddock', gear: 'Longline', zone: 'offshore', n: 45, len: [13.5, 19.8], lic: [2, 5], ports: ids('yarmouth wedgeport lower-east-pubnico dennis-point clarks-harbour shag-harbour lower-woods-harbour meteghan lunenburg sambro westport'), banks: ids('brownsBank rosewayBank laHaveBank germanBank emeraldBank'), scale: 200 },
  { key: 'mar-groundfish-trawl', region: 'MAR', species: 'Groundfish', gear: 'Bottom trawl', zone: 'offshore', n: 10, len: [25, 45], lic: [1, 3], ports: ids('lunenburg yarmouth louisbourg eastern-passage'), banks: ids('emeraldBank westernBank banquereau brownsBank sableIslandBank'), scale: 400 },
  { key: 'mar-halibut', region: 'MAR', species: 'Atlantic halibut', gear: 'Longline', zone: 'offshore', n: 25, len: [13.5, 22], lic: [2, 4], ports: ids('sambro eastern-passage canso louisbourg glace-bay petit-de-grat lunenburg clarks-harbour shag-harbour'), banks: ids('scotianSlopeA scotianSlopeB scotianSlopeC sableIslandBank banquereau'), scale: 300 },
  { key: 'mar-swordfish', region: 'MAR', species: 'Swordfish', gear: 'Longline', zone: 'offshore', n: 15, len: [15, 25], lic: [1, 3], ports: ids('sambro lunenburg clarks-harbour lower-woods-harbour wedgeport eastern-passage shag-harbour'), banks: ids('swordfishA swordfishB swordfishC'), scale: 500 },
  { key: 'mar-herring', region: 'MAR', species: 'Herring', gear: 'Purse seine', zone: 'offshore', n: 12, len: [25, 40], lic: [1, 3], ports: ids('blacks-harbour yarmouth saulnierville westport meteghan'), banks: ids('germanBank'), scale: 500 },
  { key: 'mar-crab', region: 'MAR', species: 'Snow crab', gear: 'Trap', zone: 'offshore', n: 40, len: [13.5, 19.8], lic: [2, 5], ports: ids('glace-bay louisbourg main-a-dieu port-morien neils-harbour ingonish dingwall bay-st-lawrence canso petit-de-grat north-sydney larrys-river port-bickerton'), banks: ids('misaineBank cabotStrait4Vn easternShore4W banquereau'), scale: 150 },
  { key: 'mar-lobster-off', region: 'MAR', species: 'Lobster', gear: 'Trap', zone: 'offshore', n: 6, len: [25, 35], lic: [1, 2], ports: ids('yarmouth clarks-harbour'), banks: ids('georgesBasinEdge brownsBank'), scale: 500 },
  // --- Gulf ---
  { key: 'glf-lobster', region: 'GLF', species: 'Lobster', gear: 'Trap', zone: 'inshore', n: 290, len: [9.5, 13.7], lic: [2, 5], km: [3, 10], ports: inRegion('GLF') },
  { key: 'glf-crab', region: 'GLF', species: 'Snow crab', gear: 'Trap', zone: 'offshore', n: 70, len: [13.5, 19.8], lic: [3, 6], ports: ids('caraquet shippagan lameque petit-shippagan le-goulet miscou anse-bleue neguac richibucto cap-lumiere tignish alberton north-lake georgetown'), banks: ids('shediacValley bradelleBank orphanBank magdalenShallows'), scale: 150 },
  { key: 'glf-crab-19', region: 'GLF', species: 'Snow crab', gear: 'Trap', zone: 'inshore', n: 15, len: [12, 15], lic: [2, 4], km: [8, 20], ports: AREA_19 },
  { key: 'glf-herring', region: 'GLF', species: 'Herring', gear: 'Gillnet', zone: 'inshore', n: 45, len: [9, 13.7], lic: [1, 3], km: [4, 15], ports: ids('escuminac pointe-sapin caraquet shippagan lameque anse-bleue petit-rocher pictou-landing caribou toney-river miminegash tignish north-lake naufrage beach-point georgetown') },
  { key: 'glf-mackerel', region: 'GLF', species: 'Mackerel', gear: 'Handline', zone: 'inshore', n: 35, len: [9, 12], lic: [1, 3], km: [3, 12], ports: inRegion('GLF') },
  { key: 'glf-scallop', region: 'GLF', species: 'Scallop', gear: 'Dredge', zone: 'inshore', n: 15, len: [11, 14], lic: [1, 2], km: [5, 15], ports: ids('pictou-landing caribou toney-river ballantynes-cove arisaig cape-tormentine wood-islands victoria beach-point cap-des-caissie') },
  // --- Quebec ---
  { key: 'qc-lobster', region: 'QC', species: 'Lobster', gear: 'Trap', zone: 'inshore', n: 105, len: [9.5, 13], lic: [2, 4], km: [3, 10], ports: [ ...MAGDALENS, ...GASPE, ...LOWER_NORTH_SHORE, 'natashquan', 'havre-saint-pierre', 'mingan', ], weight: (h) => (MAGDALENS.includes(h.id) ? 4 : 1) },
  { key: 'qc-crab', region: 'QC', species: 'Snow crab', gear: 'Trap', zone: 'offshore', n: 55, len: [13.5, 19.8], lic: [2, 5], ports: ids('riviere-au-renard grande-riviere lanse-a-beaufils cap-aux-meules grande-entree sept-iles havre-saint-pierre natashquan baie-trinite'), banks: ids('orphanBank magdalenShallows bradelleBank septIlesCrab lowerNorthShore'), scale: 150 },
  { key: 'qc-shrimp', region: 'QC', species: 'Northern shrimp', gear: 'Bottom trawl', zone: 'offshore', n: 30, len: [19, 30], lic: [1, 3], ports: ids('matane riviere-au-renard sept-iles cap-chat sainte-anne-des-monts les-mechins grande-riviere'), banks: ids('septIlesShrimp honguedoStrait esquimanChannel'), scale: 250 },
  { key: 'qc-turbot', region: 'QC', species: 'Greenland halibut', gear: 'Gillnet', zone: 'inshore', n: 25, len: [11, 17], lic: [2, 4], km: [10, 20], ports: ids('cap-chat sainte-anne-des-monts mont-louis les-mechins matane cloridorme riviere-au-renard baie-comeau sept-iles') },
  { key: 'qc-cod', region: 'QC', species: 'Cod', gear: 'Gillnet', zone: 'inshore', n: 15, len: [9, 12], lic: [1, 3], km: [3, 12], ports: LOWER_NORTH_SHORE },
  // --- Pacific ---
  { key: 'pac-salmon-seine', region: 'PAC', species: 'Salmon', gear: 'Purse seine', zone: 'inshore', n: 54, len: [15, 22], lic: [1, 3], km: [3, 20], ports: ids('alert-bay sointula port-mcneill port-hardy campbell-river steveston prince-rupert port-edward bella-bella') },
  { key: 'pac-salmon-gillnet', region: 'PAC', species: 'Salmon', gear: 'Gillnet', zone: 'inshore', n: 75, len: [9, 12.5], lic: [1, 3], km: [3, 18], ports: ids('steveston ladner port-edward prince-rupert lax-kwalaams alert-bay sointula hartley-bay'), weight: (h) => ({ steveston: 3, ladner: 2, 'port-edward': 2 })[h.id] ?? 1 },
  { key: 'pac-salmon-troll', region: 'PAC', species: 'Salmon', gear: 'Troll', zone: 'offshore', n: 35, len: [11, 17.5], lic: [1, 3], ports: ids('ucluelet tofino winter-harbour port-hardy masset prince-rupert zeballos bamfield'), banks: ids('wcviTroll laPerouseBank hecateNorth queenCharlotteSound triangleIsland'), scale: 150 },
  { key: 'pac-prawn', region: 'PAC', species: 'Spot prawn', gear: 'Trap', zone: 'inshore', n: 68, len: [9, 15], lic: [1, 3], km: [3, 15], ports: ids('madeira-park secret-cove gibsons powell-river lund campbell-river quathiaski-cove heriot-bay port-mcneill sointula ucluelet tofino cowichan-bay ladysmith sooke prince-rupert bella-bella ganges comox') },
  { key: 'pac-dungeness', region: 'PAC', species: 'Dungeness crab', gear: 'Trap', zone: 'inshore', n: 35, len: [9, 14], lic: [1, 3], km: [3, 12], ports: ids('steveston ladner masset daajing-giids prince-rupert port-edward tofino vancouver comox') },
  { key: 'pac-roe-herring', region: 'PAC', species: 'Herring', gear: 'Purse seine', zone: 'inshore', n: 20, len: [15, 22], lic: [1, 2], km: [3, 15], ports: ids('french-creek comox fanny-bay prince-rupert daajing-giids ladysmith') },
  { key: 'pac-halibut', region: 'PAC', species: 'Pacific halibut', gear: 'Longline', zone: 'offshore', n: 45, len: [13.5, 20], lic: [2, 4], ports: ids('prince-rupert masset port-hardy ucluelet port-edward daajing-giids winter-harbour'), banks: ids('hecateNorth hecateSouth queenCharlotteSound haidaGwaiiSlope capeStJames triangleIsland wcviShelfNorth laPerouseBank'), scale: 150 },
  { key: 'pac-sablefish', region: 'PAC', species: 'Sablefish', gear: 'Trap', zone: 'offshore', n: 14, len: [18, 35], lic: [1, 3], ports: ids('prince-rupert port-hardy ucluelet steveston'), banks: ids('haidaGwaiiSlope capeStJames triangleIsland wcviSlope'), scale: 250 },
  { key: 'pac-trawl', region: 'PAC', species: 'Groundfish', gear: 'Bottom trawl', zone: 'offshore', n: 35, len: [20, 45], lic: [1, 3], ports: ids('prince-rupert port-hardy ucluelet steveston vancouver port-edward'), banks: ids('hecateNorth hecateSouth queenCharlotteSound wcviShelfNorth laPerouseBank triangleIsland'), scale: 150 },
  { key: 'pac-hake', region: 'PAC', species: 'Groundfish', gear: 'Midwater trawl', zone: 'offshore', n: 10, len: [35, 75], lic: [1, 2], ports: ids('ucluelet steveston vancouver'), banks: ids('wcviHake laPerouseBank'), scale: 600 },
  { key: 'pac-albacore', region: 'PAC', species: 'Albacore tuna', gear: 'Troll', zone: 'offshore', n: 25, len: [14, 20], lic: [1, 2], ports: ids('ucluelet tofino steveston port-hardy bamfield'), banks: ids('albacoreSouth albacoreNorth'), scale: 800 },
  // --- Arctic ---
  { key: 'arc-turbot-gillnet', region: 'ARC', species: 'Greenland halibut', gear: 'Gillnet', zone: 'offshore', n: 7, len: [40, 62], lic: [1, 3], ports: ids('iqaluit pangnirtung qikiqtarjuaq clyde-river'), banks: ids('davisStrait0B cumberlandSlope0B baffinBay0A baffinBay0AN'), scale: 400 },
  { key: 'arc-turbot-trawl', region: 'ARC', species: 'Greenland halibut', gear: 'Bottom trawl', zone: 'offshore', n: 6, len: [55, 75], lic: [1, 3], ports: ids('iqaluit pangnirtung qikiqtarjuaq'), banks: ids('davisStrait0B cumberlandSlope0B baffinBay0A'), scale: 400 },
  { key: 'arc-shrimp', region: 'ARC', species: 'Northern shrimp', gear: 'Bottom trawl', zone: 'offshore', n: 7, len: [60, 75], lic: [1, 3], ports: ids('iqaluit pangnirtung qikiqtarjuaq'), banks: ids('resolutionShrimp0B davisStrait0B baffinBay0A'), scale: 500 },
  { key: 'arc-turbot-inshore', region: 'ARC', species: 'Greenland halibut', gear: 'Longline', zone: 'inshore', n: 10, len: [9, 12], lic: [1, 2], km: [8, 20], ports: ids('pangnirtung qikiqtarjuaq iqaluit'), weight: (h) => (h.id === 'pangnirtung' ? 4 : 1) },
]

/** Hero vessels used by the close-up scenes: fixed identities and grounds. */
// prettier-ignore
const HEROES = [
  { id: 'nl-01', name: 'Northern Light', cfv: '104729', region: 'NL', species: 'Groundfish', gear: 'Bottom trawl', zone: 'offshore', lengthM: 47.5, licences: 3, homePort: 'st-johns', ground: [-50.0, 46.08], area: '3L' },
  { id: 'nl-02', name: 'Signal Hill', cfv: '131842', region: 'NL', species: 'Cod', gear: 'Gillnet', zone: 'inshore', lengthM: 13.1, licences: 4, homePort: 'st-johns', ground: [-52.625, 47.567] },
  { id: 'ns-01', name: 'Lunenburg Star', cfv: '117356', region: 'MAR', species: 'Haddock', gear: 'Longline', zone: 'inshore', lengthM: 19.8, licences: 3, homePort: 'lunenburg', km: [6, 12] },
  { id: 'bc-01', name: 'Haida Dawn', cfv: '152604', region: 'PAC', species: 'Salmon', gear: 'Purse seine', zone: 'inshore', lengthM: 18.2, licences: 2, homePort: 'alert-bay', ground: [-126.68, 50.535] },
  { id: 'bc-02', name: 'Skeena Spirit', cfv: '158931', region: 'PAC', species: 'Salmon', gear: 'Gillnet', zone: 'inshore', lengthM: 14.9, licences: 2, homePort: 'prince-rupert', ground: [-130.3, 54.15] },
]

// ---------------------------------------------------------------------------------------------
// Assemble the fleet
// ---------------------------------------------------------------------------------------------

const harbourWeight = new Map(harbours.map((h) => [h.id, 0.5 + rngFor(`hw:${h.id}`)()]))
const usedCfv = new Set(HEROES.map((h) => h.cfv))
for (const h of HEROES) usedNames.add(h.name.toLowerCase())

function cycleFor(rng, zone, km) {
  if (zone === 'inshore') return Math.round(between(rng, 600, 1200))
  return Math.min(4000, Math.round(1800 + 1400 * Math.min(1, km / 700) + between(rng, 0, 800)))
}

function vesselRecord(base, harbour, ground, route, rng) {
  if (route[0][0] !== harbour.approach[0] || route[0][1] !== harbour.approach[1])
    throw new Error(`${base.id}: route does not start at the approach`)
  const grid = grids[harbour.coast]
  for (let i = 1; i < route.length; i++)
    if (!grid.segmentClear(route[i - 1], route[i]))
      throw new Error(`${base.id}: route segment ${i} crosses land`)
  return {
    id: base.id,
    cfv: base.cfv,
    name: base.name,
    lengthM: base.lengthM,
    gear: base.gear,
    species: base.species,
    region: base.region,
    coast: harbour.coast,
    homePort: harbour.id,
    licences: base.licences,
    zone: base.zone,
    ground: { lon: ground[0], lat: ground[1], area: base.area ?? areaOf(harbour.coast, ground) },
    route,
    phase: Math.floor(rng() * 1000) / 1000,
    cycle: cycleFor(rng, base.zone, routeKm(route)),
  }
}

const vessels = []
for (const hero of HEROES) {
  const rng = rngFor(`hero:${hero.id}`)
  const harbour = harbourById.get(hero.homePort)
  const grid = grids[harbour.coast]
  let ground = hero.ground
  let route
  if (ground) {
    if (!grid.isOcean(ground)) throw new Error(`${hero.id}: ground is not on water`)
    route = grid.route(harbour.approach, ground)
  } else ({ ground, route } = inshoreGround(rng, hero, harbour))
  if (!route) throw new Error(`${hero.id}: no route`)
  const v = vesselRecord(hero, harbour, ground, route, rng)
  if (hero.area && areaOf(harbour.coast, ground) !== hero.area)
    throw new Error(`${hero.id}: ground is not in ${hero.area}`)
  vessels.push(v)
}

const counters = Object.fromEntries(REGIONS.map((r) => [r, 0]))
const t1 = Date.now()
for (const fishery of FISHERIES) {
  const rng = rngFor(`fishery:${fishery.key}`)
  const ports = harbours.filter((h) =>
    typeof fishery.ports === 'function' ? fishery.ports(h) : fishery.ports.includes(h.id),
  )
  if (Array.isArray(fishery.ports))
    for (const id of fishery.ports)
      if (!harbourById.has(id)) throw new Error(`${fishery.key}: unknown harbour ${id}`)
  if (!ports.length) throw new Error(`${fishery.key}: no ports`)
  for (let k = 0; k < fishery.n; k++) {
    const harbour = pickWeighted(
      rng,
      ports,
      (h) => (h.major ? 3 : 1) * harbourWeight.get(h.id) * (fishery.weight?.(h) ?? 1),
    )
    const { ground, route } =
      fishery.zone === 'offshore'
        ? offshoreGround(rng, fishery, harbour)
        : inshoreGround(rng, fishery, harbour)
    let cfv
    do cfv = String(intBetween(rng, 100000, 199999))
    while (usedCfv.has(cfv))
    usedCfv.add(cfv)
    const id = `${fishery.region.toLowerCase()}-${String(++counters[fishery.region]).padStart(4, '0')}`
    const base = {
      id,
      cfv,
      name: vesselName(rng, fishery.region, harbour),
      lengthM: round(between(rng, fishery.len[0], fishery.len[1]), 1),
      gear: fishery.gear,
      species: fishery.species,
      region: fishery.region,
      licences: intBetween(rng, fishery.lic[0], fishery.lic[1]),
      zone: fishery.zone,
    }
    vessels.push(vesselRecord(base, harbour, ground, route, rng))
  }
}
console.log(`${vessels.length} vessels routed in ${Date.now() - t1} ms`)
if (fallbackAreas.size) console.log('fallback areas:', Object.fromEntries(fallbackAreas))

// ---------------------------------------------------------------------------------------------
// Licences: active vessels' holdings scaled up for holders without an active vessel this
// season, plus species with no vessel in this snapshot (bait, whelk, sea cucumber, eel…).
// ---------------------------------------------------------------------------------------------

const INACTIVE_FACTOR = { NL: 1.75, MAR: 1.6, GLF: 1.7, QC: 1.6, PAC: 2.6, ARC: 1.3 }
const OTHER_SHARE = { NL: 0.12, MAR: 0.15, GLF: 0.1, QC: 0.12, PAC: 0.14, ARC: 0.1 }
const OTHER = 'Other species'
function licenceTotals() {
  const cells = new Map()
  for (const v of vessels) {
    const key = `${v.region}|${v.species}`
    cells.set(key, (cells.get(key) ?? 0) + v.licences)
  }
  const byRegion = Object.fromEntries(REGIONS.map((r) => [r, 0]))
  const bySpecies = {}
  for (const [key, held] of [...cells].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [region, species] = key.split('|')
    const n = Math.ceil(held * INACTIVE_FACTOR[region])
    byRegion[region] += n
    bySpecies[species] = (bySpecies[species] ?? 0) + n
  }
  for (const region of REGIONS) {
    const n = Math.round(byRegion[region] * OTHER_SHARE[region])
    byRegion[region] += n
    bySpecies[OTHER] = (bySpecies[OTHER] ?? 0) + n
  }
  const sorted = Object.fromEntries(Object.entries(bySpecies).sort((a, b) => b[1] - a[1]))
  const total = REGIONS.reduce((s, r) => s + byRegion[r], 0)
  return { total, byRegion, bySpecies: sorted }
}

// ---------------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------------

const lines = (items) => items.map((it) => JSON.stringify(it)).join(',\n')
const regionRank = (r) => REGIONS.indexOf(r)
const harbourOut = [...harbours]
  .sort((a, b) => regionRank(a.region) - regionRank(b.region))
  .map(({ id, name, province, region, coast, lon, lat, approach, major }) => ({
    id,
    name,
    province,
    region,
    coast,
    lon,
    lat,
    approach,
    major,
  }))
const harbourFile = {
  source:
    'Fisheries and Oceans Canada, Small Craft Harbours open data (core and non-core fishing harbours); Telegraph Cove, Iqaluit and Qikiqtarjuaq from the Canadian Geographical Names Database (NRCan). Approach points derived from Natural Earth 10m land.',
  license: 'Open Government Licence – Canada',
}
writeFileSync(
  join(ROOT, 'public/data/harbours.json'),
  `{"source":${JSON.stringify(harbourFile.source)},"license":${JSON.stringify(harbourFile.license)},"harbours":[\n${lines(harbourOut)}\n]}\n`,
)
const licences = licenceTotals()
const header = {
  generated: GENERATED,
  seed: SEED,
  note: 'Synthetic and illustrative: vessel names, CFV numbers, licences, grounds, routes and activity are invented for a demonstration and are not CFIS or DFO records. Harbour locations are real.',
  licences,
}
const headerJson = JSON.stringify(header)
writeFileSync(
  join(ROOT, 'public/data/fleet.json'),
  `${headerJson.slice(0, -1)},"vessels":[\n${lines(vessels)}\n]}\n`,
)

const tally = (key) => {
  const out = {}
  for (const v of vessels) out[key(v)] = (out[key(v)] ?? 0) + 1
  return out
}
console.log(
  'by region/zone:',
  tally((v) => `${v.region}/${v.zone}`),
)
console.log(
  'by species:',
  tally((v) => v.species),
)
console.log('licences:', licences.total, licences.byRegion)
