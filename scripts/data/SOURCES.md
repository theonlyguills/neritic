# Fleet generator source data

Cached inputs for `scripts/generate-fleet.mjs`, retrieved 2026-11-21. Rebuild them with
`node scripts/generate-fleet.mjs --prepare` (network; User-Agent `asset-fetch/1.0`).
No CFIS system or record was used or contacted.

## land.json — land mask

- Sources:
  - https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_land.zip (Natural Earth 10m land, version 5.1.1)
  - https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_minor_islands.zip (Natural Earth 10m minor islands, version 4.1.0)
- Licence: public domain (Natural Earth).
- Processing: polygons from both layers clipped (Sutherland–Hodgman) to two boxes:
  Atlantic −72…−40°E, 39…72°N, and Pacific −140…−121°E, 46…57°N. Coordinates are stored as
  integers in units of 1e-4 degrees, with consecutive duplicate vertices removed. No other
  simplification. The generator rasterizes this mask conservatively (0.02° Atlantic, 0.01°
  Pacific: a cell counts as water only if no land touches it) for routing. The tests check
  points against the polygons directly.

## sch-harbours.json — harbour locations

- Source: Fisheries and Oceans Canada, Small Craft Harbours Locations and Information,
  https://open.canada.ca/data/en/dataset/262451e7-6416-47b5-8453-f31d212ea657, via its ArcGIS
  REST service
  https://egisp.dfo-mpo.gc.ca/arcgis/rest/services/open_data_donnees_ouvertes/small_craft_harbours_en/MapServer
  (layers 0 "Core Fishing" and 1 "Non-Core Fishing", `outSR=4326`).
- Licence: Open Government Licence – Canada.
- Processing: we kept the coastal provinces/territory (NL, NS, PE, NB, QC, BC, NU) and the fields harbour
  number, name, province, type, longitude and latitude. The generator then picks about 250
  harbours by their exact SCH name and gives them cleaned display names. For example, it uses
  "Rivière-au-Renard" for the source's "Rivère-au-Renard" and "Daajing Giids" for "Queen Charlotte".

## Positions not in the SCH layer (hard-coded in the generator)

- Source: Canadian Geographical Names Database (NRCan),
  https://geogratis.gc.ca/services/geoname/en/geonames?q=…
- Licence: Open Government Licence – Canada.
- Records used:
  - Telegraph Cove, BC: CGNDB key `JCRUA`, 50.548333 N, 126.83 W.
  - Iqaluit, NU: CGNDB key `OATRP`, 63.75 N, 68.516667 W.
  - Qikiqtarjuaq, NU: CGNDB key `OAUGJ`, 67.554722 N, 64.028056 W.

## Also read (not cached here)

- `public/data/atlantic.geojson`: the NAFO divisions. Used for the `ground.area` labels.
- `public/data/pacific.geojson`: the DFO PFMAs. Used for the `ground.area` labels and to keep
  Pacific grounds in Canadian waters.

Both files are already listed in `public/data/manifest.json`.
