import * as T from 'three'

/**
 * Procedural wear for a vessel's materials: grime, vertical rust/runoff streaks on
 * upright surfaces, scuffed decks and a waterline scum band. Noise is evaluated in the
 * vessel's own frame (`boatInverse`), so it stays attached to the hull as it rocks.
 * Generic: works for any hull model, no UVs or authored masks required.
 */
export function weatherMaterial(material: T.Material, boatInverse: { value: T.Matrix4 }) {
  const standard = material as T.MeshStandardMaterial
  if (!standard.isMeshStandardMaterial) return
  // Source paints are fully matte; marine enamel has some sheen.
  if (standard.roughness > 0.85) standard.roughness = 0.62
  standard.onBeforeCompile = (shader) => {
    shader.uniforms.boatInverse = boatInverse
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform mat4 boatInverse;
        varying vec3 vBoatPos;
        varying vec3 vBoatNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vBoatPos = (boatInverse * modelMatrix * vec4(transformed, 1.0)).xyz;
        vBoatNormal = normalize(mat3(boatInverse * modelMatrix) * objectNormal);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBoatPos;
        varying vec3 vBoatNormal;
        float wHash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float wNoise(vec3 x) {
          vec3 i = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(wHash(i), wHash(i + vec3(1, 0, 0)), f.x),
                         mix(wHash(i + vec3(0, 1, 0)), wHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(wHash(i + vec3(0, 0, 1)), wHash(i + vec3(1, 0, 1)), f.x),
                         mix(wHash(i + vec3(0, 1, 1)), wHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }
        float wFbm(vec3 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) { v += a * wNoise(p); p = p * 2.07 + 11.3; a *= 0.5; }
          return v;
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float upright = 1.0 - abs(vBoatNormal.y);
        float grime = wFbm(vBoatPos * 0.45);
        // Streaks: noise stretched vertically, sampled along the surface's horizontal run.
        float run = vBoatPos.x * 1.7 + vBoatPos.z * 1.7;
        float streak = wFbm(vec3(run * 1.3, vBoatPos.y * 0.09, 0.0));
        streak = smoothstep(0.52, 0.8, streak) * smoothstep(0.35, 0.8, upright);
        float rustSpots = smoothstep(0.7, 0.82, wFbm(vBoatPos * 1.9 + 3.0)) * upright;
        vec3 rust = vec3(0.30, 0.14, 0.07);
        diffuseColor.rgb *= mix(1.0, 0.8, smoothstep(0.35, 0.75, grime));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.6 + rust * 0.22, streak * 0.6);
        diffuseColor.rgb = mix(diffuseColor.rgb, rust * 0.8, rustSpots * 0.5);
        // Decks: foot traffic darkens and dulls the paint.
        float deck = smoothstep(0.75, 0.95, vBoatNormal.y);
        diffuseColor.rgb *= mix(1.0, 0.78 + 0.22 * wNoise(vBoatPos * 2.3), deck);
        // Waterline scum band just above the water.
        float scum = smoothstep(-0.2, 0.15, vBoatPos.y) * (1.0 - smoothstep(0.15, 0.9, vBoatPos.y));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.13, 0.09), scum * 0.55 * upright);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (grime - 0.5) * 0.25 + streak * 0.15 + deck * 0.15, 0.2, 1.0);`,
      )
  }
  standard.customProgramCacheKey = () => 'vessel-weathering'
  standard.needsUpdate = true
}
