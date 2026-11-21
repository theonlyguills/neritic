import * as T from 'three'
import { Water } from 'three/addons/objects/Water.js'
import { seaAt, seaShader } from './sea'

/** Waterline footprint and motion used for hull foam and the wake, in world metres. */
export interface HullFootprint {
  halfLength: number
  halfBeam: number
  /** Forward speed through the water, m/s. The vessel stays at the origin; foam streams aft. */
  speed: number
}

/**
 * Ocean surface built on three's `Water` (for its planar reflection render pass) with a
 * replacement shader: Gerstner swell geometry, analytic per-pixel normals for all wave
 * components, distorted reflection, crest translucency, whitecaps, hull foam and wake.
 */
export function createOcean(normals: T.Texture, sun: T.Vector3, hull: HullFootprint) {
  // Concentrate vertices around the vessel; retain an unbroken distant horizon.
  const geometry = new T.PlaneGeometry(2, 2, 256, 256)
  const vertices = geometry.attributes.position!
  for (let i = 0; i < vertices.count; i++) {
    const stretch = (v: number) => v * 160 + v ** 5 * 7840
    vertices.setXY(i, stretch(vertices.getX(i)), stretch(vertices.getY(i)))
  }
  geometry.computeBoundingSphere()
  const water = new Water(geometry, {
    textureWidth: 1024,
    textureHeight: 1024,
    waterNormals: normals,
    sunDirection: sun,
    sunColor: 0xffe2b8,
    waterColor: 0x04141a,
    distortionScale: 3.2,
    fog: true,
  })
  const material = water.material
  Object.assign(material.uniforms, {
    hullHalfLength: { value: hull.halfLength },
    hullHalfBeam: { value: hull.halfBeam },
    hullSpeed: { value: hull.speed },
    // Bow plunge history, newest first, one sample per SURGE_STEP seconds.
    surgeHistory: { value: new Array<number>(SURGE_SAMPLES).fill(0) },
    // Vessel heading in the XZ plane (bow direction) and position.
    hullForward: { value: new T.Vector2(0, -1) },
    hullPosition: { value: new T.Vector2(0, 0) },
    // Swell amplitude scale (1 open ocean; sheltered water is calmer).
    seaState: { value: 1 },
    // Coastal sceneries: terrain height (R, metres) over (minX, minZ, size); w = enabled.
    shoreHeight: { value: placeholderHeight },
    shoreBounds: { value: new T.Vector4(0, 0, 1, 0) },
  })
  material.vertexShader = vertexShader
  material.fragmentShader = fragmentShader
  material.needsUpdate = true
  water.rotation.x = -Math.PI / 2
  return water
}

const placeholderHeight = new T.DataTexture(
  new Float32Array([-100]),
  1,
  1,
  T.RedFormat,
  T.FloatType,
)
placeholderHeight.needsUpdate = true
const SURGE_SAMPLES = 16
const SURGE_STEP = 0.25

/**
 * Bow plunge → white water. Each time the bow drives down into a swell (faster than the
 * surface rises to meet it) a surge of foam bursts out around the stem. The shader reads
 * the recent history so each burst slides aft along the hull at the vessel's speed and
 * breaks up as it goes. Driven by the same wave spectrum as the hull motion.
 */
export function createBowSurge(water: Water, bowLocal: T.Vector3) {
  const state = water.material.uniforms.seaState!
  const history = water.material.uniforms.surgeHistory!.value as number[]
  const bow = new T.Vector3()
  let lastRelative: number | undefined
  let surge = 0
  let clock = 0
  return function update(boat: T.Object3D, time: number, dt: number) {
    bow.copy(bowLocal).applyMatrix4(boat.matrixWorld)
    const relative = bow.y - seaAt(bow.x, bow.z, time, state.value).height
    const sinking = lastRelative === undefined || dt <= 0 ? 0 : (lastRelative - relative) / dt
    lastRelative = relative
    const target = Math.min(1, Math.max(0, (sinking - 0.06) * 1.8))
    // Fast attack, slow release.
    surge = Math.max(surge * Math.exp(-dt / 1.1), target)
    history[0] = surge
    clock += dt
    while (clock >= SURGE_STEP) {
      clock -= SURGE_STEP
      for (let i = history.length - 1; i > 0; i--) history[i] = history[i - 1]!
    }
    return surge
  }
}

