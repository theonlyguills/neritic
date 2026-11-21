/**
 * Map layer for the live fleet: zoom-dependent cluster bubbles (Supercluster), heading-
 * oriented vessel icons when zoomed in, animated hail arcs between harbours and grounds,
 * and light beams over the major harbours. All primitives are pooled and updated in place.
 */
import * as C from 'cesium'
import Supercluster from 'supercluster'
import type { Coast, Harbour } from '../domain/fleet'
import type { HailEvent, LiveVessel } from '../domain/simulation'
import { STATUS_COLOUR } from '../domain/palette'

export type FleetPick =
  | { kind: 'cluster'; lon: number; lat: number; zoom: number; count: number }
  | { kind: 'vessel'; id: string }
  | { kind: 'harbour'; id: string }

const HAIL_OUT = '#62b4f7'
const HAIL_IN = '#eb9a48'
const SEA = STATUS_COLOUR.fishing
const PORT = STATUS_COLOUR['in-port']

/** Supercluster zoom for a camera height: one zoom step per halving of altitude. */
export function zoomForHeight(height: number) {
  return Math.log2(7.0e7 / Math.max(height, 1))
}
export function heightForZoom(zoom: number) {
  return 7.0e7 / 2 ** zoom
}

function canvas(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  draw(c.getContext('2d')!, size)
  return c
}

/** Bubble with a status ring: the teal arc is the share at sea, violet the share in port. */
function bubble(seaShare: number) {
  return canvas(160, (g, s) => {
    const r = s / 2
    const glow = g.createRadialGradient(r, r, r * 0.35, r, r, r)
    glow.addColorStop(0, 'rgba(63,209,168,0.3)')
    glow.addColorStop(1, 'rgba(63,209,168,0)')
    g.fillStyle = glow
    g.fillRect(0, 0, s, s)
    g.beginPath()
    g.arc(r, r, r * 0.56, 0, Math.PI * 2)
    const fill = g.createRadialGradient(r * 0.85, r * 0.75, 2, r, r, r * 0.56)
    fill.addColorStop(0, 'rgba(26,74,88,0.95)')
    fill.addColorStop(1, 'rgba(8,30,40,0.92)')
    g.fillStyle = fill
    g.fill()
    g.lineWidth = s * 0.055
    g.lineCap = 'round'
    const start = -Math.PI / 2
    const split = start + seaShare * Math.PI * 2
    if (seaShare > 0.01) {
      g.strokeStyle = SEA
      g.beginPath()
      g.arc(r, r, r * 0.6, start, split)
      g.stroke()
    }
    if (seaShare < 0.99) {
      g.strokeStyle = PORT
      g.beginPath()
      g.arc(r, r, r * 0.6, split, start + Math.PI * 2)
      g.stroke()
    }
  })
}

/** A small hull, bow up, in the status colour; rotated on the map to the heading. */
function hull(colour: string) {
  return canvas(64, (g, s) => {
    g.translate(s / 2, s / 2)
    g.shadowColor = colour
    g.shadowBlur = 10
    g.fillStyle = colour
    g.strokeStyle = 'rgba(6,24,32,0.9)'
    g.lineWidth = 3
    g.beginPath()
    g.moveTo(0, -20)
    g.quadraticCurveTo(10, -6, 8, 16)
    g.lineTo(-8, 16)
    g.quadraticCurveTo(-10, -6, 0, -20)
    g.closePath()
    g.stroke()
    g.fill()
  })
}

function ring() {
  return canvas(128, (g, s) => {
    g.strokeStyle = '#ffe2a8'
    g.lineWidth = 5
    g.shadowColor = '#ffcf7a'
    g.shadowBlur = 12
    g.beginPath()
    g.arc(s / 2, s / 2, s / 2 - 12, 0, Math.PI * 2)
    g.stroke()
  })
}

interface Arc {
  entity: C.Entity
  born: number
}

export class FleetLayer {
  billboards: C.BillboardCollection
  labels: C.LabelCollection
  index = new Supercluster<{ id: string; sea: number }, { sea: number }>({
    radius: 66,
    maxZoom: 10,
    map: (p) => ({ sea: p.sea }),
    reduce: (acc, p) => {
      acc.sea += p.sea
    },
  })
  vessels = new Map<string, LiveVessel>()
  coast: Coast | undefined
  selected = ''
  selection: C.Billboard
  arcs: Arc[] = []
  arcSource = new C.CustomDataSource('hails')
  harbourSource = new C.CustomDataSource('harbours')
  harbourCounts = new Map<string, number>()
  private beamHeights = new Map<string, number>()
  private images = new Map<string, HTMLCanvasElement>()
  private occluder: C.EllipsoidalOccluder
  private dirty = true
  private lastHeight = 0
  private lastZoom = -1
  visible = true
  /** Scripted camera moves (dive, swoop): keep the current layout, skip re-clustering. */
  frozen = false
  private loaded = false

