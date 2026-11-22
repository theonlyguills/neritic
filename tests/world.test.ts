import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DAY,
  FleetSimulation,
  HERO_PINS,
  sceneryFor,
  type HailEvent,
} from '../app/domain/simulation'
import {
  loadDemoProvider,
  snapshotAt,
  START_TIME,
  toLocal,
  validView,
  scenes,
} from '../app/domain/world'
import { boatFor, sceneryForVessel } from '../app/domain/scenery'
import type { FleetFile, HarbourFile } from '../app/domain/fleet'

const fleet = JSON.parse(readFileSync('public/data/fleet.json', 'utf8')) as FleetFile
const harbours = JSON.parse(readFileSync('public/data/harbours.json', 'utf8')) as HarbourFile
const sim = new FleetSimulation(fleet, harbours)

test('simulation is deterministic and keeps every vessel in Canadian waters', () => {
  const a = sim.snapshot(START_TIME)
  assert.deepEqual(a, sim.snapshot(START_TIME))
  assert.notDeepEqual(a, sim.snapshot(START_TIME + 500))
  assert.equal(a.length, fleet.vessels.length)
  for (const v of sim.snapshot(START_TIME + 12345)) {
    assert.ok(Number.isFinite(v.longitude) && Number.isFinite(v.latitude), v.id)
    assert.ok(v.longitude < -40 && v.longitude > -142, v.id)
    assert.ok(v.latitude > 40 && v.latitude < 76, v.id)
    assert.ok(v.heading >= 0 && v.heading < 360, v.id)
  }
})

test('hero vessels hold their scripted status and open the intended scenes', () => {
  const now = sim.snapshot(START_TIME + 999)
  for (const [id, pin] of Object.entries(HERO_PINS)) {
    const v = now.find((x) => x.id === id)
    assert.ok(v, id)
    assert.equal(v.status, pin.status)
  }
  const scene = (id: string) => sceneryForVessel(now.find((v) => v.id === id)!).id
  assert.equal(scene('nl-01'), 'grand-banks')
  assert.equal(scene('nl-02'), 'narrows')
  assert.equal(scene('ns-01'), 'lunenburg')
  assert.equal(scene('bc-01'), 'johnstone')
  assert.equal(scene('bc-02'), 'prince-rupert')
  assert.equal(boatFor(now.find((v) => v.id === 'nl-01')!).id, 'trawler')
  assert.equal(sceneryFor({ status: 'in-port', zone: 'offshore', progress: 0.5 }), 'harbour')
})

test('hail windows partition time: no event is lost or repeated between ticks', () => {
  const t0 = START_TIME
  const whole = sim.hails(t0, t0 + 300).map((e) => e.key)
  const parts: HailEvent[] = []
  for (let t = t0; t < t0 + 300; t += 7.3) parts.push(...sim.hails(t, Math.min(t + 7.3, t0 + 300)))
  assert.deepEqual(
    parts.map((e) => e.key),
    whole,
  )
  assert.equal(new Set(whole).size, whole.length)
  for (const e of sim.hails(t0, t0 + 300)) {
    assert.ok(e.time > t0 && e.time <= t0 + 300)
    if (e.kind === 'in') assert.ok(e.estimateKg > 0)
  }
})

test('dashboard figures agree with the vessel list', () => {
  const snap = snapshotAt(sim, START_TIME)
  const { canada, atlantic, pacific } = snap.stats
  assert.equal(canada.vessels, fleet.vessels.length)
  assert.equal(canada.atSea + canada.inPort, canada.vessels)
  assert.equal(atlantic.vessels + pacific.vessels, canada.vessels)
  assert.equal(canada.fishing + canada.inbound + canada.outbound, canada.atSea)
  assert.ok(canada.hailOuts > 0 && canada.hailIns > 0 && canada.landingsKg > 0)
  const regions = Object.values(canada.byRegion).reduce((n, r) => n + r.vessels, 0)
  assert.equal(regions, canada.vessels)
  // Rolling 24 h hails: an out and an in per vessel trip, so about two per cycle.
  const expected = fleet.vessels.reduce((n, v) => n + (2 * DAY) / v.cycle, 0)
  const pinned = Object.keys(HERO_PINS).length
  assert.ok(Math.abs(canada.hailOuts + canada.hailIns - expected) < expected * 0.05 + pinned * 4)
  // The feed carries forward between ticks, newest first.
  const next = snapshotAt(sim, START_TIME + 30, snap)
  assert.ok(next.feed.length >= snap.feed.length || next.feed.length === 40)
  for (let i = 1; i < next.feed.length; i++) assert.ok(next.feed[i - 1]!.time >= next.feed[i]!.time)
})

