import * as T from 'three'
import { buildStreets, streetFinder, type StreetsFile } from './streets'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Real-geography scenery for the close-up boat scene: terrain from a DEM corrected to the
 * OpenStreetMap coastline, instanced conifers, buildings with pitched roofs, wharves, floats,
 * breakwaters and landmarks. Data comes from `scripts/fetch-scenery.mjs`
 * (public/scenery/<id>/). Local frame as `toLocal()`: metres, x = east, z = −north, y up,
 * sea level at y = 0, the hero boat at the origin.
 */

export type XZ = [number, number]
export type RoofShape = 'gable' | 'hip' | 'flat'
export type BuildingKind =
  'house' | 'apartments' | 'commercial' | 'industrial' | 'shed' | 'church' | 'civic'

export interface SceneryBuilding {
  /** Counter-clockwise ring (positive shoelace area in x, z), no repeated end point. */
  footprint: XZ[]
  /** Total height above `base`, including the roof. */
  height: number
  /** Ground-floor level (metres above sea level): terrain, or the deck of a wharf. */
  base: number
  roof: RoofShape
  kind: BuildingKind
  colour?: string
  roofColour?: string
  name?: string
}
export interface SceneryPier {
  polygon: XZ[]
  deckHeight: number
  floating: boolean
  name?: string
}
export interface SceneryBreakwater {
  polygon: XZ[]
  height: number
}
export interface SceneryLandmark {
  kind: 'lighthouse' | 'stone-tower'
  x: number
  z: number
  base: number
  height: number
  name: string
  footprint?: XZ[]
}
export interface SceneryLake {
  polygon: XZ[]
  level: number
  name?: string
}
export interface SceneryMeta {
  id: string
  name: string
  place: string
  province: string
  type: 'inshore' | 'harbour'
  center: { lon: number; lat: number }
  sizeM: number
  grid: number
  cellM: number
  terrain: { file: string; format: 'int16le'; unit: 'decimetre'; layout: string }
  landcover: { file: string; size: number; classes: Record<string, number> }
  heightRange: [number, number]
  forest: 'dense-conifer' | 'sparse-scrub'
  /** Hero boat: heading is a compass bearing of the bow; rotation.y = −heading in radians. */
  boat: { x: number; z: number; headingDeg: number; lengthM: number; faceOffsetM?: number }
  /** Harbour scenes: the wharf face the boat lies alongside. */
  berthFace?: XZ[]
  /** Harbour scenes: a water path from outside the harbour to the berth (last point). */
  arrival?: XZ[]
  /** Compass bearing from the boat towards the most scenic land. */
  viewBearingDeg: number
  features: {
    buildings: SceneryBuilding[]
    piers: SceneryPier[]
    breakwaters: SceneryBreakwater[]
    landmarks: SceneryLandmark[]
    lakes: SceneryLake[]
  }
  attribution: string[]
}

export interface SceneryOptions {
  /** Multiplies the tree budget (1 = default; ~0.5 for weak GPUs). */
  treeDensity?: number
  /** Cast and receive shadows (default true). */
  shadows?: boolean
  /** Harbour scenes: wharves kept around the hero's berth (default 3). */
  wharves?: number
  /** Share of parked cars kept (1 = all). */
  carShare?: number
}

export interface SceneryStats {
  vertices: number
  triangles: number
  treeInstances: number
  drawCalls: number
}

export interface Scenery {
  group: T.Group
  /** Terrain height (metres) at a local position; sea floor below 0. */
  heightAt(x: number, z: number): number
  /**
   * Land/sea height texture covering `bounds`, R = height in metres (half-float, linear
   * filtering). Sample with uv = ((x − minX) / size, (z − minZ) / size).
   */
  heightTexture: T.DataTexture
  bounds: { minX: number; minZ: number; size: number }
  meta: SceneryMeta
  stats: SceneryStats
  dispose(): void
}

/** Load `<baseUrl>/scenery.json`, its terrain and land cover, and build the scenery group. */
export async function loadScenery(
  baseUrl: string,
  renderer: T.WebGLRenderer,
  options: SceneryOptions = {},
): Promise<Scenery> {
  const base = baseUrl.replace(/\/$/, '')
  const get = async (file: string) => {
    const response = await fetch(`${base}/${file}`)
    if (!response.ok) throw new Error(`Scenery ${file}: HTTP ${response.status}`)
    return response
  }
  const meta = (await (await get('scenery.json')).json()) as SceneryMeta
  const [terrainBuffer, coverBuffer] = await Promise.all([
    get(meta.terrain.file).then((r) => r.arrayBuffer()),
    get(meta.landcover.file).then((r) => r.arrayBuffer()),
  ])
  if (meta.type === 'harbour') {
    const n = meta.grid,
      half = meta.sizeM / 2,
      cell = meta.sizeM / (n - 1)
    const grid = new DataView(terrainBuffer)
    const ground = (x: number, z: number) => {
      const i = Math.max(0, Math.min(n - 1, Math.round((x + half) / cell)))
      const j = Math.max(0, Math.min(n - 1, Math.round((z + half) / cell)))
      return grid.getInt16((j * n + i) * 2, true) / 10
    }
    smallTownWaterfront(meta, options.wharves ?? 3, ground)
  }
  // Street-level OSM detail (roads, fuel, parking): optional, added by fetch-streets.mjs.
  const streets = (await fetch(`${base}/streets.json`)
    .then((r) => (r.ok ? r.json() : undefined))
    .catch(() => undefined)) as StreetsFile | undefined
  return buildScenery(meta, terrainBuffer, coverBuffer, renderer, options, streets)
}

/**
 * A small-town waterfront: keep the hero's wharf and the nearest few others (the full OSM
 * harbour has dozens), and the buildings that stood on the removed wharves go with them.
 */
function smallTownWaterfront(
  meta: SceneryMeta,
  keep: number,
  ground: (x: number, z: number) => number,
) {
  const piers = meta.features.piers
  if (piers.length <= keep) return
  const centroid = (ring: XZ[]) => {
    let x = 0,
      z = 0
    for (const p of ring) {
      x += p[0]
      z += p[1]
    }
    return [x / ring.length, z / ring.length] as XZ
  }
  const edgeDistance = (ring: XZ[], [px, pz]: XZ) => {
    let best = Infinity
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i]!
      const [bx, bz] = ring[(i + 1) % ring.length]!
      const dx = bx - ax,
        dz = bz - az
      const t = Math.max(
        0,
        Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)),
      )
      best = Math.min(best, Math.hypot(ax + dx * t - px, az + dz * t - pz))
    }
    return best
  }
  const inside = (ring: XZ[], [px, pz]: XZ) => {
    let hit = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i]!
      const [xj, zj] = ring[j]!
      if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) hit = !hit
    }
    return hit
  }
  const ranked = piers
    .map((pier) => ({ pier, d: edgeDistance(pier.polygon, [0, 0]) }))
    .sort((a, b) => a.d - b.d)
  const kept = ranked.filter((r, i) => i === 0 || r.d < 380).slice(0, keep)
  const removed = piers.filter((p) => !kept.some((k) => k.pier === p))
  meta.features.piers = kept.map((k) => k.pier)
  meta.features.buildings = meta.features.buildings.filter((b) => {
    const c = centroid(b.footprint)
    if (removed.some((p) => inside(p.polygon, c) || edgeDistance(p.polygon, c) < 3)) return false
    // Anything else standing over water must be on a wharf that is still there.
    const onKept = kept.some(
      (k) => inside(k.pier.polygon, c) || edgeDistance(k.pier.polygon, c) < 4,
    )
    return ground(c[0], c[1]) > 0.2 || onKept
  })
}

// ------------------------------------------------------------------------------ helpers

export type V3 = [number, number, number]

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hash2(x: number, z: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise in [0, 1]. */
function valueNoise(x: number, z: number) {
  const ix = Math.floor(x),
    iz = Math.floor(z)
  const fx = x - ix,
    fz = z - iz
  const u = fx * fx * (3 - 2 * fx),
    v = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz),
    b = hash2(ix + 1, iz),
    c = hash2(ix, iz + 1),
    d = hash2(ix + 1, iz + 1)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

function fbm(x: number, z: number, octaves = 3) {
  let sum = 0,
    amp = 0.5,
    norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x, z) * amp
    norm += amp
    x = x * 2.03 + 17.1
    z = z * 2.03 - 9.7
    amp *= 0.5
  }
  return sum / norm
}

export function pointInRing(x: number, z: number, ring: XZ[]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!,
      [xj, zj] = ring[j]!
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

export function ringArea(ring: XZ[]) {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
  return a / 2
}

export function ringCentroid(ring: XZ[]): XZ {
  let x = 0,
    z = 0
  for (const p of ring) {
    x += p[0]
    z += p[1]
  }
  return [x / ring.length, z / ring.length]
}

/** Scan-converts a polygon onto an n × n grid with cell centres at origin + i × cell. */
function fillPolygon(
  ring: XZ[],
  n: number,
  origin: number,
  cell: number,
  fn: (index: number) => void,
) {
  let minZ = Infinity,
    maxZ = -Infinity
  for (const p of ring) {
    minZ = Math.min(minZ, p[1])
    maxZ = Math.max(maxZ, p[1])
  }
  const j0 = Math.max(0, Math.ceil((minZ - origin) / cell)),
    j1 = Math.min(n - 1, Math.floor((maxZ - origin) / cell))
  const xs: number[] = []
  for (let j = j0; j <= j1; j++) {
    const z = origin + j * cell
    xs.length = 0
    for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
      const [xi, zi] = ring[i]!,
        [xk, zk] = ring[k]!
      if (zi > z !== zk > z) xs.push(xi + ((z - zi) * (xk - xi)) / (zk - zi))
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k]! - origin) / cell)),
        i1 = Math.min(n - 1, Math.floor((xs[k + 1]! - origin) / cell))
      for (let i = i0; i <= i1; i++) fn(j * n + i)
    }
  }
}

/** Oriented minimum-area rectangle of a ring: axes u = (ux, uz), v = (−uz, ux). */
export function orientedBox(ring: XZ[]) {
  let best = { area: Infinity, ux: 1, uz: 0, minU: 0, maxU: 0, minV: 0, maxV: 0 }
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!,
      b = ring[(i + 1) % ring.length]!
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 1e-6) continue
    const ux = (b[0] - a[0]) / len,
      uz = (b[1] - a[1]) / len
    let minU = Infinity,
      maxU = -Infinity,
      minV = Infinity,
      maxV = -Infinity
    for (const p of ring) {
      const u = p[0] * ux + p[1] * uz,
        v = -p[0] * uz + p[1] * ux
      minU = Math.min(minU, u)
      maxU = Math.max(maxU, u)
      minV = Math.min(minV, v)
      maxV = Math.max(maxV, v)
    }
    const area = (maxU - minU) * (maxV - minV)
    if (area < best.area) best = { area, ux, uz, minU, maxU, minV, maxV }
  }
  return best
}

export const colour = (hex: string) => new T.Color(hex)
export const pick = <V>(list: readonly V[], r: number) =>
  list[Math.min(list.length - 1, Math.floor(r * list.length))]!

/**
 * Accumulates flat-shaded, non-indexed triangles with vertex colours (and optional extra
 * attributes), so each material becomes one draw call.
 */
