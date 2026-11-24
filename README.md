# Neritic — CFIS fleetscape

A demonstration of what a nationwide CFIS (Canadian Fisheries Information System) operating
picture could look like. It runs locally in the browser and needs no accounts or credentials.
**All vessels, licences, hails and landings are synthetic.** Geography, harbours, terrain,
streets and buildings are real public data.

## Executive summary

- **National dashboard on a 3D globe.** It shows live counts of active licences, vessels at
  sea (from hails), hails in the last 24 hours, estimated landings and vessels in port. A
  streaming hail feed sits alongside, with breakdowns by DFO region and fishery. Arcs trace
  each hail between harbour and fishing ground, and light beams rise over the major harbours.
- **Navigate by zooming.** Scrolling into a coast swoops into the Atlantic (NAFO divisions) or
  Pacific (management areas) view; scrolling out returns to Canada. Areas are shaded by live
  fishing activity.
- **About 2,800 vessels, clustered.** Vessels group into numbered bubbles that split as you
  zoom. Each bubble's ring shows the share at sea and in port. Individual vessels show their
  heading and status.
- **Board any vessel.** The globe dives into a 3D close-up chosen from where the vessel is and
  what it is doing:
  - open ocean offshore;
  - one of **60 real places** (58 fishing harbours plus The Narrows and Johnstone
    Strait) built from real elevation data and OpenStreetMap, with real streets, buildings,
    wharves and gas stations;
  - fishing just off a harbour's mouth.

  Every synthetic boat's home port is one of the built harbours, so in-port, arriving and
  inshore boats always open the scene for where they are.
- **Cinematic entrances.** Town scenes open with a slow letterboxed flyover over the real
  streets to the boat. Arriving vessels motor in along the real approach to their berth.
- **Day or dusk.** A single toggle switches the map and the scenes. The globe shows the real
  day/night line across Canada with city lights on the night side. Scenes turn to sunset with
  lit windows, street lamps and boats' navigation lights.
- **CFIS-flavoured detail.** Each vessel shows its CFV number, licences held (with season
  status) and a timeline of its recent hails with estimated landings. Live hail alerts pop up
  on the map, with one click to fly to the vessel or board it.
- **Measured on a work laptop GPU (Intel Iris Xe, in Edge):**
  - maps: about 55 fps;
  - coastal scenes: about 35–54 fps;
  - transitions: free of shader stalls.