  constructor(private viewer: C.Viewer) {
    const scene = viewer.scene
    this.billboards = scene.primitives.add(new C.BillboardCollection({ scene }))
    this.labels = scene.primitives.add(new C.LabelCollection({ scene }))
    this.selection = this.billboards.add({
      position: C.Cartesian3.ZERO,
      show: false,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    })
    this.setImage(this.selection, 'ring', ring)
    this.occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, C.Cartesian3.ZERO)
    void viewer.dataSources.add(this.arcSource)
    void viewer.dataSources.add(this.harbourSource)
    scene.preRender.addEventListener(() => this.frame())
    // The layout covers the visible area: redo it when a pan or zoom settles.
    viewer.camera.moveEnd.addEventListener(() => (this.dirty = true))
    viewer.camera.percentageChanged = 0.15
    viewer.camera.changed.addEventListener(() => (this.dirty = true))
  }

  private setImage(b: C.Billboard, key: string, draw: () => HTMLCanvasElement) {
    let image = this.images.get(key)
    if (!image) {
      image = draw()
      this.images.set(key, image)
    }
    b.setImage(key, image)
  }

  /** Restrict the layer to one coast (regional views) or show everything (overview). */
  setCoast(coast: Coast | undefined) {
    if (coast === this.coast) return
    this.coast = coast
    this.rebuild()
  }

  setVessels(vessels: LiveVessel[]) {
    this.vessels.clear()
    for (const v of vessels) this.vessels.set(v.id, v)
    this.rebuild()
  }

  private rebuild() {
    const points: Supercluster.PointFeature<{ id: string; sea: number }>[] = []
    for (const v of this.vessels.values()) {
      if (this.coast && v.coast !== this.coast) continue
      points.push({
        type: 'Feature',
        properties: { id: v.id, sea: v.status === 'in-port' ? 0 : 1 },
        geometry: { type: 'Point', coordinates: [v.longitude, v.latitude] },
      })
    }
    this.index.load(points)
    this.loaded = true
    this.dirty = true
  }

  select(id: string) {
    this.selected = id
    this.dirty = true
  }

  setVisible(visible: boolean) {
    this.visible = visible
    this.billboards.show = this.labels.show = visible
    this.arcSource.show = this.harbourSource.show = visible
  }

  /** Re-cluster when the camera height changes enough to matter, or the data changed. */
  private frame() {
    if (!this.visible) return
    const camera = this.viewer.camera
    const height = camera.positionCartographic.height
    const zoom = zoomForHeight(height)
    if (this.frozen || (!this.dirty && Math.abs(height - this.lastHeight) / height < 0.02)) {
      this.occlusion(camera)
      this.animate()
      return
    }
    this.lastHeight = height
    this.dirty = false
    this.layout(zoom)
    this.occlusion(camera)
    this.animate()
  }

  private pool: { b: C.Billboard; l: C.Label; pick?: FleetPick; position: C.Cartesian3 }[] = []

  private layout(zoom: number) {
    if (!this.loaded) return
    // Only what the camera can see (plus a margin): close in, that is a few dozen vessels
    // rather than the whole fleet.
    const view = this.viewer.camera.computeViewRectangle()
    const margin = 4
    const bbox: [number, number, number, number] =
      view && zoom > 4 && view.east > view.west
        ? [
            C.Math.toDegrees(view.west) - margin,
            Math.max(-85, C.Math.toDegrees(view.south) - margin),
            C.Math.toDegrees(view.east) + margin,
            Math.min(85, C.Math.toDegrees(view.north) + margin),
          ]
        : [-180, -85, 180, 85]
    const clusters = this.index.getClusters(bbox, zoom)
    const showNames = zoom >= 8.6
    this.lastZoom = zoom
    let i = 0
    for (const c of clusters) {
      const [lon, lat] = c.geometry.coordinates as [number, number]
      let slot = this.pool[i]
      if (!slot) {
        slot = {
          b: this.billboards.add({ position: C.Cartesian3.ZERO }),
          l: this.labels.add({
            position: C.Cartesian3.ZERO,
            font: '600 13px "Segoe UI", sans-serif',
            fillColor: C.Color.WHITE,
            outlineColor: C.Color.fromCssColorString('#06202a'),
            outlineWidth: 3,
            style: C.LabelStyle.FILL_AND_OUTLINE,
            horizontalOrigin: C.HorizontalOrigin.CENTER,
            verticalOrigin: C.VerticalOrigin.CENTER,
          }),
          position: new C.Cartesian3(),
        }
        this.pool.push(slot)
      }
      i++
      const { b, l } = slot
      C.Cartesian3.fromDegrees(lon, lat, 0, undefined, slot.position)
      b.position = slot.position
      l.position = slot.position
      b.disableDepthTestDistance = l.disableDepthTestDistance = Number.POSITIVE_INFINITY
      const props = c.properties as Supercluster.ClusterProperties & { sea: number; id?: string }
      if (props.cluster) {
        const count = props.point_count
        const share = Math.round((props.sea / count) * 10) / 10
        this.setImage(b, `bubble-${share}`, () => bubble(share))
        b.scale = (0.3 + Math.min(0.42, Math.log10(count) * 0.17)) * 1.05
        b.rotation = 0
        b.alignedAxis = C.Cartesian3.ZERO
        b.color = C.Color.WHITE
        b.pixelOffset = C.Cartesian2.ZERO
        l.text = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
        l.font =
          count >= 100 ? '600 14px "Segoe UI", sans-serif' : '600 12px "Segoe UI", sans-serif'
        l.pixelOffset = C.Cartesian2.ZERO
        l.horizontalOrigin = C.HorizontalOrigin.CENTER
        l.fillColor = C.Color.WHITE
        l.showBackground = false
        slot.pick = {
          kind: 'cluster',
          lon,
          lat,
          count,
          zoom: this.index.getClusterExpansionZoom(props.cluster_id),
        }
        l.show = true
      } else {
        const v = this.vessels.get(props.id!)!
        const selected = v.id === this.selected
        this.setImage(b, `hull-${v.status}`, () => hull(STATUS_COLOUR[v.status]))
        b.scale = selected ? 0.62 : 0.42
        b.alignedAxis = C.Cartesian3.UNIT_Z
        b.rotation = -C.Math.toRadians(v.heading)
        b.color = C.Color.WHITE
        b.pixelOffset = C.Cartesian2.ZERO
        l.text = v.name
        l.font = selected ? '600 13px "Segoe UI", sans-serif' : '500 11px "Segoe UI", sans-serif'
        l.horizontalOrigin = C.HorizontalOrigin.LEFT
        l.pixelOffset = new C.Cartesian2(14, 0)
        l.showBackground = true
        l.backgroundColor = C.Color.fromCssColorString('#082029').withAlpha(0.72)
        l.backgroundPadding = new C.Cartesian2(6, 3)
        l.show = showNames || selected
        slot.pick = { kind: 'vessel', id: v.id }
      }
      ;(b as unknown as { id: unknown }).id = slot.pick
      ;(l as unknown as { id: unknown }).id = slot.pick
      b.show = true
    }
    for (; i < this.pool.length; i++) {
      this.pool[i]!.b.show = false
      this.pool[i]!.l.show = false
      this.pool[i]!.pick = undefined
    }
    this.placeSelection()
  }

  private placeSelection() {
    const v = this.vessels.get(this.selected)
    const shown = v && (!this.coast || v.coast === this.coast) && this.lastZoom >= 6
    this.selection.show = !!shown
    if (v && shown) this.selection.position = C.Cartesian3.fromDegrees(v.longitude, v.latitude)
  }

  /** Hide markers over the horizon (they are drawn without depth test). */
  private occlusion(camera: C.Camera) {
    this.occluder.cameraPosition = camera.positionWC
    for (const slot of this.pool) {
      if (!slot.pick) continue
      const visible = this.occluder.isPointVisible(slot.position)
      slot.b.show = visible
      if (!visible) slot.l.show = false
      else if (slot.pick.kind === 'cluster') slot.l.show = true
      else slot.l.show = this.lastZoom >= 8.6 || slot.pick.id === this.selected
    }
  }

  private animate() {
    const now = performance.now()
    const pulse = (now % 1600) / 1600
    this.selection.scale = 0.36 + pulse * 0.22
    this.selection.color = C.Color.WHITE.withAlpha(1 - pulse * 0.8)
    // Hail arcs: draw in, hold, fade out.
    for (let i = this.arcs.length - 1; i >= 0; i--)
      if (now - this.arcs[i]!.born > 4200) {
        this.arcSource.entities.remove(this.arcs[i]!.entity)
        this.arcs.splice(i, 1)
      }
  }

  /** Animated arc from one end of a hail to the other: blue going out (outbound), orange coming in (inbound). */
  addHail(event: HailEvent) {
    if (!this.visible || (this.coast && event.coast !== this.coast)) return
    if (this.arcs.length > 14) {
      this.arcSource.entities.remove(this.arcs[0]!.entity)
      this.arcs.shift()
    }
    const born = performance.now()
    const [a, b] = [event.from, event.to]
    const distance = C.Cartesian3.distance(
      C.Cartesian3.fromDegrees(a[0], a[1]),
      C.Cartesian3.fromDegrees(b[0], b[1]),
    )
    const lift = Math.min(450000, Math.max(30000, distance * 0.22))
    const samples = 40
    const full = Array.from({ length: samples + 1 }, (_, i) => {
      const f = i / samples
      return C.Cartesian3.fromDegrees(
        a[0] + (b[0] - a[0]) * f,
        a[1] + (b[1] - a[1]) * f,
        Math.sin(Math.PI * f) * lift,
      )
    })
    const base = C.Color.fromCssColorString(event.kind === 'out' ? HAIL_OUT : HAIL_IN)
    const colour = new C.Color()
    const entity = this.arcSource.entities.add({
      polyline: {
        positions: new C.CallbackProperty(() => {
          const t = Math.min(1, (performance.now() - born) / 1300)
          const e = 1 - (1 - t) ** 3
          const head = Math.max(2, Math.round(e * samples) + 1)
          const tailT = Math.max(0, (performance.now() - born - 1700) / 2300)
          const tail = Math.min(head - 2, Math.round(tailT * samples))
          return full.slice(tail, head)
        }, false),
        width: 6,
        arcType: C.ArcType.NONE,
        material: new C.PolylineGlowMaterialProperty({
          glowPower: 0.16,
          taperPower: 0.5,
          color: new C.CallbackProperty(() => {
            const age = performance.now() - born
            const alpha = age < 2600 ? 0.95 : Math.max(0, 0.95 * (1 - (age - 2600) / 1600))
            return C.Color.clone(base, colour).withAlpha(alpha, colour)
          }, false),
        }),
      },
    })
    this.arcs.push({ entity, born })
  }

  /** Light beams over major harbours, height = vessels alongside now. */
  setHarbours(harbours: Harbour[], vessels: LiveVessel[]) {
    this.harbourCounts.clear()
    for (const v of vessels)
      if (v.status === 'in-port')
        this.harbourCounts.set(v.homePort, (this.harbourCounts.get(v.homePort) ?? 0) + 1)
    for (const h of harbours) {
      if (!h.major) continue
      const existing = this.harbourSource.entities.getById(`h-${h.id}`)
      if (existing) {
        const height = this.beamHeight(h)
        if (this.beamHeights.get(h.id) !== height) {
          this.beamHeights.set(h.id, height)
          ;(existing.polyline!.positions as C.ConstantProperty).setValue([
            C.Cartesian3.fromDegrees(h.lon, h.lat),
            C.Cartesian3.fromDegrees(h.lon, h.lat, height),
          ])
        }
        continue
      }
      const base = C.Cartesian3.fromDegrees(h.lon, h.lat)
      this.harbourSource.entities.add({
        id: `h-${h.id}`,
        position: new C.ConstantPositionProperty(base),
        polyline: {
          // Updated once per tick below (a per-frame callback rebuilds the line every frame).
          positions: new C.ConstantProperty([
            base,
            C.Cartesian3.fromDegrees(h.lon, h.lat, this.beamHeight(h)),
          ]),
          width: 10,
          arcType: C.ArcType.NONE,
          // National picture only: up close the beams would stand like poles over the map.
          distanceDisplayCondition: new C.DistanceDisplayCondition(4.5e6, Number.POSITIVE_INFINITY),
          material: new C.PolylineGlowMaterialProperty({
            glowPower: 0.22,
            taperPower: 1,
            color: C.Color.fromCssColorString('#ffd27f').withAlpha(0.85),
          }),
        },
        point: {
          pixelSize: 5,
          distanceDisplayCondition: new C.DistanceDisplayCondition(4.5e6, Number.POSITIVE_INFINITY),
          color: C.Color.fromCssColorString('#fff1cf'),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: h.name,
          font: '500 11px "Segoe UI", sans-serif',
          fillColor: C.Color.fromCssColorString('#ffe9c4'),
          outlineColor: C.Color.fromCssColorString('#06202a'),
          outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -12),
          verticalOrigin: C.VerticalOrigin.BOTTOM,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, 2.6e6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }
  }

  private beamHeight(h: Harbour) {
    const n = this.harbourCounts.get(h.id) ?? 0
    return 40000 + n * 7000
  }

  dispose() {
    this.viewer.scene.primitives.remove(this.billboards)
    this.viewer.scene.primitives.remove(this.labels)
    this.viewer.dataSources.remove(this.arcSource, true)
    this.viewer.dataSources.remove(this.harbourSource, true)
  }
}
