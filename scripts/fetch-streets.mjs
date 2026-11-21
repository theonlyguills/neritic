/**
 * Street-level OpenStreetMap features for the close-up sceneries: roads (with width and
 * class), fuel stations and their canopies, and parking lots. Writes
 * public/scenery/<id>/streets.json in the scenery's local metres (x east, z south of the
 * scene origin; see scenery.json `center`), next to the files from fetch-scenery.mjs.
 *
 *   node scripts/fetch-streets.mjs [id ...]
 *
 * One Overpass request per scene, cached under ~/marine-assets-src/scenery/<id>/.
 * © OpenStreetMap contributors, ODbL 1.0.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const USER_AGENT = 'asset-fetch/1.0'
const CACHE = path.join(os.homedir(), 'marine-assets-src', 'scenery')
const SCENES = ['narrows', 'lunenburg', 'johnstone', 'prince-rupert']
const R = 6378137
const RAD = Math.PI / 180
const round1 = (v) => Math.round(v * 10) / 10

/** Default carriageway widths (m) by OSM highway class; `null` = not drawn. */
const WIDTH = {
  motorway: 11,
  trunk: 10,
  primary: 9,
  secondary: 8,
  tertiary: 7,
  unclassified: 6,
  residential: 6,
  living_street: 5,
  pedestrian: 4,
  service: 3.6,
  motorway_link: 6,
  trunk_link: 6,
  primary_link: 6,
  secondary_link: 6,
  tertiary_link: 6,
  track: 3,
}

function query(b) {
  const box = [b.s, b.w, b.n, b.e].map((v) => +v.toFixed(5)).join(',')
  return `[out:json][timeout:120][bbox:${box}];
(
  way["highway"];
  nwr["amenity"~"^(fuel|parking)$"];
  way["building"="roof"];
);
out body geom qt;`
}

async function overpass(id, bbox) {
  const dir = path.join(CACHE, id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'overpass-streets.json')
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(`  Overpass query for ${id} streets`)
  let wait = 10
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query(bbox))}`,
      signal: AbortSignal.timeout(180_000),
    }).catch((error) => ({ ok: false, status: String(error) }))
    if (res.ok) {
      const text = await res.text()
      fs.writeFileSync(file, text)
      return JSON.parse(text)
    }
    console.log(`  ${res.status}; retrying in ${wait}s`)
    await new Promise((r) => setTimeout(r, wait * 1000))
    wait = Math.min(wait * 1.7, 120)
  }
  throw new Error(`Overpass failed for ${id}`)
}

/** Split a polyline where it leaves the square [-half, half]², keeping inside runs. */
function clip(points, half) {
  const inside = ([x, z]) => Math.abs(x) <= half && Math.abs(z) <= half
  const runs = []
  let run = []
  for (const p of points) {
    if (inside(p)) run.push(p)
    else {
      if (run.length > 1) runs.push(run)
      run = []
    }
  }
  if (run.length > 1) runs.push(run)
  return runs
}

function centroid(ring) {
  let x = 0,
    z = 0
  for (const [px, pz] of ring) {
    x += px
    z += pz
  }
  return [x / ring.length, z / ring.length]
}

async function build(id) {
  const dir = path.join('public', 'scenery', id)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'scenery.json'), 'utf8'))
  const c = meta.center
  const half = meta.sizeM / 2
  const kx = RAD * R * Math.cos(c.lat * RAD)
  const kz = RAD * R
  const local = (lon, lat) => [round1((lon - c.lon) * kx), round1(-(lat - c.lat) * kz)]
  const bbox = {
    s: c.lat - half / kz,
    n: c.lat + half / kz,
    w: c.lon - half / kx,
    e: c.lon + half / kx,
  }
  const data = await overpass(id, bbox)
  const roads = []
  const fuel = []
  const parking = []
  const canopies = []
  for (const e of data.elements) {
    const t = e.tags ?? {}
    const geometry = e.geometry?.map((g) => local(g.lon, g.lat))
    if (e.type === 'way' && t.highway && geometry) {
      const base = WIDTH[t.highway]
      if (!base || t.area === 'yes' || /^(proposed|construction|abandoned)$/.test(t.highway))
        continue
      const tagged = parseFloat(t.width)
      const lanes = parseInt(t.lanes, 10)
      const width = Number.isFinite(tagged)
        ? tagged
        : Number.isFinite(lanes) && lanes > 0
          ? Math.max(base, lanes * 3.2)
          : base
      for (const points of clip(geometry, half))
        roads.push({
          kind: t.highway,
          width: round1(width),
          surface: t.surface ?? (t.highway === 'track' ? 'gravel' : 'asphalt'),
          service: t.service,
          bridge: t.bridge === 'yes' || undefined,
          points,
        })
    } else if (t.amenity === 'fuel') {
      const at = e.type === 'node' ? local(e.lon, e.lat) : geometry ? centroid(geometry) : null
      if (at && Math.abs(at[0]) < half && Math.abs(at[1]) < half)
        fuel.push({ x: at[0], z: at[1], polygon: e.type === 'way' ? geometry : undefined })
    } else if (t.amenity === 'parking' && e.type === 'way' && geometry && geometry.length > 3) {
      if (geometry.every(([x, z]) => Math.abs(x) < half && Math.abs(z) < half))
        parking.push({ polygon: geometry })
    } else if (t.building === 'roof' && geometry) canopies.push({ polygon: geometry })
  }
  const out = {
    source: 'OpenStreetMap via Overpass API (highways, fuel, parking, roof canopies)',
    attribution: '© OpenStreetMap contributors, ODbL 1.0',
    roads,
    fuel,
    parking,
    canopies,
  }
  fs.writeFileSync(path.join(dir, 'streets.json'), JSON.stringify(out))
  console.log(
    `${id}: ${roads.length} road runs, ${fuel.length} fuel, ${parking.length} parking, ${canopies.length} canopies`,
  )
}

for (const id of process.argv.slice(2).length ? process.argv.slice(2) : SCENES) await build(id)
