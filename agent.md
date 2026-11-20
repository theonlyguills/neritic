# Pelagic — project context for the next agent

Updated: 2026-11-20. Project directory: `/home/guills/marine-operations`.

This file describes the implementation and its boundaries. Read it with `README.md`, `VALIDATION.md`, and the applicable parent `AGENTS.md`. It does not replace the CFIS engineering instructions.

## Purpose and visual direction

Build a reusable browser-based marine operations experience: recognizable geography at national and regional scales, then a detailed offshore scene. The desired appearance is professional and somewhat realistic, with water, sky, commercial fishing vessels and readable operational information. Avoid cartoon clouds, toy boats and decorative effects that obscure data.

The initial discussion proposed a Three.js-only projected world. The working implementation instead uses **Cesium for geographic exploration and Three.js for the local vessel scene**, with Vue controlling navigation and panels. Preserve this distinction when describing what has actually been built.

All activity, vessel names, positions and operating values are demonstration data. There is no connection to production fisheries records or infrastructure telemetry.

## What works today

| Detail level | Renderer | Current experience |
| --- | --- | --- |
| 1: Canada | Cesium | Globe overview with imagery and navigation to either coast. |
| 2: Coast / fishing areas | Cesium | Atlantic NAFO divisions or Pacific fisheries management areas, selectable boundaries, demonstration vessel selection and an activity panel. |
| 3: Offshore vessel | Three.js | A commercial stern trawler, animated sea, photographic sky and three deck crew figures; orbit, zoom and elevated / water-level / working-deck camera presets. |

There are four registered views: `canada`, `atlantic`, `pacific`, `vessel`. Direct links use `?view=atlantic`, `?view=pacific` or `?view=vessel`; invalid views fall back to Canada. Browser navigation and returning to the geographic view are supported.

The detailed scene is currently **one illustrative Atlantic vessel**, Northern Light, near the Grand Banks. Pacific has regional geography and demonstration markers, but no separate Pacific close-up scene.

Other implemented features: loading/error/retry UI, graphics quality selection, Reduce motion, source credits, responsive panels, and a local imagery fallback when online imagery fails.

## Stack and local commands

- Nuxt 4, Vue 3, Pinia and TypeScript; client-rendered application (`ssr: false`).
- Cesium geographic renderer and Three.js local renderer; no raw WebGL application code.
- ESLint, Prettier, TypeScript checks, Node tests via `tsx`, and Playwright Chromium checks.
- Use the committed-style lockfile with `npm ci`; consult `package-lock.json` for exact resolved versions. Node 24 is the documented runtime.
- This directory is currently a local project, **not a Git repository**. No application deployment has been configured.

```bash
cd /home/guills/marine-operations
npm ci
npm run dev
# http://127.0.0.1:3070
```

Production preview:

```bash
npm run build
PORT=3070 HOST=127.0.0.1 node .output/server/index.mjs
```

No backend, credentials or Cesium ion account are required. Optional NASA imagery needs network access. Nuxt configuration copies Cesium worker/runtime assets from `node_modules` to `public/cesium`; preserve the matching `CESIUM_BASE_URL` when changing asset hosting.

## Source map and ownership

| File | Responsibility |
| --- | --- |
| `app/domain/world.ts` | Domain types, scene registry, vessel fixtures, deterministic snapshots, provider contract, route validation and bounded local coordinate conversion. |
| `app/stores/world.ts` | Selected view/vessel/region, latest snapshot, quality, reduced motion, loading and errors. |
| `app/components/WorldCanvas.vue` | Lazy renderer creation, view transitions, retry, resize observation, provider subscription and teardown. |
| `app/renderers/types.ts` | Shared `SceneAdapter` lifecycle and geographic interaction callbacks. |
| `app/renderers/geographic.ts` | Cesium cameras, imagery fallback, region polygons, vessel markers and selection. |
| `app/renderers/local.ts` | Three.js scene, GLB/HDR loading, lighting, water, camera presets, animation and GPU cleanup. |
| `app/renderers/sea.ts` | Shared wave spectrum, CPU height/slope sampling and generated GLSL used by water and vessel motion. |
| `app/renderers/working-deck.ts` | Model-specific crew placement and added nets, floats, handlines, ropes, boxes, railings, ladders, lifebuoys and rigging. |
| `app/pages/index.vue` / `app/assets.css` | Application layout, navigation, panels, controls, typography and source credits. |
| `public/data/manifest.json` | Asset sources, licences, preprocessing notes and SHA-256 checksums. |
| `scripts/` / `tests/` | Data preparation, browser checks and focused domain/wave tests. |

Keep GPU objects out of Pinia. The renderer contract is `activate`, `suspend`, `resize`, `update`, `quality`, `reset` and `dispose`. The inactive renderer remains allocated to preserve its camera, but its render loop stops. The owning component unsubscribes from the provider, disconnects resize observation and disposes both renderers on unmount. Generation guards prevent stale asynchronous view changes from taking over the current view.

The demo provider sends a bounded deterministic snapshot every second. Environmental motion uses a separate elapsed-time clock; feed updates must not restart waves or move a paused scene. Reduce motion freezes the sea, vessel and sky while retaining camera interaction.

## Geography and assets