export class Mesher {
  position: number[] = []
  normal: number[] = []
  color: number[] = []
  extras = new Map<string, { size: number; data: number[] }>()
  constructor(extra: Record<string, number> = {}) {
    for (const [name, size] of Object.entries(extra)) this.extras.set(name, { size, data: [] })
  }
  /** One triangle; its winding is fixed to face `facing` (or kept when omitted). */
  tri(a: V3, b: V3, c: V3, rgb: T.Color, facing?: V3, extra?: Record<string, number[][]>, n?: V3) {
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const ac: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    let nx = ab[1] * ac[2] - ab[2] * ac[1],
      ny = ab[2] * ac[0] - ab[0] * ac[2],
      nz = ab[0] * ac[1] - ab[1] * ac[0]
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-9) return
    let order = [0, 1, 2]
    if (facing && nx * facing[0] + ny * facing[1] + nz * facing[2] < 0) {
      order = [0, 2, 1]
      nx = -nx
      ny = -ny
      nz = -nz
    }
    const vs = [a, b, c]
    const normal = n ?? [nx / len, ny / len, nz / len]
    for (const k of order) {
      const v = vs[k]!
      this.position.push(v[0], v[1], v[2])
      this.normal.push(normal[0], normal[1], normal[2])
      this.color.push(rgb.r, rgb.g, rgb.b)
      for (const [name, attr] of this.extras) {
        const values = extra?.[name]?.[k]
        for (let s = 0; s < attr.size; s++) attr.data.push(values?.[s] ?? 0)
      }
    }
  }
  /** Quad a-b-c-d (in order around its edge) facing `facing`. */
  quad(a: V3, b: V3, c: V3, d: V3, rgb: T.Color, facing?: V3, extra?: Record<string, number[][]>) {
    const pick3 = (i: number, j: number, k: number) =>
      extra
        ? Object.fromEntries(
            Object.entries(extra).map(([name, values]) => [
              name,
              [values[i]!, values[j]!, values[k]!],
            ]),
          )
        : undefined
    this.tri(a, b, c, rgb, facing, pick3(0, 1, 2))
    this.tri(a, c, d, rgb, facing, pick3(0, 2, 3))
  }
  /** Adds an existing (indexed or not) geometry transformed by `matrix`, in one colour. */
  geometry(source: T.BufferGeometry, matrix: T.Matrix4, rgb: T.Color, smooth = false) {
    const g = source.index ? source.toNonIndexed() : source
    const p = g.attributes.position!
    const nrm = g.attributes.normal
    const normalMatrix = new T.Matrix3().getNormalMatrix(matrix)
    const v = new T.Vector3(),
      nv = new T.Vector3()
    for (let i = 0; i < p.count; i += 3) {
      const tri: V3[] = []
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(p, i + k).applyMatrix4(matrix)
        tri.push([v.x, v.y, v.z])
      }
      if (smooth && nrm) {
        for (let k = 0; k < 3; k++) {
          nv.fromBufferAttribute(nrm, i + k)
            .applyMatrix3(normalMatrix)
            .normalize()
          const t = tri[k]!
          this.position.push(t[0], t[1], t[2])
          this.normal.push(nv.x, nv.y, nv.z)
          this.color.push(rgb.r, rgb.g, rgb.b)
          for (const attr of this.extras.values())
            for (let s = 0; s < attr.size; s++) attr.data.push(0)
        }
      } else this.tri(tri[0]!, tri[1]!, tri[2]!, rgb)
    }
    if (g !== source) g.dispose()
  }
  /** Vertical prism (cylinder with `sides`) from y0 to y1, with a top cap. */
  cylinder(
    x: number,
    z: number,
    y0: number,
    y1: number,
    r0: number,
    r1: number,
    sides: number,
    rgb: T.Color,
    cap = true,
  ) {
    for (let s = 0; s < sides; s++) {
      const a0 = (s / sides) * Math.PI * 2,
        a1 = ((s + 1) / sides) * Math.PI * 2
      const am = (a0 + a1) / 2
      const facing: V3 = [Math.cos(am), 0, Math.sin(am)]
      this.quad(
        [x + Math.cos(a0) * r0, y0, z + Math.sin(a0) * r0],
        [x + Math.cos(a1) * r0, y0, z + Math.sin(a1) * r0],
        [x + Math.cos(a1) * r1, y1, z + Math.sin(a1) * r1],
        [x + Math.cos(a0) * r1, y1, z + Math.sin(a0) * r1],
        rgb,
        facing,
      )
      if (cap && r1 > 0)
        this.tri(
          [x, y1, z],
          [x + Math.cos(a0) * r1, y1, z + Math.sin(a0) * r1],
          [x + Math.cos(a1) * r1, y1, z + Math.sin(a1) * r1],
          rgb,
          [0, 1, 0],
        )
    }
  }
  get vertexCount() {
    return this.position.length / 3
  }
  build() {
    const g = new T.BufferGeometry()
    g.setAttribute('position', new T.Float32BufferAttribute(this.position, 3))
    g.setAttribute('normal', new T.Float32BufferAttribute(this.normal, 3))
    g.setAttribute('color', new T.Float32BufferAttribute(this.color, 3))
    for (const [name, attr] of this.extras)
      g.setAttribute(name, new T.Float32BufferAttribute(attr.data, attr.size))
    g.computeBoundingSphere()
    g.computeBoundingBox()
    return g
  }
}

/** Triangulates a ring at a fixed height, facing up (or down). */
export function cap(m: Mesher, ring: XZ[], y: number, rgb: T.Color, up = true) {
  const contour = ring.map(([x, z]) => new T.Vector2(x, z))
  const faces = T.ShapeUtils.triangulateShape(contour, [])
  for (const face of faces) {
    const pa = ring[face[0]!]!,
      pb = ring[face[1]!]!,
      pc = ring[face[2]!]!
    m.tri([pa[0], y, pa[1]], [pb[0], y, pb[1]], [pc[0], y, pc[1]], rgb, [0, up ? 1 : -1, 0])
  }
}

// ------------------------------------------------------------------------------ shaders

/** Shared GLSL: cheap hash/value noise that stays stable at kilometre coordinates. */
const NOISE_GLSL = /* glsl */ `
float sHash(vec2 p) {
  p = mod(p, 1024.0);
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float sHash3(vec3 p) {
  p = mod(p, 1024.0);
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float sNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x),
             mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(sHash3(i), sHash3(i + vec3(1, 0, 0)), u.x),
                mix(sHash3(i + vec3(0, 1, 0)), sHash3(i + vec3(1, 1, 0)), u.x), u.y);
  float b = mix(mix(sHash3(i + vec3(0, 0, 1)), sHash3(i + vec3(1, 0, 1)), u.x),
                mix(sHash3(i + vec3(0, 1, 1)), sHash3(i + vec3(1, 1, 1)), u.x), u.y);
  return mix(a, b, u.z);
}
float sFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 4; i++) { v += a * sNoise(p); p = r * p * 2.03 + 17.1; a *= 0.5; }
  return v / 0.9375;
}
vec3 sRgb(vec3 c) { return pow(c, vec3(2.2)); }
// three's perturbNormalArb (bump mapping from screen-space height derivatives).
vec3 sPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = normalize(dFdx(surfPos));
  vec3 sy = normalize(dFdy(surfPos));
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`

interface Patch {
  key: string
  uniforms?: Record<string, T.IUniform>
  defines?: Record<string, string>
  vertexHeader?: string
  vertexMain?: string
  fragmentHeader?: string
  colour?: string
  roughness?: string
  normal?: string
}

