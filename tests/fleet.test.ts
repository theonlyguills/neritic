import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { DfoRegion, FleetFile, Gear, HarbourFile, LonLat } from '../app/domain/fleet'

const fleet: FleetFile = JSON.parse(readFileSync('public/data/fleet.json', 'utf8'))
const harbourFile: HarbourFile = JSON.parse(readFileSync('public/data/harbours.json', 'utf8'))
const harbours = new Map(harbourFile.harbours.map((h) => [h.id, h]))
const REGIONS: DfoRegion[] = ['NL', 'MAR', 'GLF', 'QC', 'PAC', 'ARC']
const GEARS: Gear[] = [
  'Bottom trawl',
  'Midwater trawl',
  'Longline',
  'Gillnet',
  'Trap',
  'Purse seine',
  'Dredge',
  'Handline',
  'Troll',
]

/**
 * Land test against the cached Natural Earth polygons (independent of the generator's raster):
 * even-odd ray casting per polygon, with edges bucketed by latitude band.
 */
interface Domain {
  bbox: [number, number, number, number]
  polygons: number[][][]
}
const land: { scale: number; domains: Record<string, Domain> } = JSON.parse(
  readFileSync('scripts/data/land.json', 'utf8'),
)
const BAND = 0.05
const indexes = Object.values(land.domains).map((d) => {
  const [, y0, , y1] = d.bbox
  const bands: number[][] = Array.from({ length: Math.ceil((y1 - y0) / BAND) + 1 }, () => [])
  d.polygons.forEach((rings, poly) => {
    for (const flat of rings)
      for (let k = 0; k < flat.length; k += 2) {
        const m = (k + 2) % flat.length
        const ax = flat[k]! / land.scale
        const ay = flat[k + 1]! / land.scale
        const bx = flat[m]! / land.scale
        const by = flat[m + 1]! / land.scale
        if (ay === by) continue
        const b0 = Math.max(0, Math.floor((Math.min(ay, by) - y0) / BAND))
        const b1 = Math.min(bands.length - 1, Math.floor((Math.max(ay, by) - y0) / BAND))
        for (let b = b0; b <= b1; b++) bands[b]!.push(ax, ay, bx, by, poly)
      }
  })
  return { bbox: d.bbox, bands }
})
function isLand([x, y]: LonLat): boolean {
  const index = indexes.find(({ bbox: [x0, y0, x1, y1] }) => x > x0 && x < x1 && y > y0 && y < y1)
  assert.ok(index, `point ${x},${y} is outside the land-mask domains`)
  const edges = index.bands[Math.floor((y - index.bbox[1]) / BAND)]!
  const parity = new Map<number, boolean>()
  for (let k = 0; k < edges.length; k += 5) {
    const [ax, ay, bx, by, poly] = edges.slice(k, k + 5) as [number, number, number, number, number]
    if (ay > y === by > y) continue
    if (x < ((bx - ax) * (y - ay)) / (by - ay) + ax) parity.set(poly, !parity.get(poly))
  }
  for (const inside of parity.values()) if (inside) return true
  return false
}
function km([lon1, lat1]: LonLat, [lon2, lat2]: LonLat) {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180))
  return Math.hypot(x, lat2 - lat1) * 111.2
}
const decimals = (n: number) => (String(n).split('.')[1] ?? '').length

