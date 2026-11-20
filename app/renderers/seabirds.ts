import * as T from 'three'

/**
 * A flock of gulls working the trawler's wake: one instanced draw call, wings flapped in
 * the vertex shader. Proportions follow a herring gull (≈0.6 m long, ≈1.4 m span); grey
 * mantle, black wingtips, white body and underwing. Mostly gliding, with flap bursts.
 * Gull frame: +Z forward, +Y up, X along the span.
 */
interface Gull {
  centre: T.Vector2
  radius: number
  height: number
  speed: number
  phase: number
  direction: 1 | -1
  flapRate: number
  seed: number
}

const WHITE = [0.93, 0.94, 0.94]
const GREY = [0.55, 0.58, 0.62]
const BLACK = [0.07, 0.07, 0.08]
const BILL = [0.86, 0.72, 0.25]

function gullGeometry() {
  const position: number[] = []
  const color: number[] = []
  // wing: x = segment (0 body, 1 inner, 2 outer), y = side (-1 port, 1 starboard)
  const wing: number[] = []
  const tri = (a: number[], b: number[], c: number[], rgb: number[], segment = 0, side = 0) => {
    position.push(...a, ...b, ...c)
    for (let i = 0; i < 3; i++) {
      color.push(...rgb)
      wing.push(segment, side)
    }
  }
  // Body: a slim double-ended spindle, 6 sides.
  const ring = (z: number, r: number, yScale = 1) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2
      return [Math.cos(a) * r, Math.sin(a) * r * yScale, z]
    })
  const rings = [
    ring(0.3, 0.035),
    ring(0.2, 0.06),
    ring(0.0, 0.075, 0.9),
    ring(-0.18, 0.05, 0.8),
    ring(-0.3, 0.02, 0.5),
  ]
  for (let r = 0; r < rings.length - 1; r++)
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6
      tri(rings[r]![i]!, rings[r + 1]![i]!, rings[r + 1]![j]!, WHITE)
      tri(rings[r]![i]!, rings[r + 1]![j]!, rings[r]![j]!, WHITE)
    }
  const nose = [0, -0.005, 0.38]
  for (let i = 0; i < 6; i++) tri(rings[0]![(i + 1) % 6]!, nose, rings[0]![i]!, BILL)
  // Tail fan.
  tri([-0.07, 0.0, -0.3], [0.07, 0.0, -0.3], [0, 0.01, -0.18], WHITE)
  tri([0.07, 0.0, -0.3], [-0.07, 0.0, -0.3], [0, 0.01, -0.18], WHITE)
  // Wings: inner (shoulder → elbow) and outer (elbow → tip), separate top/bottom faces.
  for (const side of [-1, 1]) {
    const s = (v: number[]) => [v[0]! * side, v[1]!, v[2]!]
    const inner = [
      s([0.05, 0.02, 0.1]),
      s([0.36, 0.02, 0.07]),
      s([0.36, 0.02, -0.08]),
      s([0.05, 0.02, -0.06]),
    ]
    const outer = [inner[1]!, s([0.72, 0.02, -0.05]), s([0.62, 0.02, -0.13]), inner[2]!]
    for (const [quad, segment, top] of [
      [inner, 1, GREY],
      [outer, 2, GREY],
    ] as const) {
      const [a, b, c, d] = side > 0 ? quad : [quad[1], quad[0], quad[3], quad[2]]
      tri(a!, b!, c!, top, segment, side)
      tri(a!, c!, d!, top, segment, side)
      tri(c!, b!, a!, WHITE, segment, side)
      tri(d!, c!, a!, WHITE, segment, side)
    }
    // Black wingtip over the outer third (top and bottom).
    const tip = [s([0.6, 0.024, -0.06]), s([0.72, 0.024, -0.05]), s([0.62, 0.024, -0.13])]
    const [a, b, c] = side > 0 ? tip : [tip[1], tip[0], tip[2]]
    tri(a!, b!, c!, BLACK, 2, side)
    tri(c!, b!, a!, BLACK, 2, side)
  }
  const geometry = new T.BufferGeometry()
  geometry.setAttribute('position', new T.Float32BufferAttribute(position, 3))
  geometry.setAttribute('color', new T.Float32BufferAttribute(color, 3))
  geometry.setAttribute('wing', new T.Float32BufferAttribute(wing, 2))
  geometry.computeVertexNormals()
  return geometry
}

