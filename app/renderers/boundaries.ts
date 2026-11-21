/**
 * Management-area boundaries (NAFO divisions, Pacific management areas) as plain Cesium
 * primitives rather than entities: geometry is built once in web workers (also while
 * hidden, so a coast can be preloaded), showing or hiding costs nothing per frame, and the
 * live activity shading updates per-instance colours without rebuilding geometry.
 */
import * as C from 'cesium'

type Ring = [number, number][]
interface Feature {
  id?: string | number
  properties?: { label?: string }
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: Ring[] | Ring[][] }
}

const STROKE = C.Color.fromCssColorString('#9ac5c1')
const FILL = C.Color.fromCssColorString('#5fd3b6')

export class BoundaryLayer {
  lines: C.Primitive
  fills: C.Primitive
  labels: C.LabelCollection
  /** Area key (its label) → fill instance ids and its label. */
  areas = new Map<string, { ids: string[]; label?: C.Label; text: string; alpha: number }>()
  private shown = false

  constructor(
    private scene: C.Scene,
    data: { features: Feature[] },
  ) {
    const lineInstances: C.GeometryInstance[] = []
    const fillInstances: C.GeometryInstance[] = []
    const labelAt = new Map<string, { centre: C.Cartesian3; radius: number }>()
    for (const [f, feature] of data.features.entries()) {
      const key = String(feature.properties?.label || feature.id || f)
      const polygons =
        feature.geometry.type === 'Polygon'
          ? [feature.geometry.coordinates as Ring[]]
          : (feature.geometry.coordinates as Ring[][])
      const area = this.areas.get(key) ?? { ids: [], text: key, alpha: -1 }
      this.areas.set(key, area)
      for (const [p, rings] of polygons.entries()) {
        const outer = rings[0]
        if (!outer || outer.length < 3) continue
        const positions = C.Cartesian3.fromDegreesArray(outer.flat())
        const holes = rings
          .slice(1)
          .map((ring) => new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(ring.flat())))
        // Boundary as a wide polyline: GL outlines are 1 px (width is ignored on ANGLE) and
        // stair-step. The outline material anti-aliases its own edges in the shader, and a
        // transparent 1 px outline turns that into a soft edge where MSAA is unavailable.
        // Rhumb lines follow NAFO's lines of latitude and longitude.
        for (const ring of [outer, ...rings.slice(1)])
          lineInstances.push(
            new C.GeometryInstance({
              geometry: new C.PolylineGeometry({
                positions: C.Cartesian3.fromDegreesArray([...ring.flat(), ...ring[0]!]),
                width: 3,
                arcType: C.ArcType.RHUMB,
                vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
              }),
            }),
          )
        const id = `area:${key}:${f}:${p}`
        area.ids.push(id)
        fillInstances.push(
          new C.GeometryInstance({
            id,
            geometry: new C.PolygonGeometry({
              polygonHierarchy: new C.PolygonHierarchy(positions, holes),
              arcType: C.ArcType.RHUMB,
              vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(FILL.withAlpha(0.03)) },
          }),
        )
        const bounds = C.BoundingSphere.fromPoints(positions)
        const best = labelAt.get(key)
        if (!best || bounds.radius > best.radius)
          labelAt.set(key, {
            centre: C.Ellipsoid.WGS84.scaleToGeodeticSurface(bounds.center),
            radius: bounds.radius,
          })
      }
    }
    this.fills = new C.Primitive({
      geometryInstances: fillInstances,
      appearance: new C.PerInstanceColorAppearance({ translucent: true, flat: true }),
      show: false,
    })
    this.lines = new C.Primitive({
      geometryInstances: lineInstances,
      appearance: new C.PolylineMaterialAppearance({
        material: C.Material.fromType('PolylineOutline', {
          color: STROKE.withAlpha(0.7),
          outlineColor: STROKE.withAlpha(0),
          outlineWidth: 1,
        }),
      }),
      show: false,
    })
    this.labels = new C.LabelCollection({ scene })
    this.labels.show = false
    for (const [key, { centre, radius }] of labelAt)
      this.areas.get(key)!.label = this.labels.add({
        position: centre,
        text: key,
        font: '600 13px "Segoe UI", sans-serif',
        fillColor: C.Color.WHITE.withAlpha(0.92),
        outlineColor: C.Color.fromCssColorString('#123440'),
        outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new C.DistanceDisplayCondition(
          0,
          Math.min(4200000, Math.max(220000, radius * 20)),
        ),
      })
    scene.primitives.add(this.fills)
    scene.primitives.add(this.lines)
    scene.primitives.add(this.labels)
  }

  /** Area key for a picked fill (`scene.pick(...).id`), if it is one of ours. */
  areaOf(id: unknown) {
    if (typeof id !== 'string' || !id.startsWith('area:')) return undefined
    const key = id.slice(5, id.lastIndexOf(':', id.lastIndexOf(':') - 1))
    return this.areas.has(key) ? key : undefined
  }

  setShown(shown: boolean) {
    this.shown = shown
    this.fills.show = this.lines.show = this.labels.show = shown
  }

  /** Fill opacity by vessels fishing in each area now; labels carry the count. */
  shade(counts: Map<string, number>) {
    if (!this.shown || !this.fills.ready) return
    const max = Math.max(1, ...counts.values())
    for (const [key, area] of this.areas) {
      const n = counts.get(key) ?? 0
      const alpha = Math.round((0.03 + 0.3 * Math.sqrt(n / max)) * 100) / 100
      if (alpha !== area.alpha) {
        area.alpha = alpha
        const value = C.ColorGeometryInstanceAttribute.toValue(FILL.withAlpha(alpha))
        for (const id of area.ids) {
          const attributes = this.fills.getGeometryInstanceAttributes(id)
          if (attributes) attributes.color = value
        }
      }
      const text = n ? `${key}  ·  ${n}` : key
      if (area.label && text !== area.text) {
        area.text = text
        area.label.text = text
      }
    }
  }

  destroy() {
    this.scene.primitives.remove(this.fills)
    this.scene.primitives.remove(this.lines)
    this.scene.primitives.remove(this.labels)
  }
}