- **Ready for real data.** The whole UI reads one `Snapshot` shape. Swapping the synthetic
  provider for a CFIS feed (licences, hail-outs and hail-ins, positions) is a contained change
  (see [Connecting real data](#connecting-real-data)).

## Run

Node 24 LTS and npm (the lockfile uses npm).

```bash
npm ci
npm run dev            # http://127.0.0.1:3070
# or a production build:
npm run build
PORT=3070 HOST=127.0.0.1 node .output/server/index.mjs
```

Online services:
- NASA GIBS imagery (Blue Marble by day, Black Marble city lights at dusk) loads from the
  network.
- Without a network the globe falls back to the bundled Natural Earth raster, and dusk has no
  city lights.
- Everything else, including all 60 scenes, is bundled.

## Demo walkthrough (about 5 minutes)

1. **Canada.** The page opens with a push-in from space. Talk through the KPIs, the live hail
   feed and the region and fishery bars. Hail alerts pop up at the top every few seconds.
2. **Into a coast.** Scroll over Atlantic Canada, or click a bubble or the "ATLANTIC" label.
   Point out the bubbles splitting as you zoom, and the NAFO areas shaded and labelled with
   live counts. Click an area, or search a vessel by name or CFV number.
3. **Board.** Pick one of the close-up scenes in the panel, use an alert's "Board ›", or
   double-click a vessel. Good choices:

   | Vessel | Setting |
   |---|---|
   | Northern Light | Offshore trawler, Grand Banks |
   | Signal Hill | Inshore Cape Islander at The Narrows, St. John's (town flyover) |
   | Lunenburg Star | Alongside at Lunenburg, about to sail (town flyover) |
   | Harbour Breton Pride | Alongside at Harbour Breton, NL |
   | Cassidy Kay | Alongside at Channel-Port aux Basques, NL |
   | Miss Brittany | Alongside at Bay de Verde, NL |
   | Le Madelinot | Alongside at Cap-aux-Meules, Magdalen Islands |
   | Haida Dawn | Seiner in Johnstone Strait |
   | Skeena Spirit | Arriving at the Prince Rupert floats |
   | Milbanke Harvester | Alongside at Daajing Giids, Haida Gwaii |
   | Comox Pride | Seiner alongside at Comox |

   These are pinned in `HERO_PINS` (simulation.ts) and listed in `FEATURED` (world.ts), so they
   are always in the state shown. A coast's panel lists its own scenes. Any other boat in port
   opens its own harbour too, e.g. Lady Kirsten at Bay de Verde.
4. **In the scene.** Orbit with the mouse; the presets (Elevated, Water level, Working deck)
   are on the bottom bar. Sound is on by default: sea, wind, gulls, deck clanks and an engine
   that sits in the engine room. The panel shows the licences and recent hails.
5. **Dusk.** Flip ☀ Day / ☾ Dusk, on the map (the day/night line and city lights) or in a
   scene (sunset and lights). Boarding with dusk on gives a dusk flyover.
6. **Back out.** "Return to Atlantic" rises back to the map; the breadcrumb or scrolling out
   returns to Canada.

During a flyover, "Skip ›" or any click lands it at once. Reduce motion turns all transitions
into cuts. Browser back/forward and links such as `?view=atlantic` or
`?view=vessel&vessel=nl-02` work.

## How it works

### Data and simulation (synthetic)

- `public/data/harbours.json`: **250 real fishing harbours.** 247 come from DFO Small Craft
  Harbours open data and three from the Canadian Geographical Names Database. Each has its DFO
  region, coast, and an approach point on open water.
- `public/data/fleet.json`: **2,799 synthetic vessels**, generated deterministically by
  `scripts/generate-fleet.mjs`. Each has a name, CFV number, length, gear, species, home
  harbour, fishing ground (on water, labelled with its NAFO division or Pacific area) and a
  route that stays on water. Licence totals: 17,363 across the six DFO regions.
  - Home ports are limited to harbours with a built scene (or within 14 km of one). Each
    fishery's real port list hands the weight of unbuilt harbours to the nearest built one in
    the same region, so the fleet sits in 107 home ports.
- `app/domain/simulation.ts`: a deterministic trip cycle per vessel: alongside → hail out →
  transit → fishing → hail in (with an estimated landing) → transit → landing.
  - Positions, statuses and every hail are pure functions of the demo clock.
  - The map, the feed, the KPIs, the vessel's hail history and its licences therefore always
    agree.
  - Rolling 24-hour counters update incrementally (about 4 ms per tick).
  - Five hero vessels are pinned to fixed statuses so the walkthrough is predictable.
- The demo clock runs at 0.22 simulated seconds per real second; one simulated "day" is 2,400 s.

### Map (Cesium)

- `app/renderers/geographic.ts`: the globe, cameras, the blurred swoop between Canada and the
  coasts, the dive into a vessel and the rise back out, zoom-gesture navigation, and day/dusk
  lighting with NASA city lights.
- `app/renderers/fleet-layer.ts`: Supercluster bubbles (only what is in view is laid out),
  vessel icons by status, hail arcs, harbour beams and alert pings.
- `app/renderers/boundaries.ts`: NAFO and Pacific areas as Cesium primitives, built once in
  workers. Hiding them is free, and their activity shading updates colours only.
- Status colours (`app/domain/palette.ts`) were checked for colour-vision deficiency and
  contrast on the dark panels.

### Close-up scenes (Three.js)

- `app/renderers/local.ts`: one renderer that swaps scenery, hull, sky and lighting:
  - ocean with Gerstner swell, wake, bow foam and shoreline surf (`ocean.ts`, `sea.ts`);
  - buoyancy;
  - flights (spiral entrance and town flyover);
  - the arrival run;
  - dusk;
  - navigation lights;
  - soundscape.
- `app/renderers/scenery.ts` builds a real place from `public/scenery/<id>/`:
  - **Terrain:** a 513² elevation grid, with the coastline snapped to OpenStreetMap.
  - **Buildings:** extruded footprints with roofs, front doors facing the street, sashed
    windows, chimneys, and lit windows at dusk.
  - **Waterfront:** wharves and breakwaters, thinned to a small-town waterfront.
  - **Landscape:** trees by land cover and slope; lighthouses and landmarks.
- `app/renderers/streets.ts`: real streets (asphalt, centre lines, sidewalks), utility poles
  and wires, parked cars and pickups, gas stations at their real locations, and street lamps
  at dusk.
- **Hulls:** a 47.5 m stern trawler for large offshore vessels; a scanned Nova Scotia Cape
  Islander (Atlantic) or a West Coast seiner (Pacific) for inshore boats.

**Which scene a vessel gets** (`chooseScenery` in `app/domain/scenery.ts`):

| Vessel | Scene |
|---|---|
| In port or arriving | Its own home harbour if built; else the nearest built harbour within 15 km; else the nearest built harbour on its coast, labelled "(representative)" |
| Fishing inshore | The nearest built inshore scene within 25 km; else the nearest built harbour within 40 km, with the boat just outside the harbour mouth; else a representative inshore scene |
| Offshore | Open ocean |

The scene name shows above the vessel's name and in the panel.

**Loading:** nothing scene-related loads at startup except the default open-ocean scene, in
the background.
- A harbour is about 1–1.5 MB and builds in about 1 s.
- Selecting a vessel on the map loads and pre-compiles its scene while hidden, and the dive
  covers any remainder.
- Loaded scenes stay cached for the session.

### Building the real places

```bash
node scripts/fetch-scenery.mjs <id>               # one place defined in the script
node scripts/fetch-scenery.mjs --harbours --skip-existing   # every major harbour in harbours.json
node scripts/fetch-scenery.mjs --harbours --ids comox,tofino   # specific harbours, major or not
node scripts/fetch-streets.mjs <id> ...           # streets, fuel stations, parking
node scripts/index-sceneries.mjs                  # refresh app/domain/places.generated.json
```

- **Sources:** AWS Terrain Tiles (Canadian CDEM elevation, Open Government Licence) and one
  OpenStreetMap Overpass query per place.
- **Caching:** raw downloads go to `~/marine-assets-src/scenery/<id>/` and are not committed.
- **Placement:** the scripts find a real berth alongside a wharf and an arrival path from the
  harbour entrance.
- **Not built:** St. Anthony, Grand Bank and Tignish have no usable mapped wharf. Boats from
  those ports use the nearest built harbour.
- **Manual follow-up:** record new files in `public/data/manifest.json`.

## What is real and what is illustrative

| Real | Illustrative or synthetic |
|---|---|
| Coastlines, hills and harbour shapes (elevation about 8–16 m per sample; cliffs come out softer than in reality) | All vessels, names, CFV numbers, licences, hails, tracks and landings |
| Building positions and footprints, streets, wharves, gas stations, parking lots | Building heights (mostly guessed by type), roof shapes, paint colours, window and door layouts |
| Harbour locations; NAFO and Pacific area boundaries | Cars, poles, wires, trees, and the gas stations' styling |
| | Sky, weather, sea state and the sun's position |

## Connecting real data

The UI depends only on `DataProvider` (`app/domain/world.ts`): `snapshot(time)` and
`subscribe(listener)`, which return a `Snapshot` of vessels (with status), stats, the hail
feed, licence totals and harbours.
- Replace `loadDemoProvider()` in `app/components/WorldCanvas.vue` with a provider fed by
  CFIS: licences, hail-outs and hail-ins, and positions.
- Keep identifiers and timestamps stable between snapshots.
- Close the transport on unsubscribe.
- Keep authentication out of the renderers.

The per-vessel licences and hail history currently come from the simulation
(`licencesOf`, `history`) and would map to CFIS licence and hail records.

## Checks

```bash
npm run typecheck && npm run lint && npm test && npm run build
# Browser checks against a running server (default http://127.0.0.1:3070):
NERITIC_URL=http://127.0.0.1:3072 node scripts/browser-check.mjs   # also mobile-check, weather-check
```

- **Default checks:** headless Chromium with software WebGL. They are slow, and their frame
  rate is meaningless.
- **Edge mode:** `NERITIC_BROWSER=edge` runs the checks in Windows Edge on the real GPU (from
  WSL with mirrored networking). About 2 minutes instead of 10 or more. An Edge window opens
  while they run.
- **Output:** screenshots go to `artifacts/`, which is git-ignored.
- **Unit tests:** cover the wave model, the simulation (determinism, hail windows, incremental
  counters, licences and history), scene choice, and the fleet and harbour data on water.

## Extending

- **Another close-up place:** see [Building the real places](#building-the-real-places). To
  hand-tune a place (sky, sun angle, flyover), add a `SCENERIES` entry in
  `app/domain/scenery.ts`; otherwise the per-coast harbour template is used.
- **Another map view:** add a `SceneDefinition` (anchor, distance, pitch) to
  `app/domain/world.ts` and a `public/data/<id>.geojson` with `properties.label`. Zoom
  gestures are in `GeographicRenderer.watchZoom`.
- **Another hull:** add it to `BOATS` with its length, beam, waterline, engine room and
  measured navigation-light positions.

## Limits

- The globe uses ellipsoid terrain with shaded-relief imagery, not an elevation mesh.
- NAFO polygons are the official 2021 unclipped extents and can extend over land. Pacific
  areas are the DFO PFMA layer, generalised. Neither is a navigational or closure authority.
- The engine sound is a deep procedural drone. A harmonic exciter carries it on laptop
  speakers; it is fuller on headphones.
- No generic procedural coast exists yet. An inshore boat more than 40 km from any built
  harbour would get a labelled representative scene. Because home ports are limited to built
  harbours, no boat in the demo fleet does. Real CFIS data would bring back every harbour, so
  more places would need building, or a generic coast.
- Eight harbours could not be built because OpenStreetMap has no usable wharf mapped there
  (St. Anthony, Grand Bank, Tignish, Greenspond, Englee, Flower's Cove, North Lake,
  Grande-Entrée).

## Credits

Sources, licences, processing notes and checksums for every bundled file are in
`public/data/manifest.json`. The app's "Sources" dialog lists the attributions.

- **Map and boundaries:**
  - NASA GIBS (Blue Marble, VIIRS Black Marble);
  - Natural Earth (public domain);
  - NAFO divisions (official 2021 download);
  - DFO Pacific management areas and Small Craft Harbours (Open Government Licence – Canada).
- **Scenery:** © OpenStreetMap contributors (ODbL); Terrain Tiles with NRCan CDEM (Open
  Government Licence – Canada), ETOPO1 (NOAA), GMTED2010 and SRTM (USGS).
- **Models** (all CC BY 4.0, via Sketchfab):
  - "Fishing Trawler 40m" and "Fishing Vessel IV" by agt14032013 (bucket by Melonpolygons,
    fish by yimit);
  - "Alma Paulin Fishing Boat" by Air Digital;
  - crew from Innerscene / MakeHuman (CC0).
- **Skies** (Poly Haven, CC0): Table Mountain 2, Qwantani Late Afternoon, Rustig Koppie,
  Kloofendal Overcast, Industrial Sunset 02.
- **Sound:**
  - "BioAcoustica Lyme Gulls" by Edward Baker and "Shoreline, Schull" by Benjamin Burns (CC BY
    3.0);
  - other gull and deck recordings are CC0 or public domain;
  - engine, wind and wash are generated in the browser.
- **Water rendering:** based on the Three.js ocean example (MIT).
