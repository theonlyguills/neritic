# Validation — 2026-11-03

- Production Nuxt build: passed. Expected large lazy renderer chunks (Cesium ~1.1 MB gzip, Three.js ~153 KB gzip).
- TypeScript: passed. ESLint: passed. Prettier source checks: passed.
- Five focused tests passed: deterministic bounded simulation, local coordinates/dateline wrap, route validation, subscription cleanup, and bundled geometry identifiers/coordinate ranges.
- Mobile follow-up passed: the full activity panel and vessel action remain reachable, and the vessel drilldown succeeds at 390px width.
- Production Chromium screenshots inspected for Canada, Atlantic, Pacific, elevated vessel, water-level vessel, and mobile.
- Browser checks cover three-level navigation and return, browser back, repeated transitions (two retained canvases), mobile horizontal overflow, native credits dialog/Escape, failed vessel asset and retry, blocked online imagery fallback, and WebGL-unavailable messaging.
- Sources: 38 official NAFO division polygons; 48 official DFO Pacific management areas. Metadata/checksums are bundled in public/data/manifest.json.

## Performance and remaining limits

1080p Chromium run: **6.78 FPS**, ANGLE Vulkan **SwiftShader software renderer**. This is not a hardware-accelerated GPU measurement. The 30 FPS laptop target is **not yet verified**. Reduced graphics uses 0.65 device pixel ratio in the local scene and 0.7 resolution scale geographically. Measure on the actual target laptop before deployment.

No production endpoints, auth, AKS deployments or live fishing records were exercised. Terrain is ellipsoid-based with shaded-relief imagery, not a detailed elevation mesh. There is one local vessel scene. Scene switching was checked for stable canvas count; comprehensive GPU/heap profiling has not been performed. No pipeline YAML or shell scripts were added or changed.

Reproduce with the README commands. Browser test screenshots and performance JSON are in ignored artifacts/.