export function createGulls(count: number, wakeCentre: T.Vector2) {
  const geometry = gullGeometry()
  const flap = new T.InstancedBufferAttribute(new Float32Array(count * 2), 2)
  flap.setUsage(T.DynamicDrawUsage)
  geometry.setAttribute('flap', flap)
  const material = new T.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    side: T.FrontSide,
  })
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 wing;
        attribute vec2 flap; // x: flap angle (radians), y: gliding wing bend
        vec3 hinge(vec3 p, float pivotX, float angle) {
          float c = cos(angle), s = sin(angle);
          vec2 q = vec2(p.x - pivotX, p.y);
          return vec3(pivotX + q.x * c - q.y * s, q.x * s + q.y * c, p.z);
        }`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        if (wing.x > 0.5) {
          float side = wing.y;
          // Mirror port to starboard, hinge, mirror back.
          vec3 p = vec3(transformed.x * side, transformed.yz);
          float shoulder = 0.12 + flap.x;
          float elbow = -flap.y + flap.x * 0.7;
          if (wing.x > 1.5) {
            p = hinge(p, 0.36, elbow);
          }
          p = hinge(p, 0.05, shoulder);
          transformed = vec3(p.x * side, p.yz);
        }`,
      )
  }
  const mesh = new T.InstancedMesh(geometry, material, count)
  mesh.name = 'Gulls'
  mesh.castShadow = true
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(T.DynamicDrawUsage)
  // Deterministic flock so screenshots and reduced-motion frames are stable.
  let state = 7
  const random = () => ((state = (state * 16807) % 2147483647) - 1) / 2147483646
  const gulls: Gull[] = Array.from({ length: count }, (_, i) => ({
    centre: new T.Vector2(wakeCentre.x + (random() - 0.5) * 24, wakeCentre.y + random() * 45),
    radius: 7 + random() * 22,
    height: 6 + random() * 16,
    speed: 7 + random() * 4,
    phase: random() * Math.PI * 2,
    direction: i % 3 === 0 ? -1 : 1,
    flapRate: 2.6 + random() * 0.8,
    seed: random() * 100,
  }))
  const matrix = new T.Matrix4()
  const quaternion = new T.Quaternion()
  const euler = new T.Euler(0, 0, 0, 'YXZ')
  const scale = new T.Vector3()
  const position = new T.Vector3()

  function update(time: number) {
    gulls.forEach((gull, i) => {
      const omega = (gull.speed / gull.radius) * gull.direction
      const a = gull.phase + time * omega
      // Wandering circle: the centre drifts so paths do not look like rails.
      const cx = gull.centre.x + Math.sin(time * 0.05 + gull.seed) * 8
      const cz = gull.centre.y + Math.cos(time * 0.04 + gull.seed * 1.3) * 10
      position.set(
        cx + Math.cos(a) * gull.radius,
        gull.height + Math.sin(time * 0.3 + gull.seed) * 2.5,
        cz + Math.sin(a) * gull.radius,
      )
      const heading = Math.atan2(-Math.sin(a) * gull.direction, Math.cos(a) * gull.direction)
      const bank = Math.atan((gull.speed * gull.speed) / (gull.radius * 9.81)) * gull.direction
      const climb = Math.cos(time * 0.3 + gull.seed) * 0.08
      euler.set(-climb, heading, bank)
      quaternion.setFromEuler(euler)
      scale.setScalar(0.95 + (gull.seed % 1) * 0.15)
      matrix.compose(position, quaternion, scale)
      mesh.setMatrixAt(i, matrix)
      // Flap in bursts (about a third of the time); otherwise hold a gliding "M".
      const burst = Math.max(0, Math.sin(time * 0.35 + gull.seed * 2.1))
      const flapping = Math.min(1, Math.max(0, (burst - 0.55) * 4))
      const stroke = Math.sin(time * gull.flapRate * Math.PI * 2 + gull.seed)
      flap.setXY(i, stroke * 0.75 * flapping, 0.28 * (1 - flapping))
    })
    mesh.instanceMatrix.needsUpdate = true
    flap.needsUpdate = true
  }
  const instance = new T.Matrix4()
  /** World position of gull `i` (for positional calls). */
  function positionOf(i: number, target: T.Vector3) {
    mesh.getMatrixAt(i, instance)
    return target.setFromMatrixPosition(instance)
  }
  update(0)
  return { mesh, update, positionOf, count }
}