test('provider loads the registry and stops ticking on cleanup', async () => {
  const files: Record<string, unknown> = {
    '/data/fleet.json': fleet,
    '/data/harbours.json': harbours,
  }
  const provider = await loadDemoProvider(async (url) => files[url])
  let count = 0
  const stop = provider.subscribe(() => count++, 50)
  assert.equal(count, 1)
  await new Promise((r) => setTimeout(r, 180))
  stop()
  const after = count
  assert.ok(after >= 2)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(count, after)
})

test('local frame uses east and north correctly and wraps dateline', () => {
  const origin = { longitude: -50, latitude: 46 }
  assert.deepEqual(toLocal(origin, origin), { x: 0, y: 0, z: -0 })
  assert.ok(toLocal({ longitude: -49.999, latitude: 46.001 }, origin).x > 0)
  assert.ok(toLocal({ longitude: -49.999, latitude: 46.001 }, origin).z < 0)
  assert.ok(
    Math.abs(toLocal({ longitude: -179.999, latitude: 0 }, { longitude: 179.999, latitude: 0 }).x) <
      300,
  )
})

test('navigation rejects prototype properties and invalid routes', () => {
  assert.equal(validView('constructor'), 'canada')
  assert.equal(validView(['atlantic']), 'canada')
  assert.equal(validView('vessel'), 'vessel')
  assert.equal(scenes.vessel.renderer, 'three')
})

test('bundled boundaries have stable identifiers and geographic coordinates', () => {
  for (const coast of ['atlantic', 'pacific']) {
    const data = JSON.parse(readFileSync(`public/data/${coast}.geojson`, 'utf8'))
    assert.ok(data.features.length > 20)
    assert.equal(new Set(data.features.map((f: any) => f.id)).size, data.features.length)
    for (const f of data.features) {
      assert.ok(f.properties.label)
      const visit = (c: any) => {
        if (typeof c[0] === 'number') {
          assert.ok(Math.abs(c[0]) <= 180)
          assert.ok(Math.abs(c[1]) <= 90)
        } else c.forEach(visit)
      }
      visit(f.geometry.coordinates)
    }
  }
})

test('incremental 24 h hail counters match a full recount after many ticks', () => {
  let snap = snapshotAt(sim, START_TIME)
  for (let i = 1; i <= 400; i++) snap = snapshotAt(sim, START_TIME + i * 0.9, snap)
  const fresh = snapshotAt(sim, snap.time)
  for (const scope of ['canada', 'atlantic', 'pacific'] as const) {
    assert.equal(snap.stats[scope].hailOuts, fresh.stats[scope].hailOuts)
    assert.equal(snap.stats[scope].hailIns, fresh.stats[scope].hailIns)
    assert.equal(snap.stats[scope].landingsKg, fresh.stats[scope].landingsKg)
  }
})

test('vessels open the scene for where they are', async () => {
  const { chooseScenery, PLACES } = await import('../app/domain/scenery')
  const now = sim.snapshot(START_TIME + 321)
  const built = new Set(PLACES.filter((p) => p.type === 'harbour').map((p) => p.id))
  for (const v of now) {
    const { config, representative } = chooseScenery(v)
    assert.ok(config.id, v.id)
    if (v.status === 'in-port' && built.has(v.homePort)) {
      assert.equal(config.id, v.homePort, `${v.id} should open its own harbour`)
      assert.equal(representative, false)
    }
    if (config.kind === 'offshore') assert.equal(config.id, 'grand-banks')
  }
  // Fishing right off a built harbour uses that harbour's terrain, out past its mouth.
  const lunenburg = PLACES.find((p) => p.id === 'lunenburg')!
  const off = chooseScenery({
    status: 'fishing',
    zone: 'inshore',
    progress: 0.5,
    coast: 'atlantic',
    homePort: 'elsewhere',
    longitude: lunenburg.lon + 0.05,
    latitude: lunenburg.lat - 0.03,
  })
  assert.equal(off.config.terrainUrl, '/scenery/lunenburg/')
  assert.equal(off.config.kind, 'inshore')
})
