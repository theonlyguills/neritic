import { read } from 'shapefile'
import proj4 from 'proj4'
import { readFileSync, writeFileSync } from 'node:fs'
const base = process.argv[2]
if (!base)
  throw new Error(
    'Usage: node scripts/prepare-nafo.mjs /path/to/NAFO_Divisions_2021_poly_not_clipped (without extension)',
  )
const source = readFileSync(`${base}.prj`, 'utf8')
const data = await read(`${base}.shp`, `${base}.dbf`)
function coordinates(value) {
  if (typeof value[0] === 'number')
    return proj4(source, 'EPSG:4326', value).map((n) => Number(n.toFixed(5)))
  return value.map(coordinates)
}
console.log(data.features[0].properties)
for (const [i, feature] of data.features.entries()) {
  feature.geometry.coordinates = coordinates(feature.geometry.coordinates)
  feature.id = `nafo-${i}`
  feature.properties.label = String(
    feature.properties.NAFO_DIV ||
      feature.properties.NAFO_Div ||
      feature.properties.Division ||
      Object.values(feature.properties).find(
        (v) => typeof v === 'string' && /^[0-6][A-Za-z]+$/.test(v),
      ) ||
      `Division ${i + 1}`,
  )
}
writeFileSync('public/data/atlantic.geojson', JSON.stringify(data))
console.log(`Converted ${data.features.length} divisions`)
