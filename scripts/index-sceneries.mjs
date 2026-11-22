/**
 * Index of the close-up sceneries on disk (public/scenery/<id>/scenery.json), for the app
 * to pick a vessel's scene by where it is: writes app/domain/places.generated.json.
 *
 *   node scripts/index-sceneries.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.join('public', 'scenery')
const places = []
for (const id of fs.readdirSync(root).sort()) {
  const file = path.join(root, id, 'scenery.json')
  if (!fs.existsSync(file)) continue
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
  places.push({
    id,
    type: meta.type,
    place: meta.place,
    province: meta.province,
    coast: meta.forest === 'dense-conifer' || meta.province === 'BC' ? 'pacific' : 'atlantic',
    lon: meta.center.lon,
    lat: meta.center.lat,
    arrival: Array.isArray(meta.arrival) && meta.arrival.length > 1,
    buildings: meta.features?.buildings?.length ?? 0,
  })
}
fs.writeFileSync('app/domain/places.generated.json', JSON.stringify(places, null, 1) + '\n')
console.log(`${places.length} sceneries indexed`)
