import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotAt, toLocal, validView, createDemoProvider, scenes } from '../app/domain/world'
import { readFileSync } from 'node:fs'
test('simulation is deterministic, bounded and does not mutate previous snapshots', () => {
  const first = snapshotAt(0)
  assert.deepEqual(first, snapshotAt(0))
  assert.notDeepEqual(first, snapshotAt(500))
  assert.equal(first.vessels[0]?.name, 'Northern Light')
  for (const v of snapshotAt(100000).vessels) {
    assert.ok(Number.isFinite(v.position.longitude))
    assert.ok(v.position.longitude < -40 && v.position.longitude > -140)
  }
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
test('subscription cleanup stops callbacks', async () => {
  let count = 0
  const stop = createDemoProvider().subscribe(() => count++)
  assert.equal(count, 1)
  stop()
  await new Promise((r) => setTimeout(r, 1100))
  assert.equal(count, 1)
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