- Atlantic: 38 official NAFO division polygons from the 2021 reference download, converted to GeoJSON. These are unclipped administrative extents and can overlap land.
- Pacific: 48 DFO Pacific fisheries management areas, generalized from the source service. Preserve original `STATAREA` identifiers.
- Globe: optional NASA GIBS Blue Marble imagery with bundled Natural Earth raster fallback. The terrain is an ellipsoid with relief imagery, not a detailed elevation mesh.
- Local units are metres. `toLocal` is a bounded geographic-to-local approximation, not a global projection. Its Z axis points south (north maps to negative Z).
- The commercial trawler asset has bow +X and working deck Y=7.55 before conversion. Runtime rotates the bow to -Z, centres the hull, scales to 49.5 m and places the waterline 4.5 m above the keel. Deck additions use the original asset frame.

Current visual assets:

| Local asset | Origin / use |
| --- | --- |
| `public/assets/commercial-trawler.glb` | [Innerscene stern trawler](https://www.innerscene.com/tools/library/3d-parts/fishing-trawler-dc4c76eb), CC0; includes hull, wheelhouse, winches, net drums and stern gantry. |
| `public/assets/deck-crew.glb` | [Innerscene / MakeHuman worker](https://www.innerscene.com/tools/library/3d-parts/taylor-3d-person-worker-with-clipboard-4590fe0f), CC0; cloned three times, clothing recoloured and boots/handlines added. |
| `public/assets/north-atlantic-sky.hdr` | [Poly Haven Kloofendal pure sky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky), CC0, 4K HDR panorama. The filename describes its scene use; the photograph is not North Atlantic weather data. |
| `public/assets/waternormals.jpg` | Three.js ocean-example normal map, MIT. |

The previous `fishing-boat.glb` remains on disk but is no longer loaded. Its attribution remains in the manifest and README. Do not confuse it with the active commercial trawler.

The recent visual revision replaced painted cloud sprites with a photographed HDR background and matching filtered environment lighting, following the [Three.js HDR example](https://threejs.org/examples/webgl_materials_envmaps_hdr.html). Slow panorama rotation supplies distant cloud drift. The [Three.js ocean example](https://threejs.org/examples/webgl_shaders_ocean.html) supplies the water foundation, extended with shared multi-directional swells and boat buoyancy. Paint is toned down, roughness adjusted, and directional shadows added. The new sky and two GLBs total approximately **47 MB** before any delivery optimization.

## Extending the application

1. Add domain entities and scene configuration in `world.ts`; keep transport/authentication outside renderers.
2. For another geographic view, add its ID, GeoJSON, camera definition, relevant vessel fixtures and navigation/return handling. Current coast and view types explicitly enumerate the supported views.
3. For another detailed scene, add its asset URLs, size/waterline and camera positions/targets. **The component currently caches one local renderer initialized with one definition.** Multiple distinct local scenes require a deliberate change to renderer creation/caching and view branching; adding a registry entry alone is insufficient.
4. `working-deck.ts` is fitted to this particular hull. Reposition its equipment/crew for a new model, or introduce a typed per-hull outfitting configuration when a second hull justifies it.
5. To connect real data, implement `DataProvider.snapshot(time)` and `subscribe(listener)`, replacing `createDemoProvider()` at the ownership boundary. The subscription cleanup must close sockets/EventSource connections and cancel pending requests.
6. Add focused navigation/lifecycle checks for new views. Preserve return-camera behaviour, reduced motion and cleanup. Maintain provenance/checksums when changing bundled assets.

This is a modular application, not a general scene editor. Prefer small explicit extensions over an unnecessary framework rewrite.

## Validation and known limits

```bash
npm run typecheck
npm run lint
npm run test
npm run format:check
npm run build
# Start the production preview on port 3070 before browser checks:
node scripts/weather-check.mjs
node scripts/browser-check.mjs
node scripts/mobile-check.mjs
```

Playwright Chromium must be installed. Browser scripts use SwiftShader software WebGL and save screenshots to `artifacts/`; screenshot files may come from earlier runs, so check timestamps before treating them as current evidence.

As of this update, the latest source passes typecheck, ESLint, Prettier, all seven domain/wave tests and the production build. Bundled asset checksums were verified. An earlier pass of the new trawler/HDR scene passed browser shader, reduced-motion and resume checks. Final browser verification of the 4K sky and additional deck fittings is still being completed; do not infer a pass from the build alone. `VALIDATION.md` records the original broader navigation checks and software-renderer measurement.

Limits to preserve in any handoff:

- Clouds are a slowly rotating photographic panorama, not volumetric clouds or live weather.
- Crew are posed adapted worker figures, not animated fishing actions or custom scanned fishermen.
- Water reflections are planar approximations over a displaced surface. The boat rocks with the swells; it does not physically travel through the local ocean according to its displayed demonstration speed.
- Hardware GPU frame rate, target-laptop performance and comprehensive GPU/heap profiling remain unverified. The old 6.78 FPS measurement was software rendering of an earlier scene, not a result for the new assets.
- Geography is for demonstration, not navigation or current fishing-closure interpretation.
- No live backend, Spring Boot service, SSE/WebSocket feed, authentication, AKS integration or deployment is implemented here.
- The original ideas for DEV/TEST/PROD harbours, service/pod drilldowns, deployment animations, historical replay, species overlays and alerts remain future work.

## Working conventions

Follow the parent CFIS instructions: targeted changes, root-cause fixes, runtime validation and honest reporting of what was not tested. Do not deploy, alter infrastructure or introduce production data as part of visual work. Keep asset licensing and demonstration labels intact. Review actual screenshots after visual changes; compilation alone does not establish visual quality. No pipeline YAML or shell scripts were changed in this visual revision.
