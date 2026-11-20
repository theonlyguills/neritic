import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seaAt, waves } from '../app/renderers/sea'
test('wave surface slopes agree with finite differences used for buoyancy', () => {
  const e = 0.0001
  for (const [x, z, t] of [
    [0, 0, 0],
    [8, -5, 3],
    [-40, 32, 90],
  ]) {
    const value = seaAt(x!, z!, t!)
    const dx = (seaAt(x! + e, z!, t!).height - seaAt(x! - e, z!, t!).height) / (2 * e)
    const dz = (seaAt(x!, z! + e, t!).height - seaAt(x!, z! - e, t!).height) / (2 * e)
    assert.ok(Math.abs(dx - value.dx) < 1e-6)
    assert.ok(Math.abs(dz - value.dz) < 1e-6)
  }
})
test('swells evolve without exceeding the configured amplitude envelope', () => {
  const max = waves.reduce((n, w) => n + w.amplitude, 0)
  for (let t = 0; t < 100; t += 0.5) assert.ok(Math.abs(seaAt(7, 11, t).height) <= max)
  assert.notEqual(seaAt(7, 11, 0).height, seaAt(7, 11, 1).height)
})