/** Injects world-position varyings and the given chunks into a MeshStandardMaterial. */
export function patch(material: T.MeshStandardMaterial, p: Patch) {
  const defines = Object.keys(p.defines ?? {})
    .map((name) => `#define ${name} ${p.defines![name]}`)
    .join('\n')
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, p.uniforms ?? {})
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vSWorld;\nvarying vec3 vSNormal;\n${p.vertexHeader ?? ''}`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 sWorld = vec4(transformed, 1.0);
          vec3 sNormal = objectNormal;
          #ifdef USE_INSTANCING
            sWorld = instanceMatrix * sWorld;
            sNormal = mat3(instanceMatrix) * sNormal;
          #endif
          vSWorld = (modelMatrix * sWorld).xyz;
          vSNormal = normalize(mat3(modelMatrix) * sNormal);
        }
        ${p.vertexMain ?? ''}`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `${defines}\n#include <common>\nvarying vec3 vSWorld;\nvarying vec3 vSNormal;\nfloat sRough = 0.9;\nfloat sBump = 0.0;\n${NOISE_GLSL}\n${p.fragmentHeader ?? ''}`,
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${p.colour ?? ''}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${p.roughness ?? ''}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${p.normal ?? ''}`,
      )
  }
  material.customProgramCacheKey = () => p.key
}

/** Terrain: slope/height blending of rock and vegetation, intertidal bands, bump detail. */
function terrainMaterial(mask: T.Texture, maskBounds: T.Vector4, pacific: boolean) {
  const material = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 })
  patch(material, {
    key: `scenery-terrain-${pacific ? 'pacific' : 'atlantic'}`,
    defines: pacific ? { SCENERY_PACIFIC: '' } : {},
    uniforms: { sMask: { value: mask }, sMaskBounds: { value: maskBounds } },
    fragmentHeader: /* glsl */ `
      uniform sampler2D sMask;
      uniform vec4 sMaskBounds;
    `,
    colour: /* glsl */ `
    {
      vec3 P = vSWorld;
      vec3 N = normalize(vSNormal);
      float h = P.y;
      float slope = 1.0 - N.y;
      vec4 cover = texture2D(sMask, (P.xz - sMaskBounds.xy) / sMaskBounds.z);
      // Metres per pixel: fade out detail that would alias.
      float px = max(length(fwidth(P.xz)), 1e-3);
      float nearFade = 1.0 - smoothstep(0.4, 3.0, px);
      float midFade = 1.0 - smoothstep(4.0, 30.0, px);
      float macro = sFbm(P.xz / 430.0);
      float mid = sFbm(P.xz / 41.0);
      float fine = mix(0.5, sNoise(P.xz / 2.7) * 0.65 + sNoise(P.xz / 0.9) * 0.35, nearFade);
      float speck = mix(0.5, sNoise(P.xz / 6.5), midFade);
      // Rock: 3D noise so cliffs do not stretch; faint bedding follows height.
      float rn = sNoise3(P / 7.0) * 0.6 + mix(0.5, sNoise3(P / 1.9), nearFade) * 0.4;
      float strata = sin(h * 1.3 + sNoise3(P / 17.0) * 7.0) * 0.5 + 0.5;
      // Cliff faces: water-stained vertical streaks and darker joints, strongest when steep.
      float steep = smoothstep(0.35, 0.75, slope);
      float streaks = sNoise3(P * vec3(0.3, 0.022, 0.3)) * 0.65 + sNoise3(P * vec3(1.1, 0.08, 1.1)) * 0.35;
      float joints = smoothstep(0.62, 0.78, sNoise3(P * vec3(0.12, 0.5, 0.12)));
      float cliffShade = mix(1.0, mix(0.6, 1.1, streaks) * (1.0 - joints * 0.35), steep);
    #ifdef SCENERY_PACIFIC
      vec3 rockA = sRgb(vec3(0.31, 0.31, 0.29));
      vec3 rockB = sRgb(vec3(0.18, 0.185, 0.18));
      vec3 rock = mix(rockB, rockA, rn) * mix(0.93, 1.05, strata * midFade) * cliffShade;
      // Moss and lichen on the rock in this wet climate.
      rock = mix(rock, sRgb(vec3(0.24, 0.28, 0.18)), smoothstep(0.5, 0.75, sFbm(P.xz / 8.0) + (1.0 - slope) * 0.2) * 0.55);
      // Dense conifer canopy: dark crowns, lighter tops; hue drifts across hillsides.
      vec3 forestA = sRgb(vec3(0.12, 0.165, 0.105));
      vec3 forestB = sRgb(vec3(0.16, 0.20, 0.125));
      vec3 forestC = sRgb(vec3(0.10, 0.14, 0.12));
      float crowns = mix(0.5, sNoise(P.xz / 4.5) * 0.6 + sNoise(P.xz / 1.6) * 0.4, midFade);
      vec3 veg = mix(mix(forestC, forestA, smoothstep(0.3, 0.7, macro)), forestB, smoothstep(0.55, 0.8, mid) * 0.5);
      veg *= mix(0.7, 1.15, crowns) * mix(0.9, 1.08, speck);
      // Where OSM says built-up or grass: clearings, lawns and gravel instead of forest.
      vec3 clearing = mix(sRgb(vec3(0.33, 0.37, 0.22)), sRgb(vec3(0.40, 0.39, 0.36)), smoothstep(0.45, 0.75, fine * 0.5 + mid * 0.5 + cover.g * 0.2));
      veg = mix(veg, clearing, clamp(cover.g * 1.3 + cover.b, 0.0, 1.0) * (1.0 - cover.r * 0.6));
      float vegAmount = 1.0 - smoothstep(0.6, 0.8, slope + (mid - 0.5) * 0.3 + (fine - 0.5) * 0.1);
      vegAmount = max(vegAmount, joints * steep * 0.8 * smoothstep(5.0, 10.0, h));
      // Bare rock and drift logs above the tide line, then the forest edge.
      vegAmount *= smoothstep(3.0, 4.5, h + (mid - 0.5) * 2.0);
      vegAmount *= 1.0 - cover.a * 0.8;
      vec3 colour = mix(rock, veg, vegAmount);
      float snow = smoothstep(1150.0, 1320.0, h + (macro - 0.5) * 160.0) * (1.0 - smoothstep(0.45, 0.7, slope));
      colour = mix(colour, sRgb(vec3(0.88, 0.9, 0.93)), snow);
      sRough = mix(0.78, 0.92, vegAmount);
      // Intertidal heights (large Pacific tides): rockweed, barnacles, black lichen.
      vec3 zones = vec3(1.0, 1.7, 2.7);
      vec3 beachColour = sRgb(vec3(0.36, 0.34, 0.31));
    #else
      // Barren Atlantic coast: grey-brown granite and sandstone, olive heath, dark tuckamore.
      vec3 rockA = sRgb(vec3(0.43, 0.39, 0.36));
      vec3 rockB = sRgb(vec3(0.30, 0.26, 0.25));
      vec3 lichen = sRgb(vec3(0.56, 0.56, 0.52));
      vec3 rock = mix(rockB, rockA, rn) * mix(0.92, 1.06, strata * midFade) * cliffShade;
      rock = mix(rock, lichen, smoothstep(0.62, 0.8, sFbm(P.xz / 9.0 + 3.1)) * 0.4 * midFade);
      // Heath: olive crowberry, rust-brown huckleberry, grey-green lichen mats, fine mottling.
      vec3 heathA = sRgb(vec3(0.36, 0.35, 0.22));
      vec3 heathB = sRgb(vec3(0.40, 0.31, 0.21));
      vec3 heathC = sRgb(vec3(0.42, 0.42, 0.33));
      vec3 veg = mix(heathA, heathB, smoothstep(0.35, 0.75, macro * 0.6 + speck * 0.4));
      veg = mix(veg, heathC, smoothstep(0.6, 0.85, sFbm(P.xz / 13.0 + 5.0)) * 0.5);
      veg *= mix(0.84, 1.1, fine) * mix(0.93, 1.06, speck);
      // Meadow on mapped grass and parks (Signal Hill): grass mixed into the heath.
      vec3 meadow = mix(sRgb(vec3(0.39, 0.40, 0.24)), sRgb(vec3(0.47, 0.43, 0.29)), smoothstep(0.3, 0.7, speck));
      veg = mix(veg, meadow * mix(0.88, 1.08, fine), cover.b * (1.0 - cover.g) * smoothstep(0.3, 0.6, speck * 0.6 + fine * 0.4) * 0.75);
      // Tuckamore: wind-stunted spruce in small sheltered clumps; dense in mapped woods.
      float tuck = smoothstep(0.62, 0.74, sFbm(P.xz / 11.0 + 7.3) + cover.r * 0.3 - slope * 0.4) * (0.3 + 0.7 * cover.r);
      tuck = max(tuck, smoothstep(0.75, 1.0, cover.r) * 0.75);
      veg = mix(veg, sRgb(vec3(0.13, 0.17, 0.11)) * mix(0.75, 1.15, fine), tuck);
      // Town: lawns and gardens, with gravel and asphalt where it is densest.
      // Real streets are drawn on top (streets.ts), so town ground is mostly mown lawn with
      // the odd gravel yard.
      vec3 lawn = mix(sRgb(vec3(0.36, 0.45, 0.22)), sRgb(vec3(0.31, 0.39, 0.2)), speck);
      vec3 paved = mix(sRgb(vec3(0.40, 0.38, 0.34)), sRgb(vec3(0.47, 0.45, 0.4)), fine);
      vec3 town = mix(lawn * mix(0.85, 1.1, fine), paved, smoothstep(0.82, 0.95, mid * 0.5 + speck * 0.2 + cover.g * 0.45) * 0.6);
      veg = mix(veg, town, smoothstep(0.1, 0.6, cover.g));
      float vegAmount = 1.0 - smoothstep(0.3, 0.5, slope + (mid - 0.5) * 0.35 + (fine - 0.5) * 0.12);
      // Grassy ledges hold on to the cliff faces.
      vegAmount = max(vegAmount, joints * steep * 0.7 * smoothstep(6.0, 15.0, h));
      // Exposed knobs of bedrock poke through the heath.
      vegAmount *= 1.0 - smoothstep(0.68, 0.8, sFbm(P.xz / 27.0 + 11.0)) * 0.8 * (1.0 - cover.g) * (1.0 - cover.b);
      vegAmount *= 1.0 - cover.a * 0.75;
      vegAmount *= smoothstep(1.8, 3.0, h + (mid - 0.5) * 1.5);
      vec3 colour = mix(rock, veg, vegAmount);
      sRough = mix(0.8, 0.94, vegAmount);
      vec3 zones = vec3(0.45, 0.95, 1.7);
      vec3 beachColour = sRgb(vec3(0.42, 0.39, 0.35));
    #endif
      // Beaches: shingle on gentle low ground.
      float beach = (1.0 - smoothstep(0.06, 0.16, slope)) * (1.0 - smoothstep(1.8, 3.0, h)) * smoothstep(-1.0, 0.3, h) * (1.0 - cover.g);
      colour = mix(colour, beachColour * mix(0.8, 1.12, fine), beach * 0.9);
      // Intertidal zones: rockweed, a pale barnacle line, then dark wet rock and lichen.
      float hn = h + (fine - 0.5) * 0.3 + (mid - 0.5) * 0.4;
      vec3 kelp = sRgb(vec3(0.19, 0.15, 0.07)) * mix(0.65, 1.15, fine);
      vec3 barnacle = sRgb(vec3(0.49, 0.48, 0.44)) * mix(0.75, 1.05, fine);
      vec3 wet = sRgb(vec3(0.085, 0.085, 0.08)) * mix(0.8, 1.2, fine);
      float rocky = 1.0 - beach * 0.75;
      float wetBand = 1.0 - smoothstep(zones.z, zones.z + 0.5, hn);
      colour = mix(colour, wet, wetBand * 0.8 * rocky);
      colour = mix(colour, colour * 0.55, wetBand * (1.0 - rocky));
      float barnacles = smoothstep(zones.x, zones.x + 0.2, hn) * (1.0 - smoothstep(zones.y - 0.15, zones.y, hn));
      colour = mix(colour, barnacle, barnacles * rocky * 0.85);
      colour = mix(colour, kelp, (1.0 - smoothstep(zones.x - 0.2, zones.x, hn)));
      // Under water: darker, so the shallows read through a clear sea.
      colour *= mix(0.45, 1.0, smoothstep(-5.0, -0.3, h));
      sRough = mix(sRough, 0.45, wetBand);
      // Large-scale tonal variation keeps hillsides from looking flat-painted.
      colour *= mix(0.88, 1.08, macro);
      diffuseColor.rgb = colour;
      sBump = (rn * 1.1 * (1.0 - vegAmount * 0.6) + fine * 0.3 + streaks * steep * 1.5) * mix(0.15, 1.0, nearFade);
    }
    `,
    roughness: 'roughnessFactor = sRough;',
    normal: /* glsl */ `
      normal = sPerturb(-vViewPosition, normal, vec2(dFdx(sBump), dFdy(sBump)), faceDirection);
    `,
  })
  return material
}

/** Clapboard walls with window rows, trims and corner boards from per-vertex wall coordinates. */
function wallMaterial(trimColour: T.Color) {
  const material = new T.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
  })
  patch(material, {
    key: 'scenery-walls',
    uniforms: { sTrim: { value: trimColour } },
    vertexHeader:
      'attribute vec4 aWall;\nattribute float aStyle;\nvarying vec4 vWall;\nvarying float vStyle;',
    vertexMain: 'vWall = aWall; vStyle = aStyle;',
    fragmentHeader: 'uniform vec3 sTrim;\nvarying vec4 vWall;\nvarying float vStyle;',
    colour: /* glsl */ `
    {
      // aWall: u along the wall (m), v above the ground floor (m), eave height, wall length.
      float u = vWall.x, v = vWall.y, eave = vWall.z, len = vWall.w;
      float px = max(length(fwidth(vec2(u, v))), 1e-3);
      float detail = 1.0 - smoothstep(0.05, 0.6, px);
      // Styles 10+ mark the wall facing the street (front door / storefront).
      float front = step(9.5, vStyle);
      float style = vStyle - front * 10.0;
      // 0 clapboard house, 1 commercial / apartments, 2 industrial, 3 church.
      float spacing = style < 0.5 ? 2.7 : style < 1.5 ? 2.3 : style < 2.5 ? 7.0 : 4.2;
      float ww = style < 0.5 ? 0.85 : style < 1.5 ? 1.35 : style < 2.5 ? 2.6 : 1.1;
      float wh = style < 0.5 ? 1.35 : style < 1.5 ? 1.6 : style < 2.5 ? 0.9 : 3.2;
      float sill = style < 2.5 ? 0.95 : 1.6;
      float storey = style < 2.5 ? 3.0 : 20.0;
      float cols = floor((len - 1.0) / spacing);
      float start = (len - cols * spacing) * 0.5;
      float local = u - start;
      float cu = mod(local, spacing) - spacing * 0.5;
      float inCols = step(0.0, local) * step(local, cols * spacing) * step(0.5, cols);
      float vf = v - sill;
      float row = mod(vf, storey);
      float vTop = vf - row + wh + sill;
      float inRows = step(0.0, vf) * step(vTop, eave - 0.35);
      if (style > 1.5 && style < 2.5) inRows *= step(eave - 2.6, v); // high strip windows
      float glass = inCols * inRows * step(abs(cu), ww * 0.5) * step(row, wh);
      float frame = inCols * inRows * step(abs(cu), ww * 0.5 + 0.13) * step(row, wh + 0.13);
      frame = max(frame - glass, 0.0);
      // Front door on houses: centred, or a bay off-centre; the windows in its bay give way.
      float bayIndex = floor(local / spacing);
      float doorBay = floor(cols * 0.5 - 0.01 * len);
      float isHouse = step(style, 0.5);
      float doorCu = (bayIndex == doorBay) ? cu : 99.0;
      float door = front * isHouse * step(abs(doorCu), 0.5) * step(-0.05, v) * step(v, 2.15);
      float doorFrame = front * isHouse * step(abs(doorCu), 0.64) * step(-0.05, v) * step(v, 2.3);
      doorFrame = max(doorFrame - door, 0.0);
      float groundFloor = step(v, storey - 0.4);
      glass *= 1.0 - front * isHouse * step(abs(doorCu), spacing * 0.5) * groundFloor;
      frame *= 1.0 - front * isHouse * step(abs(doorCu), spacing * 0.5) * groundFloor;
      // Shops: storefront glass along the street, a sign band above it.
      float isShop = step(0.5, style) * step(style, 1.5) * front;
      float pier = step(0.35, abs(mod(u, 4.0) - 2.0) - 1.6 + 0.35);
      float storefront = isShop * step(0.35, v) * step(v, 2.8) * (1.0 - pier) * step(0.6, u) * step(u, len - 0.6);
      float signBand = isShop * step(2.95, v) * step(v, 3.6);
      glass = max(glass * (1.0 - isShop * step(v, 3.6)), storefront);
      frame *= 1.0 - isShop * step(v, 3.6);
      // Glazing bars on house windows (two-over-two sashes).
      float bars = isHouse * glass * max(step(abs(cu), 0.035), step(abs(row - wh * 0.5), 0.035));
      // Curtains or blinds in some windows: a paler, warmer interior.
      float winId = bayIndex + floor(vf / storey) * 17.0 + floor(vSWorld.x * 0.05) * 3.0 + floor(vSWorld.z * 0.05) * 7.0;
      float curtain = step(0.55, fract(sin(winId * 12.9898) * 43758.5453)) * (1.0 - isShop);
      // Sill: a pale ledge under each window.
      float sillRow = inCols * step(abs(cu), ww * 0.5 + 0.2) * step(sill - 0.1, mod(v, storey)) * step(mod(v, storey), sill) * step(0.0, vf + 0.1) * step(v, eave - 0.6) * isHouse;
      float corner = (1.0 - step(0.16, u)) + step(len - 0.16, u);
      corner *= step(style, 0.5);
      vec3 wall = diffuseColor.rgb;
      // Clapboard shadow lines on houses; panel seams on industrial cladding.
      float board = style < 0.5 ? smoothstep(0.75, 1.0, fract(v / 0.2)) * 0.18
                  : style > 1.5 && style < 2.5 ? smoothstep(0.9, 1.0, fract(u / 0.9)) * 0.1 : 0.0;
      wall *= 1.0 - board * detail;
      wall *= mix(0.9, 1.04, sNoise(vSWorld.xz / 3.0 + vSWorld.y / 5.0));
      // Soil splash and weathering towards the ground.
      wall *= mix(0.78, 1.0, smoothstep(-0.3, 1.2, v));
      vec3 glassColour = sRgb(vec3(0.07, 0.09, 0.11));
      glassColour = mix(glassColour, sRgb(vec3(0.5, 0.46, 0.4)) * 0.45, curtain * 0.5 * step(row, wh * 0.92));
      vec3 trim = style < 0.5 || style > 2.5 ? sTrim : wall * 0.72;
      // Concrete foundation showing below the siding.
      float footing = isHouse * step(v, 0.45);
      wall = mix(wall, sRgb(vec3(0.5, 0.49, 0.46)) * mix(0.85, 1.05, sNoise(vSWorld.xz * 2.0)), footing);
      // Door colours: deep reds, navy, black, natural wood, by house.
      float dh = fract(sin(dot(floor(vSWorld.xz / 9.0), vec2(127.1, 311.7))) * 43758.5453);
      vec3 doorColour = dh < 0.25 ? sRgb(vec3(0.42, 0.08, 0.07)) : dh < 0.5 ? sRgb(vec3(0.08, 0.12, 0.22))
                      : dh < 0.75 ? sRgb(vec3(0.06, 0.06, 0.06)) : sRgb(vec3(0.36, 0.24, 0.14));
      vec3 c = wall;
      c = mix(c, trim, max(max(frame, corner), max(doorFrame, sillRow)) * detail);
      c = mix(c, glassColour, glass * detail);
      c = mix(c, trim, bars * detail);
      c = mix(c, doorColour, door * detail);
      c = mix(c, sRgb(vec3(0.1, 0.11, 0.12)), signBand * detail);
      // Plants and sheds: roll-up loading doors along long walls, a man door beside each.
      float isIndustrial = step(1.5, style) * step(style, 2.5);
      float bay = mod(u - 3.0, 16.0);
      float rollUp = isIndustrial * step(10.0, len) * step(0.0, u - 3.0) * step(u, len - 3.0)
                   * step(bay, 4.2) * step(-0.1, v) * step(v, 4.4);
      float slats = 1.0 - smoothstep(0.75, 1.0, fract(v / 0.32)) * 0.3;
      vec3 doorPanel = mix(sRgb(vec3(0.62, 0.64, 0.65)), sRgb(vec3(0.28, 0.36, 0.45)), step(0.5, dh)) * slats;
      c = mix(c, doorPanel, rollUp * detail);
      float manDoor = isIndustrial * step(10.0, len) * step(5.2, bay) * step(bay, 6.2) * step(v, 2.1) * step(u, len - 3.0);
      c = mix(c, sRgb(vec3(0.2, 0.22, 0.24)), manDoor * detail);
      // Ribbed metal cladding catches the light in vertical stripes.
      c *= 1.0 - isIndustrial * (1.0 - smoothstep(0.0, 0.08, fract(u / 0.3))) * 0.12 * detail;
      // From afar, windows average into a slightly darker wall.
      float avgGlass = inRows * (ww * wh) / (spacing * storey) * step(0.5, cols);
      c = mix(c, mix(wall, glassColour, avgGlass * 0.8), 1.0 - detail);
      diffuseColor.rgb = c;
      sRough = mix(0.85, 0.08, glass * (1.0 - bars) * detail);
    }
    `,
    roughness: 'roughnessFactor = sRough;',
  })
  return material
}

/** Vertex-coloured surfaces with world-space weathering (roofs, timber, concrete, rock). */
export function weatheredMaterial(
  key: string,
  roughness: number,
  strength = 1,
  side: T.Side = T.FrontSide,
) {
  const material = new T.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0, side })
  patch(material, {
    key: `scenery-weathered-${key}`,
    uniforms: { sStrength: { value: strength } },
    fragmentHeader: 'uniform float sStrength;',
    colour: /* glsl */ `
    {
      vec3 P = vSWorld;
      float px = max(length(fwidth(P)), 1e-3);
      float detail = 1.0 - smoothstep(0.1, 1.5, px);
      float n = sNoise3(P / 2.3) * 0.6 + mix(0.5, sNoise3(P / 0.45), detail) * 0.4;
      // Streaks running down vertical faces; grime near the ground and the waterline.
      float streak = mix(0.5, sNoise(vec2(dot(P.xz, vec2(0.7, 0.7)) * 2.3, P.y * 0.15)), detail);
      diffuseColor.rgb *= mix(1.0, mix(0.78, 1.12, n) * mix(0.9, 1.05, streak), sStrength);
      diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(-0.5, 1.4, P.y));
      sBump = n * 0.08 * detail * sStrength;
    }
    `,
    normal: /* glsl */ `
      normal = sPerturb(-vViewPosition, normal, vec2(dFdx(sBump), dFdy(sBump)), faceDirection);
    `,
  })
  return material
}

/** Roofs: asphalt shingle courses on the slopes (metal or tar on flat roofs), weathered. */
function roofMaterial() {
  const material = new T.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0,
    side: T.DoubleSide,
  })
  patch(material, {
    key: 'scenery-roofs',
    colour: /* glsl */ `
    {
      vec3 P = vSWorld;
      float px = max(length(fwidth(P)), 1e-3);
      float detail = 1.0 - smoothstep(0.04, 0.5, px);
      float pitched = smoothstep(0.08, 0.25, 1.0 - abs(vSNormal.y));
      // Courses every 0.14 m of rise, tabs staggered course to course.
      float course = P.y / 0.14;
      float row = fract(course);
      float along = dot(P.xz, normalize(vec2(-vSNormal.z, vSNormal.x) + 1e-4)) / 0.9 + floor(course) * 0.5;
      float tab = sHash(vec2(floor(along), floor(course)));
      float shingle = (0.8 + 0.2 * smoothstep(0.0, 0.18, row)) * mix(0.9, 1.08, tab);
      shingle *= 1.0 - (1.0 - smoothstep(0.0, 0.06, fract(along))) * 0.25;
      diffuseColor.rgb *= mix(1.0, shingle, pitched * detail);
      // Weathering: moss and staining in streaks, lighter sun-bleached patches.
      float n = sNoise3(P / 2.1);
      diffuseColor.rgb *= mix(0.85, 1.12, n);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.85, 0.95, 0.8), smoothstep(0.6, 0.9, sNoise(P.xz / 4.0)) * pitched * 0.5);
      sBump = (1.0 - row) * 0.02 * pitched * detail;
    }
    `,
    normal: /* glsl */ `
      normal = sPerturb(-vViewPosition, normal, vec2(dFdx(sBump), dFdy(sBump)), faceDirection);
    `,
  })
  return material
}

// ------------------------------------------------------------------------------ build

const PALETTES = {
  // Lunenburg: painted clapboard (red, ochre, blue, green, white), white trim, dark roofs.
  NS: {
    walls: [
      '#a3302a',
      '#9a2c26',
      '#c99a2e',
      '#d8b553',
      '#3b5f86',
      '#2f4d70',
      '#4f7346',
      '#efeadf',
      '#efeadf',
      '#e9e4d6',
      '#7a4a6e',
      '#c96f2d',
      '#d7cfbf',
    ],
    roofs: ['#4a4d52', '#5a5753', '#3f4246', '#5c4a3c', '#3f5546', '#6e2f28', '#55595e', '#2f3236'],
  },
  // St. John's jellybean row houses.
  NL: {
    walls: [
      '#b8352d',
      '#d9a73a',
      '#3a74a8',
      '#7a4f8c',
      '#4f8a4b',
      '#d9772e',
      '#2f8f8a',
      '#e8e1d0',
      '#c2496b',
      '#e3cf62',
      '#5aa0c8',
      '#efece4',
    ],
    roofs: ['#4a4d52', '#56595c', '#3d4044', '#5c4a3c', '#2f3236', '#5a5347'],
  },
  // Coastal BC: muted siding, metal roofs.
  BC: {
    walls: [
      '#d8d4cb',
      '#9aa3a6',
      '#c4b59a',
      '#7a8b8f',
      '#5b6e78',
      '#a89a84',
      '#efece4',
      '#6d5b4a',
      '#b9b2a2',
      '#4f6168',
    ],
    roofs: ['#4d5357', '#3f5546', '#6a3530', '#5a5d60', '#6e7479', '#34495a'],
  },
} as const
const INDUSTRIAL_WALLS = ['#c9ccce', '#e6e6e2', '#9aa1a6', '#7d8a92', '#b7c3c9', '#d5d2c8']
const INDUSTRIAL_ROOFS = ['#8e9396', '#6f767a', '#a4a8aa', '#5d6266']
const FISH_STORE = ['#962f24', '#8a2a20', '#a3382a', '#7d2a22']

function buildingStyle(kind: BuildingKind) {
  return kind === 'house' || kind === 'shed'
    ? 0
    : kind === 'industrial'
      ? 2
      : kind === 'church'
        ? 3
        : 1
}

function buildBuildings(
  meta: SceneryMeta,
  heightAt: (x: number, z: number) => number,
  /** Unit direction from a point to the nearest street (within ~40 m), if any. */
  toStreet: (x: number, z: number) => [number, number] | undefined = () => undefined,
) {
  const walls = new Mesher({ aWall: 4, aStyle: 1 })
  const roofs = new Mesher()
  const palette =
    PALETTES[
      (meta.province as keyof typeof PALETTES) in PALETTES
        ? (meta.province as keyof typeof PALETTES)
        : 'BC'
    ]
  for (const b of meta.features.buildings) {
    const ring = b.footprint
    if (ring.length < 3) continue
    const [cx, cz] = ringCentroid(ring)
    const r1 = hash2(Math.round(cx * 10), Math.round(cz * 10))
    const r2 = hash2(Math.round(cz * 7), Math.round(cx * 13))
    const nearWater = [0, 1, 2, 3].some(
      (k) => heightAt(cx + Math.cos(k * 1.57) * 28, cz + Math.sin(k * 1.57) * 28) < 0,
    )
    let wallHex: string
    let roofHex: string
    if (b.kind === 'industrial' && !(nearWater && meta.province !== 'BC' && r2 < 0.5)) {
      wallHex = pick(INDUSTRIAL_WALLS, r1)
      roofHex = pick(INDUSTRIAL_ROOFS, r2)
    } else if (
      (b.kind === 'shed' || b.kind === 'industrial') &&
      nearWater &&
      meta.province !== 'BC'
    ) {
      wallHex = pick(FISH_STORE, r1) // red ochre fish stores on the wharves
      roofHex = pick(palette.roofs, r2)
    } else if (b.kind === 'church') {
      wallHex = '#efede6'
      roofHex = pick(palette.roofs, r2)
    } else {
      wallHex = pick(palette.walls, r1)
      roofHex = pick(palette.roofs, r2)
    }
    const wallColour = colour(b.colour ?? wallHex)
    const roofColour = colour(b.roofColour ?? roofHex)
    const style = buildingStyle(b.kind)
    const box = orientedBox(ring)
    const lenU = box.maxU - box.minU,
      lenV = box.maxV - box.minV
    const rect = Math.abs(ringArea(ring)) / Math.max(box.area, 1e-6)
    const pitched = b.roof !== 'flat' && rect > 0.72 && Math.min(lenU, lenV) > 2.5
    const short = Math.min(lenU, lenV)
    const roofH = pitched ? Math.min(short * 0.42, b.height * 0.45) : 0
    const top = b.base + b.height
    const eave = top - roofH
    const parapet = pitched ? 0 : 0.35
    let ground = Infinity
    for (const [x, z] of ring) ground = Math.min(ground, heightAt(x, z))
    const bottom = Math.min(ground, b.base) - 0.4
    // The wall that faces the street gets the front door (houses) or storefront (shops).
    const street = toStreet(cx, cz)
    let frontWall = -1
    if (street) {
      let best = 0.55
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!,
          q = ring[(i + 1) % ring.length]!
        const len = Math.hypot(q[0] - p[0], q[1] - p[1])
        if (len < 2.5) continue
        const facing = ((q[1] - p[1]) / len) * street[0] - ((q[0] - p[0]) / len) * street[1]
        if (facing > best) [best, frontWall] = [facing, i]
      }
    }
    // Walls.
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!,
        q = ring[(i + 1) % ring.length]!
      const len = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (len < 0.05) continue
      const nx = (q[1] - p[1]) / len,
        nz = -(q[0] - p[0]) / len
      const yTop = eave + parapet
      const w = (u: number, y: number) => [u, y - b.base, eave - b.base, len]
      walls.quad(
        [p[0], bottom, p[1]],
        [q[0], bottom, q[1]],
        [q[0], yTop, q[1]],
        [p[0], yTop, p[1]],
        wallColour,
        [nx, 0, nz],
        {
          aWall: [w(0, bottom), w(len, bottom), w(len, yTop), w(0, yTop)],
          aStyle: Array(4).fill([style + (i === frontWall ? 10 : 0)]),
        },
      )
    }
    if (!pitched) {
      cap(roofs, ring, top - 0.05, roofColour)
      continue
    }
    // Pitched roof on the oriented box, ridge along the long axis, 0.35 m overhang.
    const alongU = lenU >= lenV
    const U = alongU ? [box.ux, box.uz] : [-box.uz, box.ux]
    const V = alongU ? [-box.uz, box.ux] : [-box.ux, -box.uz]
    const [a0, a1] = alongU ? [box.minU, box.maxU] : [box.minV, box.maxV]
    const [b0, b1] = alongU ? [box.minV, box.maxV] : [-box.maxU, -box.minU]
    // When swapped the ridge runs along v; the across axis is −u (coordinate −u).
    const at = (s: number, t: number, y: number): V3 => [
      U[0]! * s + V[0]! * t,
      y,
      U[1]! * s + V[1]! * t,
    ]
    const half = (b1 - b0) / 2
    const mid = (b0 + b1) / 2
    const o = 0.35
    const slope = roofH / half
    const eaveLow = eave - o * slope
    const ridgeY = eave + roofH
    if (b.roof === 'hip') {
      const inset = Math.min(half, (a1 - a0) / 2)
      const r0 = a0 + inset,
        r1 = a1 - inset
      const e: V3[] = [
        at(a0 - o, b0 - o, eaveLow),
        at(a1 + o, b0 - o, eaveLow),
        at(a1 + o, b1 + o, eaveLow),
        at(a0 - o, b1 + o, eaveLow),
      ]
      const ra = at(r0, mid, ridgeY),
        rb = at(r1, mid, ridgeY)
      const facing = (x: number, z: number): V3 => [x, 1.2, z]
      roofs.quad(e[0]!, e[1]!, rb, ra, roofColour, facing(-V[0]!, -V[1]!))
      roofs.quad(e[2]!, e[3]!, ra, rb, roofColour, facing(V[0]!, V[1]!))
      roofs.tri(e[3]!, e[0]!, ra, roofColour, facing(-U[0]!, -U[1]!))
      roofs.tri(e[1]!, e[2]!, rb, roofColour, facing(U[0]!, U[1]!))
    } else {
      const vn: V3 = [V[0]!, 0, V[1]!]
      roofs.quad(
        at(a0 - o, b0 - o, eaveLow),
        at(a1 + o, b0 - o, eaveLow),
        at(a1 + o, mid, ridgeY),
        at(a0 - o, mid, ridgeY),
        roofColour,
        [-vn[0], 1, -vn[2]],
      )
      roofs.quad(
        at(a0 - o, b1 + o, eaveLow),
        at(a1 + o, b1 + o, eaveLow),
        at(a1 + o, mid, ridgeY),
        at(a0 - o, mid, ridgeY),
        roofColour,
        [vn[0], 1, vn[2]],
      )
      // Gable ends belong to the walls (same paint, no windows above the eave).
      for (const [s, sign] of [
        [a0, -1],
        [a1, 1],
      ] as const) {
        const p = at(s, b0, eave),
          q = at(s, b1, eave),
          r = at(s, mid, ridgeY)
        const w = (t: number, y: number) => [t, y - b.base, eave - b.base, b1 - b0]
        walls.tri(p, q, r, wallColour, [U[0]! * sign, 0, U[1]! * sign], {
          aWall: [w(0, eave), w(b1 - b0, eave), w(half, ridgeY)],
          aStyle: [[style], [style], [style]],
        })
      }
    }
    // A chimney on houses: brick or concrete, a quarter of the way along the ridge.
    if (style === 0 && b.kind === 'house' && r2 > 0.15) {
      const s0 = a0 + (a1 - a0) * (r1 < 0.5 ? 0.22 : 0.78)
      const [x, , z] = at(s0, mid + (r1 - 0.5) * half * 0.6, 0)
      const brick = colour(r2 < 0.6 ? '#7a3b2e' : '#8f8b84')
      roofs.cylinder(x, z, eave, ridgeY + 0.9, 0.42, 0.42, 4, brick)
      roofs.cylinder(x, z, ridgeY + 0.9, ridgeY + 1.0, 0.5, 0.5, 4, colour('#55524e'))
    }
  }
  return { walls, roofs }
}

function buildPiers(meta: SceneryMeta, heightAt: (x: number, z: number) => number) {
  const m = new Mesher()
  const timber = colour('#6f6253'),
    concrete = colour('#8f8c86'),
    floatDeck = colour('#6f675b'),
    pontoon = colour('#2a2b2c'),
    pile = colour('#3b3128'),
    pileWet = colour('#1c1a16'),
    fascia = colour('#4a4036'),
    tyre = colour('#141414'),
    bollard = colour('#1d1f21'),
    rail = colour('#5a4a3a')
  const rnd = mulberry32(meta.features.piers.length * 7919 + 13)
  for (const pier of meta.features.piers) {
    const ring = pier.polygon
    if (ring.length < 3) continue
    const area = Math.abs(ringArea(ring))
    const big = area > 3000
    const deck = pier.deckHeight
    const thick = pier.floating ? 0.85 : 0.55
    const deckColour = pier.floating ? floatDeck : big || area > 1200 ? concrete : timber
    cap(m, ring, deck, deckColour)
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!,
        q = ring[(i + 1) % ring.length]!
      const len = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (len < 0.05) continue
      const ux = (q[0] - p[0]) / len,
        uz = (q[1] - p[1]) / len
      const nx = uz,
        nz = -ux
      const lower = pier.floating ? deck - thick : big ? -4 : deck - thick
      m.quad(
        [p[0], lower, p[1]],
        [q[0], lower, q[1]],
        [q[0], deck, q[1]],
        [p[0], deck, p[1]],
        pier.floating ? pontoon : big ? concrete : fascia,
        [nx, 0, nz],
      )
      // Is this face on open water? (Probe 2 m out.)
      const mx = (p[0] + q[0]) / 2 + nx * 2.5,
        mz = (p[1] + q[1]) / 2 + nz * 2.5
      const water = heightAt(mx, mz) < -0.5 && !pointInRing(mx, mz, ring)
      // Piles along the edges of timber wharves.
      if (!pier.floating && !big) {
        const n = Math.max(1, Math.round(len / 2.8))
        for (let k = 0; k <= n; k++) {
          if (k === n && i < ring.length - 1) continue
          const x = p[0] + (ux * (len * k)) / n - nx * 0.15,
            z = p[1] + (uz * (len * k)) / n - nz * 0.15
          const ground = Math.min(heightAt(x, z), -0.5)
          m.cylinder(x, z, ground - 1, 1.1, 0.2, 0.19, 6, pileWet, false)
          m.cylinder(x, z, 1.1, deck - thick + 0.05, 0.19, 0.18, 6, pile, false)
        }
      }
      if (!water || len < 2) continue
      if (!pier.floating) {
        // Timber bull rail along the edge.
        const ix = -nx * 0.2,
          iz = -nz * 0.2
        m.quad(
          [p[0] + ix, deck, p[1] + iz],
          [q[0] + ix, deck, q[1] + iz],
          [q[0] + ix, deck + 0.22, q[1] + iz],
          [p[0] + ix, deck + 0.22, p[1] + iz],
          rail,
          [nx, 0, nz],
        )
        m.quad(
          [p[0] + ix * 2.2, deck + 0.22, p[1] + iz * 2.2],
          [q[0] + ix * 2.2, deck + 0.22, q[1] + iz * 2.2],
          [q[0] + ix, deck + 0.22, q[1] + iz],
          [p[0] + ix, deck + 0.22, p[1] + iz],
          rail,
          [0, 1, 0],
        )
        // Tyre fenders hanging on the face, bollards on the deck.
        for (let s = 2.5; s < len - 1; s += 5.5 + rnd() * 2) {
          const x = p[0] + ux * s + nx * 0.22,
            z = p[1] + uz * s + nz * 0.22
          addTyre(m, x, deck - 1.0 - rnd() * 0.4, z, ux, uz, tyre)
        }
        for (let s = 4; s < len - 2; s += 11 + rnd() * 3) {
          const x = p[0] + ux * s - nx * 0.75,
            z = p[1] + uz * s - nz * 0.75
          m.cylinder(x, z, deck, deck + 0.5, 0.16, 0.16, 8, bollard, false)
          m.cylinder(x, z, deck + 0.5, deck + 0.6, 0.24, 0.24, 8, bollard, true)
        }
      } else {
        // Floats: cleats and a rubbing strip.
        m.quad(
          [p[0] + nx * 0.06, deck - 0.25, p[1] + nz * 0.06],
          [q[0] + nx * 0.06, deck - 0.25, q[1] + nz * 0.06],
          [q[0] + nx * 0.06, deck - 0.02, q[1] + nz * 0.06],
          [p[0] + nx * 0.06, deck - 0.02, p[1] + nz * 0.06],
          rail,
          [nx, 0, nz],
        )
        for (let s = 3; s < len - 1; s += 6 + rnd() * 2) {
          const x = p[0] + ux * s - nx * 0.3,
            z = p[1] + uz * s - nz * 0.3
          m.cylinder(x, z, deck, deck + 0.18, 0.1, 0.1, 6, bollard, true)
        }
      }
    }
  }
  return m
}

function addTyre(m: Mesher, x: number, y: number, z: number, ux: number, uz: number, rgb: T.Color) {
  // A tyre hanging flat against the wharf face: ring in the face plane (along u and up).
  const R = 0.38,
    r = 0.13,
    seg = 8,
    tube = 4
  const nx = uz,
    nz = -ux
  const point = (a: number, b: number): V3 => {
    const cx = Math.cos(a) * (R + Math.cos(b) * r),
      cy = Math.sin(a) * (R + Math.cos(b) * r)
    const off = Math.sin(b) * r
    return [x + ux * cx + nx * off, y + cy, z + uz * cx + nz * off]
  }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < tube; j++) {
      const a0 = (i / seg) * Math.PI * 2,
        a1 = ((i + 1) / seg) * Math.PI * 2
      const b0 = (j / tube) * Math.PI * 2,
        b1 = ((j + 1) / tube) * Math.PI * 2
      const am = (a0 + a1) / 2,
        bm = (b0 + b1) / 2
      const out: V3 = [
        ux * Math.cos(am) * Math.cos(bm) + nx * Math.sin(bm),
        Math.sin(am) * Math.cos(bm),
        uz * Math.cos(am) * Math.cos(bm) + nz * Math.sin(bm),
      ]
      m.quad(point(a0, b0), point(a1, b0), point(a1, b1), point(a0, b1), rgb, out)
    }
}

function buildBreakwaters(meta: SceneryMeta) {
  const m = new Mesher()
  const rnd = mulberry32(4242)
  const stone = new T.IcosahedronGeometry(1, 0)
  const matrix = new T.Matrix4()
  const shades = ['#6d6a66', '#7c7873', '#5b5955', '#8a857e', '#66625c'].map(colour)
  for (const bw of meta.features.breakwaters) {
    const ring = bw.polygon
    if (ring.length < 3) continue
    const top = bw.height
    cap(m, ring, top, shades[0]!)
    // Rubble slopes down to the sea floor, splayed outwards.
    const out: XZ[] = ring.map((p, i) => {
      const prev = ring[(i + ring.length - 1) % ring.length]!,
        next = ring[(i + 1) % ring.length]!
      const e1 = [p[0] - prev[0], p[1] - prev[1]],
        e2 = [next[0] - p[0], next[1] - p[1]]
      const l1 = Math.hypot(e1[0]!, e1[1]!) || 1,
        l2 = Math.hypot(e2[0]!, e2[1]!) || 1
      let nx = e1[1]! / l1 + e2[1]! / l2,
        nz = -e1[0]! / l1 - e2[0]! / l2
      const nl = Math.hypot(nx, nz) || 1
      nx /= nl
      nz /= nl
      return [p[0] + nx * 6, p[1] + nz * 6]
    })
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length
      const a = ring[i]!,
        b = ring[j]!,
        c = out[j]!,
        d = out[i]!
      const nx = b[1] - a[1],
        nz = -(b[0] - a[0])
      m.quad([a[0], top, a[1]], [b[0], top, b[1]], [c[0], -5, c[1]], [d[0], -5, d[1]], shades[1]!, [
        nx,
        0.6,
        nz,
      ])
      // Armour stones on the crest edge and slope.
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      for (let s = 0; s < len; s += 1.6) {
        for (const depth of [0.2, 0.55]) {
          const t = s / len
          const x = a[0] + (b[0] - a[0]) * t,
            z = a[1] + (b[1] - a[1]) * t
          const ox = d[0] + (c[0] - d[0]) * t - x,
            oz = d[1] + (c[1] - d[1]) * t - z
          const size = 0.7 + rnd() * 0.8
          const y = top - depth * (top + 5) + 0.2
          if (y < -1.5) continue
          matrix.compose(
            new T.Vector3(x + ox * depth + (rnd() - 0.5), y, z + oz * depth + (rnd() - 0.5)),
            new T.Quaternion().setFromEuler(new T.Euler(rnd() * 3, rnd() * 3, rnd() * 3)),
            new T.Vector3(size * (0.8 + rnd() * 0.5), size * 0.7, size * (0.8 + rnd() * 0.5)),
          )
          m.geometry(stone, matrix, pick(shades, rnd()))
        }
      }
    }
  }
  stone.dispose()
  return m
}

function buildLandmarks(meta: SceneryMeta) {
  const m = new Mesher()
  const white = colour('#eeece6'),
    red = colour('#a3241c'),
    glass = colour('#1d2a2e'),
    dark = colour('#2a2a2a'),
    stone = colour('#8d8577'),
    stoneDark = colour('#6f685d')
  for (const l of meta.features.landmarks) {
    const y = l.base
    if (l.kind === 'lighthouse') {
      const H = l.height
      m.cylinder(l.x, l.z, y - 1, y + H * 0.78, 1.9, 1.35, 12, white)
      m.cylinder(l.x, l.z, y + H * 0.78, y + H * 0.82, 1.35, 1.35, 12, red)
      // Gallery and lantern.
      m.cylinder(l.x, l.z, y + H * 0.82, y + H * 0.82 + 0.25, 2.1, 2.1, 12, red)
      m.cylinder(l.x, l.z, y + H * 0.82 + 0.25, y + H * 0.82 + 1.0, 2.05, 2.05, 16, dark, false)
      m.cylinder(l.x, l.z, y + H * 0.82 + 0.25, y + H * 0.82 + 2.1, 1.0, 1.0, 10, glass)
      m.cylinder(l.x, l.z, y + H * 0.82 + 2.1, y + H * 0.82 + 3.0, 1.15, 0.05, 10, red, false)
      continue
    }
    // Stone tower with a crenellated parapet and a taller corner turret (Cabot Tower).
    const ring: XZ[] =
      l.footprint && l.footprint.length >= 3
        ? l.footprint
        : [
            [l.x - 5.5, l.z - 4],
            [l.x + 5.5, l.z - 4],
            [l.x + 5.5, l.z + 4],
            [l.x - 5.5, l.z + 4],
          ]
    const box = orientedBox(ring)
    const U = [box.ux, box.uz],
      V = [-box.uz, box.ux]
    const corner = (u: number, v: number): XZ => [U[0]! * u + V[0]! * v, U[1]! * u + V[1]! * v]
    const rect: XZ[] = [
      corner(box.minU, box.minV),
      corner(box.maxU, box.minV),
      corner(box.maxU, box.maxV),
      corner(box.minU, box.maxV),
    ]
    const top = y + l.height * 0.8
    const edges = ringArea(rect) > 0 ? rect : rect.slice().reverse()
    for (let i = 0; i < 4; i++) {
      const p = edges[i]!,
        q = edges[(i + 1) % 4]!
      const len = Math.hypot(q[0] - p[0], q[1] - p[1])
      const ux = (q[0] - p[0]) / len,
        uz = (q[1] - p[1]) / len
      const nx = uz,
        nz = -ux
      m.quad(
        [p[0], y - 2, p[1]],
        [q[0], y - 2, q[1]],
        [q[0], top, q[1]],
        [p[0], top, p[1]],
        stone,
        [nx, 0, nz],
      )
      // String course and merlons.
      m.quad(
        [p[0] + nx * 0.15, top - 0.6, p[1] + nz * 0.15],
        [q[0] + nx * 0.15, top - 0.6, q[1] + nz * 0.15],
        [q[0] + nx * 0.15, top, q[1] + nz * 0.15],
        [p[0] + nx * 0.15, top, p[1] + nz * 0.15],
        stoneDark,
        [nx, 0, nz],
      )
      const count = Math.max(2, Math.round(len / 1.5))
      for (let k = 0; k < count; k += 2) {
        const s0 = (k / count) * len,
          s1 = ((k + 1) / count) * len
        const box3 = (s: number) => [p[0] + ux * s, p[1] + uz * s] as const
        const [x0, z0] = box3(s0),
          [x1, z1] = box3(s1)
        const ix = -nx * 0.55,
          iz = -nz * 0.55
        const yb = top,
          yt = top + 0.9
        m.quad([x0, yb, z0], [x1, yb, z1], [x1, yt, z1], [x0, yt, z0], stone, [nx, 0, nz])
        m.quad(
          [x0 + ix, yt, z0 + iz],
          [x1 + ix, yt, z1 + iz],
          [x1, yt, z1],
          [x0, yt, z0],
          stone,
          [0, 1, 0],
        )
        m.quad(
          [x0 + ix, yb, z0 + iz],
          [x1 + ix, yb, z1 + iz],
          [x1 + ix, yt, z1 + iz],
          [x0 + ix, yt, z0 + iz],
          stoneDark,
          [-nx, 0, -nz],
        )
        m.quad(
          [x0, yb, z0],
          [x0 + ix, yb, z0 + iz],
          [x0 + ix, yt, z0 + iz],
          [x0, yt, z0],
          stoneDark,
          [-ux, 0, -uz],
        )
        m.quad(
          [x1, yb, z1],
          [x1 + ix, yb, z1 + iz],
          [x1 + ix, yt, z1 + iz],
          [x1, yt, z1],
          stoneDark,
          [ux, 0, uz],
        )
      }
    }
    cap(m, edges, top - 0.4, stoneDark)
    // Turret on the seaward corner: octagonal, taller, its own merlons.
    const tc = corner(box.maxU - 1.6, box.minV + 1.6)
    const tTop = y + l.height
    m.cylinder(tc[0], tc[1], y - 2, tTop, 2.3, 2.3, 8, stone)
    for (let k = 0; k < 8; k += 2) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8
      m.cylinder(
        tc[0] + Math.cos(a) * 1.9,
        tc[1] + Math.sin(a) * 1.9,
        tTop,
        tTop + 0.85,
        0.42,
        0.42,
        4,
        stone,
      )
    }
    m.cylinder(tc[0], tc[1], tTop, tTop + 6, 0.06, 0.04, 4, dark, false) // flagpole
  }
  return m
}

/**
 * Unit conifer (height 1): three star-offset tiers with drooping undersides, normals that
 * lean outwards (a soft crown, not a faceted cone), darker inside and below. 30 triangles.
 */
function coniferGeometry(slender: number) {
  const pos: number[] = [],
    nrm: number[] = [],
    col: number[] = []
  const sides = 5
  const tiers: [number, number, number, number][] = [
    [0.05, 0.6, 0.5, 0],
    [0.33, 0.83, 0.37, 0.6],
    [0.58, 1.0, 0.23, 1.3],
  ]
  const push = (p: V3, n: V3, shade: number) => {
    pos.push(p[0], p[1], p[2])
    const l = Math.hypot(n[0], n[1], n[2])
    nrm.push(n[0] / l, n[1] / l, n[2] / l)
    col.push(shade, shade, shade)
  }
  for (const [y0, apex, radius, twist] of tiers) {
    const r = radius * slender
    const ring: V3[] = []
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2 + twist
      const rr = r * (k % 2 ? 0.86 : 1)
      ring.push([Math.cos(a) * rr, y0 + (k % 2 ? 0.02 : 0), Math.sin(a) * rr])
    }
    const under: V3 = [0, y0 + (apex - y0) * 0.22, 0]
    for (let k = 0; k < sides; k++) {
      const a = ring[k]!,
        b = ring[(k + 1) % sides]!
      // Outer skin (counter-clockwise seen from outside).
      push(a, [a[0], r * 0.9, a[2]], 0.5 + y0 * 0.4)
      push([0, apex, 0], [0, 1, 0], 1.0)
      push(b, [b[0], r * 0.9, b[2]], 0.5 + y0 * 0.4)
      // Drooping underside, in shadow.
      push(b, [b[0] * 0.4, -r, b[2] * 0.4], 0.3)
      push(under, [0, -1, 0], 0.2)
      push(a, [a[0] * 0.4, -r, a[2] * 0.4], 0.3)
    }
  }
  const g = new T.BufferGeometry()
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3))
  g.setAttribute('color', new T.Float32BufferAttribute(col, 3))
  return g
}

/** Low dome for scrub and tuckamore (20 triangles). */
function bushGeometry() {
  const g = new T.IcosahedronGeometry(0.5, 0)
  g.translate(0, 0.32, 0)
  const pos = g.attributes.position!
  const col = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) col.fill(0.55 + pos.getY(i) * 0.9, i * 3, i * 3 + 3)
  g.setAttribute('color', new T.BufferAttribute(col, 3))
  g.computeVertexNormals()
  return g
}

/** Broadleaf street/garden tree: lumpy crown on a trunk (unit height, ~28 triangles). */
function broadleafGeometry() {
  const crown = new T.IcosahedronGeometry(0.5, 0)
  const p = crown.attributes.position!
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i)
    const j = 0.85 + hash2(Math.round(x * 50), Math.round(z * 50 + y * 30)) * 0.3
    p.setXYZ(i, x * j, y * j * 0.9, z * j)
  }
  crown.translate(0, 0.6, 0)
  const trunk = new T.CylinderGeometry(0.035, 0.05, 0.4, 4, 1, true)
  trunk.translate(0, 0.2, 0)
  const merged = mergeGeometries([crown, trunk.toNonIndexed()], false)!
  crown.dispose()
  trunk.dispose()
  merged.computeVertexNormals()
  const pos = merged.attributes.position!
  const nrm = merged.attributes.normal!
  const col = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const isTrunk = y < 0.4 && Math.hypot(pos.getX(i), pos.getZ(i)) < 0.06
    if (!isTrunk) {
      // Rounded crown normals (from the crown centre) light like foliage, not facets.
      const n = new T.Vector3(pos.getX(i), (y - 0.6) * 1.1 + 0.15, pos.getZ(i)).normalize()
      nrm.setXYZ(i, n.x, n.y, n.z)
    }
    const s = isTrunk ? 0.35 : 0.55 + (y - 0.3) * 0.7
    col.set(isTrunk ? [0.4, 0.3, 0.22] : [s, s, s], i * 3)
  }
  merged.setAttribute('color', new T.BufferAttribute(col, 3))
  return merged
}

interface Grid {
  n: number
  cell: number
  half: number
  heights: Float32Array
}

function buildTerrain(grid: Grid, material: T.Material, shadows: boolean) {
  const { n, cell, half, heights } = grid
  const meshes: T.Mesh[] = []
  // Normals from central differences on the full grid, so chunk seams match.
  const normals = new Float32Array(n * n * 3)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      const hx = heights[j * n + Math.min(n - 1, i + 1)]! - heights[j * n + Math.max(0, i - 1)]!
      const hz = heights[Math.min(n - 1, j + 1) * n + i]! - heights[Math.max(0, j - 1) * n + i]!
      const nx = -hx / (2 * cell),
        nz = -hz / (2 * cell)
      const l = Math.hypot(nx, 1, nz)
      normals[c * 3] = nx / l
      normals[c * 3 + 1] = 1 / l
      normals[c * 3 + 2] = nz / l
    }
  const chunks = 4
  const span = (n - 1) / chunks
  for (let cj = 0; cj < chunks; cj++)
    for (let ci = 0; ci < chunks; ci++) {
      const i0 = ci * span,
        j0 = cj * span
      const side = span + 1
      const pos: number[] = [],
        nrm: number[] = [],
        index: number[] = []
      for (let j = 0; j < side; j++)
        for (let i = 0; i < side; i++) {
          const gi = i0 + i,
            gj = j0 + j
          const c = gj * n + gi
          pos.push(-half + gi * cell, heights[c]!, -half + gj * cell)
          nrm.push(normals[c * 3]!, normals[c * 3 + 1]!, normals[c * 3 + 2]!)
        }
      for (let j = 0; j < span; j++)
        for (let i = 0; i < span; i++) {
          const a = j * side + i,
            b = a + 1,
            c = a + side,
            d = c + 1
          // Split along the shorter diagonal-ish: alternate for less directional artefacts.
          if ((i + j) % 2 === 0) index.push(a, c, b, b, c, d)
          else index.push(a, c, d, a, d, b)
        }
      // Skirts on the outer edges hide the cut at the scene boundary.
      const skirt = (edge: number[], outward: V3) => {
        for (let k = 0; k + 1 < edge.length; k++) {
          const a = edge[k]!,
            b = edge[k + 1]!
          const base = pos.length / 3
          for (const v of [a, b]) {
            pos.push(pos[v * 3]!, -120, pos[v * 3 + 2]!)
            nrm.push(outward[0], outward[1], outward[2])
          }
          // Winding chosen so the skirt faces outwards.
          const ax = pos[a * 3]!,
            az = pos[a * 3 + 2]!,
            bx = pos[b * 3]!,
            bz = pos[b * 3 + 2]!
          const cross = (bx - ax) * outward[2] - (bz - az) * outward[0]
          if (cross > 0) index.push(a, base, b, b, base, base + 1)
          else index.push(a, b, base, b, base + 1, base)
        }
      }
      const row = (j: number) => Array.from({ length: side }, (_, i) => j * side + i)
      const col = (i: number) => Array.from({ length: side }, (_, j) => j * side + i)
      if (cj === 0) skirt(row(0), [0, 0, -1])
      if (cj === chunks - 1) skirt(row(side - 1), [0, 0, 1])
      if (ci === 0) skirt(col(0), [-1, 0, 0])
      if (ci === chunks - 1) skirt(col(side - 1), [1, 0, 0])
      const g = new T.BufferGeometry()
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3))
      g.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3))
      g.setIndex(index)
      g.computeBoundingSphere()
      g.computeBoundingBox()
      const mesh = new T.Mesh(g, material)
      mesh.castShadow = shadows
      mesh.receiveShadow = shadows
      mesh.name = `terrain-${ci}-${cj}`
      meshes.push(mesh)
    }
  return meshes
}

/**
 * Coarse apron around the grid: edge heights continue outwards and sink below the sea over
 * a few kilometres, so hills do not end in a cliff at the scene boundary.
 */
function buildApron(grid: Grid, heightAt: (x: number, z: number) => number, material: T.Material) {
  const { half } = grid
  const size = half * 2
  const step = size / 64
  const reach = Math.min(4000, size * 0.6)
  const k = Math.ceil(reach / step)
  const side = 64 + 2 * k + 1
  const pos: number[] = [],
    index: number[] = []
  for (let j = 0; j < side; j++)
    for (let i = 0; i < side; i++) {
      const x = -half + (i - k) * step,
        z = -half + (j - k) * step
      const cx = Math.min(half, Math.max(-half, x)),
        cz = Math.min(half, Math.max(-half, z))
      const d = Math.hypot(x - cx, z - cz)
      const edge = heightAt(cx * 0.9999, cz * 0.9999)
      const f = Math.max(0, 1 - d / reach)
      const y = edge > 0 ? edge * f * f * (0.6 + 0.4 * f) - 8 * (1 - f) : edge - d * 0.01
      pos.push(x, d > 0 ? y : edge, z)
    }
  const inside = (i: number, j: number) => i >= k && i <= k + 64 && j >= k && j <= k + 64
  for (let j = 0; j < side - 1; j++)
    for (let i = 0; i < side - 1; i++) {
      if (inside(i, j) && inside(i + 1, j + 1)) continue
      const a = j * side + i,
        b = a + 1,
        c = a + side,
        d = c + 1
      index.push(a, c, b, b, c, d)
    }
  const g = new T.BufferGeometry()
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3))
  g.setIndex(index)
  g.computeVertexNormals()
  g.computeBoundingSphere()
  const mesh = new T.Mesh(g, material)
  mesh.name = 'terrain-apron'
  mesh.receiveShadow = true
  return mesh
}

/**
 * Shading mask (RGBA8, same extent as the land-cover raster): R woodland, G built-up,
 * B grass/park, A bare rock (1) or beach (0.5). Pacific scenes default to forest.
 */
function coverMask(meta: SceneryMeta, cover: Uint8Array) {
  const n = meta.landcover.size
  const k = meta.landcover.classes
  const half = meta.sizeM / 2
  const cell = meta.sizeM / (n - 1)
  const pacific = meta.forest === 'dense-conifer'
  const rgba = new Float32Array(n * n * 4)
  // Building density lifts the built-up channel (OSM residential areas are patchy).
  const density = new Float32Array(n * n)
  for (const b of meta.features.buildings) {
    const [x, z] = ringCentroid(b.footprint)
    const i = Math.round((x + half) / cell),
      j = Math.round((z + half) / cell)
    if (i < 0 || j < 0 || i >= n || j >= n) continue
    density[j * n + i]! += Math.abs(ringArea(b.footprint)) / (cell * cell)
  }
  for (let c = 0; c < n * n; c++) {
    const cls = cover[c]!
    let r = 0,
      g = 0,
      b = 0,
      a = 0
    if (cls === k.wood) r = 1
    else if (cls === k.scrub) r = 0.45
    else if (cls === k.wetland) r = 0.15
    if (cls === k.residential) {
      g = 0.75
      b = 0.4
    } else if (cls === k.industrial) g = 1
    else if (cls === k.grass) b = 1
    if (cls === k.rock) a = 1
    else if (cls === k.beach) a = 0.5
    if (pacific && cls !== k.rock && cls !== k.beach && cls !== k.grass && cls !== k.wetland)
      r = Math.max(r, 1 - g)
    rgba[c * 4] = r
    rgba[c * 4 + 1] = g
    rgba[c * 4 + 2] = b
    rgba[c * 4 + 3] = a
  }
  // Spread building density (3×3), then blur everything twice for soft edges.
  for (let j = 1; j < n - 1; j++)
    for (let i = 1; i < n - 1; i++) {
      let d = 0
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) d += density[(j + dj) * n + i + di]!
      const c = j * n + i
      rgba[c * 4 + 1] = Math.max(rgba[c * 4 + 1]!, Math.min(1, (d / 9) * 5))
    }
  const tmp = new Float32Array(rgba.length)
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++)
        for (let ch = 0; ch < 4; ch++) {
          let s = 0,
            w = 0
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              const ii = i + di,
                jj = j + dj
              if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue
              const wt = di === 0 && dj === 0 ? 4 : di === 0 || dj === 0 ? 2 : 1
              s += rgba[(jj * n + ii) * 4 + ch]! * wt
              w += wt
            }
          tmp[(j * n + i) * 4 + ch] = s / w
        }
    rgba.set(tmp)
  }
  const bytes = new Uint8Array(n * n * 4)
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Math.round(Math.min(1, Math.max(0, rgba[i]!)) * 255)
  const texture = new T.DataTexture(bytes, n, n, T.RGBAFormat, T.UnsignedByteType)
  texture.magFilter = T.LinearFilter
  texture.minFilter = T.LinearFilter
  texture.wrapS = texture.wrapT = T.ClampToEdgeWrapping
  texture.needsUpdate = true
  const sample = (x: number, z: number) => {
    const i = Math.min(n - 1, Math.max(0, Math.round((x + half) / cell))),
      j = Math.min(n - 1, Math.max(0, Math.round((z + half) / cell)))
    const c = (j * n + i) * 4
    return [rgba[c]!, rgba[c + 1]!, rgba[c + 2]!, rgba[c + 3]!] as const
  }
  return {
    texture,
    bounds: new T.Vector4(-half - cell / 2, -half - cell / 2, meta.sizeM + cell, 0),
    sample,
  }
}

interface TreeSet {
  meshes: T.InstancedMesh[]
  count: number
}

type TreeKind = 0 | 1 | 2 // conifer, scrub, broadleaf

function buildTrees(
  meta: SceneryMeta,
  grid: Grid,
  heightAt: (x: number, z: number) => number,
  coverAt: (x: number, z: number) => readonly [number, number, number, number],
  density: number,
  shadows: boolean,
  /** Extra no-tree areas (road corridors, parking lots). */
  extraRings: XZ[][] = [],
): TreeSet {
  const pacific = meta.forest === 'dense-conifer'
  const harbour = meta.type === 'harbour'
  const half = meta.sizeM / 2
  // Exclusion raster: buildings, wharves, breakwaters, lakes and landmarks (with a margin).
  const ex = 1024,
    exCell = meta.sizeM / (ex - 1)
  const blocked = new Uint8Array(ex * ex)
  const rings = [
    ...meta.features.buildings.map((b) => b.footprint),
    ...meta.features.piers.map((p) => p.polygon),
    ...meta.features.lakes.map((l) => l.polygon),
    ...meta.features.breakwaters.map((b) => b.polygon),
    ...extraRings,
  ]
  for (const ring of rings) fillPolygon(ring, ex, -half, exCell, (c) => (blocked[c] = 1))
  // Thin structures (narrow footprints) may cover no cell centre: mark their vertices too.
  for (const ring of rings)
    for (const [x, z] of ring) {
      const i = Math.round((x + half) / exCell),
        j = Math.round((z + half) / exCell)
      if (i >= 0 && j >= 0 && i < ex && j < ex) blocked[j * ex + i] = 1
    }
  for (const l of meta.features.landmarks) {
    const i = Math.round((l.x + half) / exCell),
      j = Math.round((l.z + half) / exCell)
    for (let dj = -6; dj <= 6; dj++)
      for (let di = -6; di <= 6; di++) {
        const ii = i + di,
          jj = j + dj
        if (ii >= 0 && jj >= 0 && ii < ex && jj < ex) blocked[jj * ex + ii] = 1
      }
  }
  const margin = Math.max(1, Math.round(6 / exCell))
  const near = (x: number, z: number) => {
    const i = Math.round((x + half) / exCell),
      j = Math.round((z + half) / exCell)
    for (let dj = -margin; dj <= margin; dj++)
      for (let di = -margin; di <= margin; di++) {
        const ii = i + di,
          jj = j + dj
        if (ii >= 0 && jj >= 0 && ii < ex && jj < ex && blocked[jj * ex + ii]) return true
      }
    return false
  }
  const slopeAt = (x: number, z: number) => {
    const e = grid.cell
    const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e)
    const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e)
    return Math.hypot(dx, dz) // tan of the slope angle
  }
  const spacing = pacific ? 7 : 5
  const budgets = [
    (pacific ? 40000 : meta.province === 'NS' ? 9000 : 7000) * density,
    (pacific ? 0 : 6000) * density,
    (pacific ? 600 : meta.province === 'NS' ? 2500 : 1200) * density,
  ]
  const rnd = mulberry32(meta.id.length * 1013 + Math.round(meta.sizeM))
  const xs: number[] = [],
    zs: number[] = [],
    ps: number[] = [],
    kinds: TreeKind[] = []
  const sums = [0, 0, 0]
  for (let z = -half + spacing / 2; z < half; z += spacing)
    for (let x = -half + spacing / 2; x < half; x += spacing) {
      const px = x + (rnd() - 0.5) * spacing * 0.9,
        pz = z + (rnd() - 0.5) * spacing * 0.9
      const h = heightAt(px, pz)
      if (h < 2.5) continue
      const d = Math.hypot(px - meta.boat.x, pz - meta.boat.z)
      // Full density near the boat; thinner far away, where the terrain shader carries it.
      let distance = d < 1600 ? 1 : Math.pow(1600 / d, 1.4)
      // Working waterfronts are cleared around the berth.
      if (harbour) distance *= 0.2 + 0.8 * smooth(90, 320, d)
      const [wood, built, grass, bare] = coverAt(px, pz)
      const slope = slopeAt(px, pz)
      const clump = fbm(px / 60, pz / 60)
      const town = smooth(0.12, 0.4, built) * (1 - smooth(0.75, 1, built))
      let conifer = 0,
        scrub = 0,
        broad = 0
      if (pacific) {
        if (h > 1250 || slope > 2.2) continue
        const clearings = smooth(0.2, 0.34, fbm(px / 300 + 5, pz / 300 + 2))
        conifer = wood * (1 - built * 0.9) * (1 - bare) * clearings * (1 - smooth(1.3, 2.2, slope))
        conifer *= smooth(3.5, 7, h)
        broad = town * 0.25
      } else {
        if (slope > 0.75) continue
        const exposed = 1 - smooth(0.25, 0.75, slope)
        const tuck = smooth(0.55, 0.72, clump + wood * 0.3)
        conifer =
          (0.012 + wood * 0.55 + tuck * 0.22) *
          exposed *
          (1 - built * 0.9) *
          (1 - bare * 0.9) *
          (1 - grass * 0.7)
        if (meta.province === 'NS') conifer *= 1.6
        // Low scrub where the spruce thins out (only near the boat: it is small).
        if (d < 2200)
          scrub =
            (0.08 + wood * 0.2 + (1 - wood) * smooth(0.45, 0.65, clump) * 0.45) *
            exposed *
            (1 - built) *
            (1 - bare * 0.8) *
            (1 - grass * 0.5)
        broad = town * (meta.province === 'NS' ? 0.35 : 0.2)
        const shore = smooth(3, 6, h)
        conifer *= shore
        scrub *= shore
      }
      const total = (conifer + scrub + broad) * distance
      if (total <= 0.002 || near(px, pz)) continue
      const pickKind = rnd() * (conifer + scrub + broad)
      const kind: TreeKind = pickKind < conifer ? 0 : pickKind < conifer + scrub ? 1 : 2
      xs.push(px)
      zs.push(pz)
      ps.push(total)
      kinds.push(kind)
      sums[kind]! += total
    }
  const scales = sums.map((s, k) => Math.min(1, budgets[k]! / Math.max(s, 1e-6)))
  const chunks = 4
  const buckets = Array.from({ length: chunks * chunks }, () => [[], [], []] as number[][])
  for (let i = 0; i < xs.length; i++) {
    const kind = kinds[i]!
    if (rnd() > ps[i]! * scales[kind]!) continue
    const x = xs[i]!,
      z = zs[i]!
    const ci = Math.min(chunks - 1, Math.floor(((x + half) / meta.sizeM) * chunks)),
      cj = Math.min(chunks - 1, Math.floor(((z + half) / meta.sizeM) * chunks))
    buckets[cj * chunks + ci]![kind]!.push(x, z)
  }
  const geometries = [coniferGeometry(pacific ? 0.62 : 0.85), bushGeometry(), broadleafGeometry()]
  const material = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })
  patch(material, {
    key: 'scenery-trees',
    colour: /* glsl */ `
      {
        float px = max(length(fwidth(vSWorld)), 1e-3);
        float clumps = mix(0.5, sNoise3(vSWorld / 0.7), 1.0 - smoothstep(0.05, 0.4, px));
        diffuseColor.rgb *= mix(0.8, 1.12, sNoise3(vSWorld / 2.5)) * mix(0.7, 1.15, clumps);
      }
    `,
  })
  const meshes: T.InstancedMesh[] = []
  const matrix = new T.Matrix4(),
    q = new T.Quaternion(),
    s = new T.Vector3(),
    p = new T.Vector3(),
    up = new T.Vector3(0, 1, 0)
  const c = new T.Color()
  const hues = [
    pacific
      ? ['#1b2b1c', '#203320', '#18271d', '#243620', '#2a3624', '#1c3024', '#2f3527']
      : ['#1e2c1c', '#24331e', '#2a3824', '#1b291b', '#2e3622'],
    ['#4a4c2c', '#3d4a2a', '#544830', '#38432a', '#5a4e30', '#4a3f2c'],
    ['#3d5a2a', '#4a6630', '#56702f', '#45602c', '#6b6a2a', '#7a5a22', '#8a4a22'],
  ]
  const names = ['trees', 'scrub', 'broadleaf']
  let count = 0
  for (const bucket of buckets)
    for (const kind of [0, 1, 2] as TreeKind[]) {
      const list = bucket[kind]!
      const n = list.length / 2
      if (!n) continue
      const mesh = new T.InstancedMesh(geometries[kind]!, material, n)
      for (let i = 0; i < n; i++) {
        const x = list[i * 2]!,
          z = list[i * 2 + 1]!
        const r = hash2(Math.round(x * 31), Math.round(z * 17))
        const r2 = hash2(Math.round(z * 29), Math.round(x * 11))
        const stand = fbm(x / 140, z / 140)
        let height: number, width: number
        if (kind === 1) {
          height = 0.8 + r * 1.4
          width = height * (1.0 + r2 * 0.6)
        } else if (kind === 2) {
          height = (meta.province === 'NS' ? 8 : 6) + r * 7
          width = height * (0.65 + r2 * 0.25)
        } else if (pacific) {
          height = 14 + stand * 22 + r * 9
          width = height * (0.36 + r2 * 0.14)
        } else if (meta.province === 'NS') {
          height = 7 + stand * 8 + r * 5
          width = height * (0.42 + r2 * 0.15)
        } else {
          // Newfoundland: short, wind-stunted spruce.
          height = 2.5 + stand * 4 + r * 3
          width = height * (0.5 + r2 * 0.25)
        }
        p.set(x, heightAt(x, z) - (kind === 1 ? 0.15 : 0.4), z)
        q.setFromAxisAngle(up, r2 * Math.PI * 2)
        s.set(width, height, width * (0.85 + r * 0.3))
        mesh.setMatrixAt(i, matrix.compose(p, q, s))
        c.set(pick(hues[kind]!, r2)).multiplyScalar(0.85 + r * 0.3)
        mesh.setColorAt(i, c)
      }
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      mesh.computeBoundingBox()
      mesh.castShadow = shadows
      mesh.receiveShadow = shadows
      mesh.name = names[kind]!
      meshes.push(mesh)
      count += n
    }
  // Geometries without instances are not referenced by any mesh: release them now.
  for (const g of geometries) if (!meshes.some((m) => m.geometry === g)) g.dispose()
  return { meshes, count }
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function buildScenery(
  meta: SceneryMeta,
  terrainBuffer: ArrayBuffer,
  coverBuffer: ArrayBuffer,
  renderer: T.WebGLRenderer,
  options: SceneryOptions = {},
  streets?: StreetsFile,
): Scenery {
  const shadows = options.shadows ?? true
  // Mapped fuel canopies are drawn as canopies (streets.ts), not as solid buildings; tiny
  // sheds and outbuildings read as clutter at this scale.
  if (streets) {
    const canopyCentres = streets.canopies.map((c) => ringCentroid(c.polygon))
    meta.features.buildings = meta.features.buildings.filter((b) => {
      const [x, z] = ringCentroid(b.footprint)
      return !canopyCentres.some(([cx, cz]) => Math.hypot(cx - x, cz - z) < 4)
    })
  }
  meta.features.buildings = meta.features.buildings.filter(
    (b) => Math.abs(ringArea(b.footprint)) >= 10 || b.kind !== 'shed',
  )
  const n = meta.grid
  const half = meta.sizeM / 2
  const cell = meta.sizeM / (n - 1)
  const view = new DataView(terrainBuffer)
  const heights = new Float32Array(n * n)
  for (let i = 0; i < heights.length; i++) heights[i] = view.getInt16(i * 2, true) / 10
  const grid: Grid = { n, cell, half, heights }
  const heightAt = (x: number, z: number) => {
    const fi = (x + half) / cell,
      fj = (z + half) / cell
    if (fi < 0 || fj < 0 || fi > n - 1 || fj > n - 1) return -60
    const i = Math.min(n - 2, Math.floor(fi)),
      j = Math.min(n - 2, Math.floor(fj))
    const u = fi - i,
      v = fj - j
    const c = j * n + i
    return (
      (heights[c]! * (1 - u) + heights[c + 1]! * u) * (1 - v) +
      (heights[c + n]! * (1 - u) + heights[c + n + 1]! * u) * v
    )
  }

  const group = new T.Group()
  group.name = `scenery-${meta.id}`
  const disposables: { dispose(): void }[] = []
  const pacific = meta.forest === 'dense-conifer'

  const mask = coverMask(meta, new Uint8Array(coverBuffer))
  disposables.push(mask.texture)
  const terrainMat = terrainMaterial(mask.texture, mask.bounds, pacific)
  disposables.push(terrainMat)
  for (const mesh of buildTerrain(grid, terrainMat, shadows)) {
    group.add(mesh)
    disposables.push(mesh.geometry)
  }
  const apron = buildApron(grid, heightAt, terrainMat)
  group.add(apron)
  disposables.push(apron.geometry)

  const add = (m: Mesher, material: T.Material, name: string, cast = shadows) => {
    if (!m.vertexCount) {
      material.dispose()
      return
    }
    const geometry = m.build()
    const mesh = new T.Mesh(geometry, material)
    mesh.name = name
    mesh.castShadow = cast
    mesh.receiveShadow = shadows
    group.add(mesh)
    disposables.push(geometry, material)
  }
  const { walls, roofs } = buildBuildings(
    meta,
    heightAt,
    streets ? streetFinder(streets) : undefined,
  )
  add(walls, wallMaterial(colour('#f1efe8')), 'building-walls')
  add(roofs, roofMaterial(), 'building-roofs')
  add(buildPiers(meta, heightAt), weatheredMaterial('piers', 0.88, 1), 'piers')
  add(buildBreakwaters(meta), weatheredMaterial('rock', 0.92, 1.2), 'breakwaters')
  add(buildLandmarks(meta), weatheredMaterial('landmarks', 0.7, 0.5), 'landmarks')

  // Lakes: flat, dark and glossy (the environment map supplies the reflection).
  const lakes = new Mesher()
  const lakeColour = colour('#0d1b20')
  for (const lake of meta.features.lakes) cap(lakes, lake.polygon, lake.level, lakeColour)
  add(
    lakes,
    new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0 }),
    'lakes',
    false,
  )

  const street = streets
    ? buildStreets(
        streets,
        heightAt,
        meta.features.buildings.map((b) => ringCentroid(b.footprint)),
        shadows,
        meta.features.buildings.length * 31 + 7,
        meta.features.buildings.filter((b) => b.kind === 'house').map((b) => b.footprint),
        options.carShare ?? 1,
      )
    : undefined
  if (street) group.add(street.group)
  const trees = buildTrees(
    meta,
    grid,
    heightAt,
    mask.sample,
    options.treeDensity ?? 1,
    shadows,
    street?.corridors ?? [],
  )
  for (const mesh of trees.meshes) group.add(mesh)
  const treeGeometries = new Set(trees.meshes.map((m) => m.geometry))
  const treeMaterials = new Set(trees.meshes.map((m) => m.material as T.Material))
  disposables.push(...treeGeometries, ...treeMaterials)

  // Height texture for shoreline effects in the water shader (texel centres on grid vertices).
  const half16 = new Uint16Array(n * n)
  for (let i = 0; i < half16.length; i++) half16[i] = T.DataUtils.toHalfFloat(heights[i]!)
  const heightTexture = new T.DataTexture(half16, n, n, T.RedFormat, T.HalfFloatType)
  heightTexture.magFilter = T.LinearFilter
  heightTexture.minFilter = T.LinearFilter
  heightTexture.wrapS = heightTexture.wrapT = T.ClampToEdgeWrapping
  heightTexture.needsUpdate = true
  renderer.initTexture(heightTexture)
  renderer.initTexture(mask.texture)
  disposables.push(heightTexture)

  let vertices = 0,
    triangles = 0,
    drawCalls = 0
  group.traverse((object) => {
    const mesh = object as T.Mesh
    if (!mesh.isMesh) return
    const g = mesh.geometry
    const count = (mesh as T.InstancedMesh).isInstancedMesh ? (mesh as T.InstancedMesh).count : 1
    const verts = g.attributes.position!.count
    vertices += verts * count
    triangles += ((g.index ? g.index.count : verts) / 3) * count
    drawCalls++
  })

  return {
    group,
    heightAt,
    heightTexture,
    bounds: { minX: -half - cell / 2, minZ: -half - cell / 2, size: meta.sizeM + cell },
    meta,
    stats: { vertices, triangles, treeInstances: trees.count, drawCalls },
    dispose() {
      group.removeFromParent()
      street?.dispose()
      for (const d of disposables) d.dispose()
      for (const mesh of trees.meshes) mesh.dispose()
      group.clear()
    },
  }
}
