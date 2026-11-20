/**
 * Shared wave spectrum keeps the GPU surface and CPU vessel buoyancy in phase.
 *
 * A primary swell, a cross swell and a wind sea, as Gerstner (trochoidal) components.
 * Wavelengths are deliberately non-commensurate (ratio ~1.3, irregular) so the sum does
 * not visibly repeat. Angular speeds follow deep-water dispersion, ω = √(g·k), so long
 * swells outrun short chop the way they do at sea.
 *
 * Components with `geometry: true` displace the mesh and drive buoyancy. All components
 * contribute to per-pixel normals and whitecap foam in the fragment shader, so short
 * chop never aliases on the vertex grid.
 */
const G = 9.81
// [wavelength m, amplitude m, direction of travel in degrees from +X towards +Z]
const spectrum: [number, number, number][] = [
  [96, 0.62, 18], // primary swell
  [71, 0.4, 31],
  [54, 0.29, 6],
  [63, 0.24, -58], // cross swell
  [38, 0.2, 47], // wind sea
  [29, 0.15, 22],
  [23, 0.115, 66],
  [17.5, 0.085, 35],
  [13.3, 0.062, 12],
  [10.1, 0.045, 58], // normal-only chop below
  [7.7, 0.033, 27],
  [5.9, 0.024, 81],
  [4.4, 0.017, 3],
  [3.3, 0.012, 44],
]
const GEOMETRY_MIN_WAVELENGTH = 13
const geometryCount = spectrum.filter(([l]) => l >= GEOMETRY_MIN_WAVELENGTH).length
/** Summed crest sharpness of the displaced waves; < 1 keeps the surface from folding. */
const CREST_SHARPNESS = 0.62

export const waves = spectrum.map(([wavelength, amplitude, degrees]) => {
  const k = (2 * Math.PI) / wavelength
  const a = (degrees * Math.PI) / 180
  const geometry = wavelength >= GEOMETRY_MIN_WAVELENGTH
  return {
    amplitude,
    wavelength,
    direction: [Math.cos(a), Math.sin(a)] as [number, number],
    speed: Math.sqrt(G * k),
    // Gerstner horizontal factor; normal-only chop is sharpened more for foam detail.
    steepness: geometry
      ? CREST_SHARPNESS / (k * amplitude * geometryCount)
      : 0.8 / (k * amplitude * spectrum.length),
    geometry,
  }
})

/** Height and analytic slope of the displaced swells at a horizontal position (metres, seconds). */
export function seaAt(x: number, z: number, time: number) {
  let height = 0,
    dx = 0,
    dz = 0
  for (const wave of waves) {
    if (!wave.geometry) continue
    const k = (2 * Math.PI) / wave.wavelength
    const phase = k * (wave.direction[0] * x + wave.direction[1] * z) - time * wave.speed
    height += wave.amplitude * Math.sin(phase)
    dx += wave.amplitude * k * wave.direction[0] * Math.cos(phase)
    dz += wave.amplitude * k * wave.direction[1] * Math.cos(phase)
  }
  return { height, dx, dz }
}

const f = (n: number) => n.toFixed(6)
const term = (w: (typeof waves)[number], body: string) => {
  const k = (2 * Math.PI) / w.wavelength
  return `{
    vec2 d = vec2(${f(w.direction[0])}, ${f(w.direction[1])});
    float k = ${f(k)}, a = ${f(w.amplitude)}, q = ${f(w.steepness)};
    float th = k * dot(d, p) - t * ${f(w.speed)};
    float s = sin(th), c = cos(th);
    ${body}
  }`
}

/**
 * GLSL:
 * - `seaDisplace(p, t)`: Gerstner displacement (dx, height, dz) of the geometry swells.
 * - `seaSurface(p, t, dist, out normal, out crest)`: all components; short chop fades
 *   with viewing distance (per-wave, by wavenumber) to avoid shimmer. `crest` > 0
 *   where the surface is compressed into sharp crests (whitecap foam).
 */
export const seaShader = `
vec3 seaDisplace(vec2 p, float t) {
  vec3 r = vec3(0.0);
  ${waves
    .filter((w) => w.geometry)
    .map((w) => term(w, 'r.xz += q * a * d * c; r.y += a * s;'))
    .join('\n  ')}
  return r;
}
void seaSurface(vec2 p, float t, float dist, out vec3 normal, out float crest) {
  vec3 n = vec3(0.0, 1.0, 0.0);
  crest = 0.0;
  ${waves
    .map((w) =>
      term(
        w,
        `float fade = clamp(1.5 - dist * k / 300.0, 0.0, 1.0);
    float ka = k * a * fade;
    n.xz -= d * ka * c;
    n.y -= q * ka * s;
    crest += q * ka * s * ${w.wavelength < 40 ? '1.6' : '0.25'};`,
      ),
    )
    .join('\n  ')}
  normal = normalize(n);
}`