const vertexShader = /* glsl */ `
uniform mat4 textureMatrix;
uniform float time;
uniform float seaState;
varying vec4 mirrorCoord;
varying vec4 worldPosition;
varying vec2 seaCoord;
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
${seaShader}
void main() {
  // The plane is rotated -90° about X: local (x, y) is world (x, -y), local z is world up.
  vec4 base = modelMatrix * vec4(position, 1.0);
  seaCoord = base.xz;
  float fade = 1.0 - smoothstep(250.0, 600.0, length(base.xz));
  vec3 d = seaDisplace(base.xz, time) * fade;
  vec3 displaced = position + vec3(d.x, -d.z, d.y);
  mirrorCoord = modelMatrix * vec4(displaced, 1.0);
  worldPosition = mirrorCoord.xyzw;
  mirrorCoord = textureMatrix * mirrorCoord;
  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
  #include <shadowmap_vertex>
}`

const fragmentShader = /* glsl */ `
uniform sampler2D mirrorSampler;
uniform float alpha;
uniform float time;
uniform float distortionScale;
uniform sampler2D normalSampler;
uniform vec3 sunColor;
uniform vec3 sunDirection;
uniform vec3 eye;
uniform vec3 waterColor;
uniform float hullHalfLength;
uniform float hullHalfBeam;
uniform float hullSpeed;
uniform vec2 hullForward;
uniform vec2 hullPosition;
uniform float surgeHistory[${SURGE_SAMPLES}];
uniform float seaState;
uniform sampler2D shoreHeight;
uniform vec4 shoreBounds;
varying vec4 mirrorCoord;
varying vec4 worldPosition;
varying vec2 seaCoord;
#include <common>
#include <packing>
#include <bsdfs>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
${seaShader}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic: no visible lattice
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  // Rotate each octave so the value-noise grid never lines up into blocks.
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = r * p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
// Fine ripples from the tiling normal map, sampled at two drifting, rotated scales.
vec3 ripple(vec2 p) {
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  vec3 a = texture2D(normalSampler, p / 23.0 + vec2(time / 41.0, time / 67.0)).rgb;
  vec3 b = texture2D(normalSampler, r * p / 9.7 - vec2(time / 29.0, -time / 53.0)).rgb;
  vec3 n = (a + b) - 1.0;
  return vec3(n.x, 0.0, n.y);
}
// Signed distance from the waterline footprint: bow is fine, stern is full.
float hullDistance(float along, float side) {
  float u = clamp(along / hullHalfLength, -1.0, 1.0);
  float halfBeam = along > 0.0
    ? hullHalfBeam * pow(max(1.0 - u * u, 0.0), 0.75)
    : hullHalfBeam * pow(max(1.0 - pow(abs(u), 5.0), 0.0), 0.5);
  float lateral = abs(side) - halfBeam;
  float ends = abs(along) - hullHalfLength;
  return max(lateral, ends) + 0.35 * max(min(lateral, ends), 0.0);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 worldToEye = eye - worldPosition.xyz;
  float dist = length(worldToEye);
  vec3 v = worldToEye / dist;

  vec3 n;
  float crest;
  seaSurface(seaCoord, time, dist, n, crest);
  float rippleFade = 1.0 - smoothstep(60.0, 900.0, dist);
  // Wave groups: patches of rougher water drift across the swell.
  float patches = fbm(seaCoord / 140.0 + vec2(time * 0.006, -time * 0.004));
  float roughness = mix(0.18, 0.5, smoothstep(0.35, 0.75, patches));
  n = normalize(n + ripple(seaCoord) * roughness * rippleFade);

  // Vessel frame: along > 0 towards the bow, side to starboard.
  vec2 rel = seaCoord - hullPosition;
  vec2 right = vec2(-hullForward.y, hullForward.x);
  float along = dot(rel, hullForward);
  float side = dot(rel, right);
  float hull = hullDistance(along, side);
  float aft = -along - hullHalfLength; // metres astern of the transom
  float fromBow = hullHalfLength - along;

  // Foam texture streaming aft at the vessel's speed (the hull stays at the origin).
  vec2 flow = vec2(side, along + time * hullSpeed);
  float foamTex = fbm(flow * vec2(0.9, 0.55)) * 0.6 + fbm(flow * 2.9) * 0.4;

  float hullFoam = exp(-max(hull, 0.0) / 0.7) * (0.45 + 0.55 * smoothstep(-0.6, 0.85, along / hullHalfLength));
  float washWidth = hullHalfBeam * 0.6 + max(aft, 0.0) * 0.08;
  float wash = step(0.0, aft) * exp(-aft / 110.0)
    * smoothstep(washWidth, washWidth * 0.2, abs(side));
  // Kelvin wake arms at ~19.5° from the bow.
  float arm = fromBow * 0.354 + hullHalfBeam * 0.6;
  float armWidth = 0.5 + fromBow * 0.012;
  float kelvin = step(0.0, fromBow) * exp(-pow((abs(side) - arm) / armWidth, 2.0))
    * exp(-max(fromBow - hullHalfLength, 0.0) / 140.0) * smoothstep(hullHalfLength * 0.4, hullHalfLength, fromBow);
  // Coverage threshold: dense foam at the hull, breaking into lace as it dissipates.
  // Bow surge: the burst recorded when this water passed the stem, carried aft at speed.
  float surgeAge = max(fromBow - 1.5, 0.0) / max(hullSpeed, 1.5) / ${SURGE_STEP.toFixed(2)};
  int surgeIndex = int(min(surgeAge, ${(SURGE_SAMPLES - 2).toFixed(1)}));
  float surgeHere = mix(surgeHistory[surgeIndex], surgeHistory[surgeIndex + 1], fract(surgeAge))
    * (1.0 - smoothstep(${(SURGE_SAMPLES - 4).toFixed(1)}, ${(SURGE_SAMPLES - 1).toFixed(1)}, surgeAge));
  // Spreads sideways off the flare only: nothing ahead of the stem.
  float surgeReach = 0.8 + surgeHere * 3.5 * smoothstep(0.1, 0.85, along / hullHalfLength);
  float bowSurge = surgeHere * exp(-max(hull, 0.0) / surgeReach)
    * smoothstep(-0.5, 2.5, fromBow) * step(-hullHalfLength, along);
  // A boat lying alongside makes no wake: wash and Kelvin arms need way on.
  float underway = smoothstep(0.3, 2.0, hullSpeed);
  wash *= underway;
  kelvin *= underway;
  hullFoam *= mix(0.25, 1.0, underway);
  float wakeAmount = clamp(hullFoam * 0.6 + wash * 0.62 + kelvin * 0.35, 0.0, 0.74);
  float wakeFoam = smoothstep(0.92 - wakeAmount, 1.1 - wakeAmount, foamTex) * min(wakeAmount * 1.5, 0.92);
  // Surge foam: wide, soft coverage edge so it thins into lace rather than cutting off.
  float surgeAmount = min(bowSurge * 0.85, 0.8);
  float surgeFoam = smoothstep(0.95 - surgeAmount, 1.4 - surgeAmount, foamTex) * surgeAmount * 1.15;
  wakeFoam = max(wakeFoam, surgeFoam);
  // Prop wash churns lighter, aerated water and flattens ripples.
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), wash * 0.45));

  float capAmount = smoothstep(0.42, 0.75, crest + (patches - 0.5) * 0.35) * 0.55;
  float capTex = fbm(seaCoord * 1.1 + vec2(time * 0.08, 0.0)) * 0.55 + fbm(seaCoord * 3.3) * 0.45;
  float whitecap = smoothstep(1.0 - capAmount, 1.12 - capAmount, capTex) * min(capAmount * 2.0, 1.0);
  // Shoreline: surf where the water shoals against real terrain, and a shallow tint.
  float shallow = 0.0;
  float surf = 0.0;
  if (shoreBounds.w > 0.5) {
    vec2 suv = (seaCoord - shoreBounds.xy) / shoreBounds.z;
    if (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) {
      float depth = -texture2D(shoreHeight, suv).r;
      shallow = 1.0 - smoothstep(0.5, 9.0, depth);
      // Bands of broken water running in towards the rocks, frayed by noise.
      float bands = 0.5 + 0.5 * sin(depth * 1.6 + time * 1.3 + fbm(seaCoord * 0.08) * 5.0);
      float lace = fbm(seaCoord * 0.45 + vec2(time * 0.12, -time * 0.09));
      float reach = (1.0 - smoothstep(0.0, 3.5 + seaState * 3.0, depth)) * (0.35 + 0.65 * seaState);
      surf = smoothstep(0.62 - reach * 0.5, 0.95 - reach * 0.4, lace * 0.7 + bands * 0.45) * reach;
      surf = max(surf, (1.0 - smoothstep(0.0, 0.7, depth)) * 0.85 * smoothstep(0.35, 0.6, lace));
    }
  }
  float foam = clamp(max(max(whitecap * 0.85, wakeFoam), surf), 0.0, 1.0) * (1.0 - smoothstep(300.0, 1200.0, dist) * (1.0 - shallow));

  // Reflection: planar mirror, broken up by the full surface slope.
  vec2 distortion = n.xz * (0.012 + 2.5 / dist) * distortionScale;
  vec3 reflection = texture2D(mirrorSampler, mirrorCoord.xy / mirrorCoord.w + distortion).rgb;
  float cosTheta = clamp(dot(n, v), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);
  fresnel = mix(fresnel, 0.6, smoothstep(1500.0, 6000.0, dist)) * 0.92;

  float shadow = getShadowMask();
  vec3 up = vec3(0.0, 1.0, 0.0);
  // Body colour: deep water lit by the sky, with translucent green on sunward-backlit crests.
  float height = worldPosition.y;
  vec3 body = waterColor * (0.55 + 0.45 * max(dot(n, up), 0.0));
  float backlit = pow(max(dot(v, -vec3(sunDirection.x, 0.0, sunDirection.z)), 0.0), 2.0);
  body += vec3(0.012, 0.045, 0.042) * smoothstep(-0.3, 1.1, height) * (0.3 + 0.7 * backlit);
  body += vec3(0.03, 0.08, 0.075) * wash;
  // Shoaling water over rock and kelp: greener and a little brighter.
  body = mix(body, vec3(0.045, 0.085, 0.07), shallow * 0.6);
  body *= mix(0.55, 1.0, shadow);

  vec3 h = normalize(sunDirection + v);
  // Sun glitter: a dim broad sheen plus sharp sparkles from fine facets, not smooth smears.
  vec3 facet = normalize(n + ripple(seaCoord * 3.7) * 0.35 * rippleFade);
  float shininess = mix(2400.0, 160.0, smoothstep(30.0, 1500.0, dist));
  float sparkle = pow(max(dot(facet, h), 0.0), shininess) * (shininess + 8.0) / 60.0;
  float sheen = pow(max(dot(n, h), 0.0), 60.0) * 0.6;
  float glint = sparkle + sheen;
  vec3 specular = sunColor * glint * fresnel * shadow * (1.0 - foam);

  vec3 color = mix(body, reflection, fresnel) + specular;
  float foamLight = 0.55 + 0.45 * max(dot(n, sunDirection), 0.0);
  vec3 foamColor = vec3(0.82, 0.87, 0.88) * foamLight * mix(0.5, 1.0, shadow);
  color = mix(color, foamColor, foam);

  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`