test('fleet and harbour files follow the FleetFile / HarbourFile schema', () => {
  assert.match(fleet.generated, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(typeof fleet.seed, 'number')
  assert.match(fleet.note, /synthetic/i)
  assert.match(fleet.note, /illustrative/i)
  assert.ok(harbourFile.source && harbourFile.license)
  for (const h of harbourFile.harbours) {
    assert.deepEqual(Object.keys(h), [
      'id',
      'name',
      'province',
      'region',
      'coast',
      'lon',
      'lat',
      'approach',
      'major',
    ])
    assert.ok(REGIONS.includes(h.region))
    assert.equal(h.coast, h.region === 'PAC' ? 'pacific' : 'atlantic')
    assert.equal(typeof h.major, 'boolean')
    const d = km([h.lon, h.lat], h.approach)
    assert.ok(d >= 1 && d <= 14, `${h.id}: approach ${d.toFixed(1)} km from the harbour`)
  }
  for (const v of fleet.vessels) {
    assert.deepEqual(Object.keys(v), [
      'id',
      'cfv',
      'name',
      'lengthM',
      'gear',
      'species',
      'region',
      'coast',
      'homePort',
      'licences',
      'zone',
      'ground',
      'route',
      'phase',
      'cycle',
    ])
    assert.match(v.cfv, /^\d{6}$/)
    assert.ok(v.name.trim().length > 2)
    assert.ok(GEARS.includes(v.gear), v.gear)
    assert.ok(REGIONS.includes(v.region))
    assert.ok(v.species.length > 0)
    const home = harbours.get(v.homePort)
    assert.ok(home, `${v.id}: unknown home port ${v.homePort}`)
    assert.equal(home.region, v.region, `${v.id}: home port region`)
    assert.equal(v.coast, home.coast)
    assert.ok(Number.isInteger(v.licences) && v.licences >= 1 && v.licences <= 6)
    assert.ok(v.phase >= 0 && v.phase < 1)
    if (v.zone === 'inshore') {
      assert.ok(v.cycle >= 600 && v.cycle <= 1200, `${v.id}: inshore cycle ${v.cycle}`)
      assert.ok(v.lengthM >= 9 && v.lengthM <= 22, `${v.id}: inshore length ${v.lengthM}`)
      assert.ok(v.route.length >= 2 && v.route.length <= 6)
    } else {
      assert.equal(v.zone, 'offshore')
      assert.ok(v.cycle >= 1800 && v.cycle <= 4000, `${v.id}: offshore cycle ${v.cycle}`)
      assert.ok(v.lengthM >= 11 && v.lengthM <= 75, `${v.id}: offshore length ${v.lengthM}`)
      assert.ok(v.route.length >= 2 && v.route.length <= 25)
    }
    assert.deepEqual(v.route[0], home.approach, `${v.id}: route starts at the approach`)
    assert.deepEqual(v.route.at(-1), [v.ground.lon, v.ground.lat], `${v.id}: route ends on ground`)
    for (const [lon, lat] of v.route) assert.ok(decimals(lon) <= 4 && decimals(lat) <= 4)
  }
})

test('fleet size and regional split are realistic', () => {
  const n = fleet.vessels.length
  assert.ok(n >= 2600 && n <= 3000, `${n} vessels`)
  const by = Object.fromEntries(REGIONS.map((r) => [r, 0])) as Record<DfoRegion, number>
  for (const v of fleet.vessels) by[v.region]++
  assert.ok(by.NL > by.MAR && by.MAR > by.GLF && by.GLF > by.PAC && by.PAC > by.QC, `${by}`)
  assert.ok(by.ARC >= 20 && by.ARC <= 40)
  const count = harbourFile.harbours.length
  assert.ok(count >= 150 && count <= 250, `${count} harbours`)
  const major = harbourFile.harbours.filter((h) => h.major).length
  assert.ok(major >= 30 && major <= 40, `${major} major harbours`)
})

test('ids, CFV numbers and names are unique', () => {
  const unique = (values: string[]) => new Set(values).size === values.length
  assert.ok(unique(fleet.vessels.map((v) => v.id)))
  assert.ok(unique(fleet.vessels.map((v) => v.cfv)))
  assert.ok(unique(fleet.vessels.map((v) => v.name.toLowerCase())))
  assert.ok(unique(harbourFile.harbours.map((h) => h.id)))
})

test('hero vessels and anchor harbours exist with their scene settings', () => {
  for (const id of [
    'lunenburg',
    'prince-rupert',
    'st-johns',
    'petty-harbour',
    'steveston',
    'telegraph-cove',
    'alert-bay',
  ])
    assert.ok(harbours.has(id), id)
  const hero = (id: string) => {
    const v = fleet.vessels.find((x) => x.id === id)
    assert.ok(v, id)
    return v
  }
  const nl1 = hero('nl-01')
  assert.equal(nl1.name, 'Northern Light')
  assert.equal(nl1.lengthM, 47.5)
  assert.equal(nl1.gear, 'Bottom trawl')
  assert.deepEqual(
    [nl1.region, nl1.zone, nl1.homePort, nl1.ground.area],
    ['NL', 'offshore', 'st-johns', '3L'],
  )
  assert.ok(km([nl1.ground.lon, nl1.ground.lat], [-50, 46]) < 15)
  const ns1 = hero('ns-01')
  assert.deepEqual(
    [ns1.name, ns1.region, ns1.zone, ns1.homePort],
    ['Lunenburg Star', 'MAR', 'inshore', 'lunenburg'],
  )
  const nl2 = hero('nl-02')
  assert.deepEqual([nl2.name, nl2.zone, nl2.homePort], ['Signal Hill', 'inshore', 'st-johns'])
  const narrows: LonLat = [-52.672, 47.566]
  const fromNarrows = km(narrows, [nl2.ground.lon, nl2.ground.lat])
  assert.ok(fromNarrows >= 2 && fromNarrows <= 4.5 && nl2.ground.lon > narrows[0])
  const bc1 = hero('bc-01')
  assert.deepEqual(
    [bc1.name, bc1.gear, bc1.region, bc1.zone],
    ['Haida Dawn', 'Purse seine', 'PAC', 'inshore'],
  )
  assert.ok(['alert-bay', 'telegraph-cove'].includes(bc1.homePort))
  assert.ok(km([bc1.ground.lon, bc1.ground.lat], [-126.83, 50.548]) < 15)
  const bc2 = hero('bc-02')
  assert.deepEqual(
    [bc2.name, bc2.homePort, bc2.zone],
    ['Skeena Spirit', 'prince-rupert', 'inshore'],
  )
})

test('every approach and fishing ground is on water', () => {
  // The land test itself: interior Quebec, Newfoundland, Vancouver Island; open Atlantic/Pacific.
  for (const p of [
    [-70, 50],
    [-56, 48.5],
    [-125, 49.5],
  ] as LonLat[])
    assert.ok(isLand(p))
  for (const p of [
    [-50, 45],
    [-130, 50],
    [-62.5, 47],
  ] as LonLat[])
    assert.ok(!isLand(p))
  for (const h of harbourFile.harbours) assert.ok(!isLand(h.approach), `${h.id} approach on land`)
  for (const v of fleet.vessels)
    assert.ok(!isLand([v.ground.lon, v.ground.lat]), `${v.id} ground on land`)
})

test('every route segment, sampled about every kilometre, is on water', () => {
  let samples = 0
  for (const v of fleet.vessels)
    for (let i = 1; i < v.route.length; i++) {
      const a = v.route[i - 1]!
      const b = v.route[i]!
      const n = Math.max(1, Math.ceil(km(a, b)))
      for (let s = 0; s <= n; s++) {
        const p: LonLat = [a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]
        samples++
        assert.ok(!isLand(p), `${v.id} segment ${i} crosses land near ${p}`)
      }
    }
  assert.ok(samples > 10000)
})

test('grounds carry an area label from the NAFO / PFMA layers', () => {
  const labels = (file: string) =>
    new Set<string>(
      JSON.parse(readFileSync(file, 'utf8')).features.map((f: any) => f.properties.label),
    )
  const nafo = labels('public/data/atlantic.geojson')
  const pfma = labels('public/data/pacific.geojson')
  for (const v of fleet.vessels) {
    assert.ok(v.ground.area.trim().length > 0, v.id)
    const known = v.coast === 'pacific' ? pfma : nafo
    assert.ok(
      known.has(v.ground.area) || ['Offshore Pacific', 'Atlantic'].includes(v.ground.area),
      `${v.id}: ${v.ground.area}`,
    )
  }
  for (const v of fleet.vessels.filter((x) => x.region === 'ARC' && x.zone === 'offshore'))
    assert.ok(['0-A', '0-B'].includes(v.ground.area), `${v.id}: ${v.ground.area}`)
})

test('offshore grounds are well away from the home harbour; inshore grounds are close', () => {
  for (const v of fleet.vessels) {
    const d = km(harbours.get(v.homePort)!.approach, [v.ground.lon, v.ground.lat])
    if (v.zone === 'inshore') assert.ok(d <= 21, `${v.id}: inshore ground ${d.toFixed(1)} km out`)
    else assert.ok(d >= 25, `${v.id}: offshore ground ${d.toFixed(1)} km out`)
  }
})

test('licence totals are consistent with the vessels', () => {
  const { total, byRegion, bySpecies } = fleet.licences
  assert.deepEqual(Object.keys(byRegion).sort(), [...REGIONS].sort())
  const sum = (o: Record<string, number>) => Object.values(o).reduce((s, n) => s + n, 0)
  assert.equal(sum(byRegion), total)
  assert.equal(sum(bySpecies), total)
  const held = fleet.vessels.reduce((s, v) => s + v.licences, 0)
  assert.ok(total > held, 'total includes holders without an active vessel')
  for (const r of REGIONS) {
    const regionHeld = fleet.vessels
      .filter((v) => v.region === r)
      .reduce((s, v) => s + v.licences, 0)
    assert.ok(byRegion[r] >= regionHeld, r)
  }
  for (const species of new Set(fleet.vessels.map((v) => v.species))) {
    const speciesHeld = fleet.vessels
      .filter((v) => v.species === species)
      .reduce((s, v) => s + v.licences, 0)
    assert.ok((bySpecies[species] ?? 0) >= speciesHeld, species)
  }
})
