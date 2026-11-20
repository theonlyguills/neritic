import * as C from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { scenes, type Snapshot, type ViewId } from '../domain/world'
import type { RenderContext, SceneAdapter } from './types'
export class GeographicRenderer implements SceneAdapter {
  viewer: C.Viewer
  view: ViewId = 'canada'
  layers = new Map<string, C.GeoJsonDataSource>()
  cameras = new Map<
    string,
    { destination: C.Cartesian3; orientation: { heading: number; pitch: number; roll: number } }
  >()
  disposed = false
  generation = 0
  reducedMotion = false
  pendingLayers = new Map<string, Promise<C.GeoJsonDataSource>>()
  constructor(
    element: HTMLElement,
    private context: RenderContext,
  ) {
    this.viewer = new C.Viewer(element, {
      baseLayer: false,
      terrainProvider: new C.EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
    })
    this.viewer.scene.skyBox!.show = false
    this.viewer.scene.backgroundColor = C.Color.fromCssColorString('#07141e')
    this.viewer.scene.globe.baseColor = C.Color.fromCssColorString('#163648')
    this.viewer.scene.globe.showGroundAtmosphere = true
    this.viewer.scene.screenSpaceCameraController.minimumZoomDistance = 25000
    this.viewer.scene.screenSpaceCameraController.maximumZoomDistance = 14000000
    this.viewer.scene.globe.depthTestAgainstTerrain = false
    const handler = this.viewer.screenSpaceEventHandler
    handler.setInputAction((event: { position: C.Cartesian2 }) => {
      const p = this.viewer.scene.pick(event.position)
      if (p?.id instanceof C.Entity) {
        const id = String(p.id.id)
        if (id.startsWith('v-')) context.selectVessel(id.slice(2))
        else if (id.startsWith('summary-')) context.navigate(id.slice(8) as ViewId)
        else if (p.id.properties) {
          context.selectRegion(
            String(p.id.properties.getValue(C.JulianDate.now()).label || p.id.name || id),
          )
          void this.viewer.flyTo(p.id, {
            duration: this.reducedMotion ? 0 : 1.2,
            offset: new C.HeadingPitchRange(0, -Math.PI / 2, 0),
          })
        }
      }
    }, C.ScreenSpaceEventType.LEFT_CLICK)
  }
  async initialize() {
    const fallback = await C.SingleTileImageryProvider.fromUrl('/assets/earth.jpg')
    if (this.disposed) return
    this.viewer.imageryLayers.addImageryProvider(fallback)
    const imagery = new C.UrlTemplateImageryProvider({
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
      tilingScheme: new C.WebMercatorTilingScheme(),
      maximumLevel: 8,
      credit: 'NASA GIBS · Blue Marble',
    })
    const layer = this.viewer.imageryLayers.addImageryProvider(imagery)
    let failed = false
    imagery.errorEvent.addEventListener(() => {
      if (!failed && !this.disposed) {
        failed = true
        layer.show = false
        this.context.status('Online imagery unavailable. Showing bundled Natural Earth imagery.')
        this.viewer.scene.requestRender()
      }
    })
  }
  async activate(view: ViewId, reduced: boolean) {
    this.reducedMotion = reduced
    const epoch = ++this.generation
    this.viewer.useDefaultRenderLoop = true
    this.view = view
    for (const [key, layer] of this.layers) layer.show = key === view
    const def = scenes[view]
    const saved = this.cameras.get(view)
    this.viewer.camera.cancelFlight()
    const target = saved || {
      destination: C.Cartesian3.fromDegrees(def.anchor.longitude, def.anchor.latitude, def.height),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    }
    this.viewer.camera.flyTo({ ...target, duration: reduced ? 0 : 1.5 })
    if (view !== 'canada' && !this.layers.has(view)) {
      let pending = this.pendingLayers.get(view)
      if (!pending) {
        pending = C.GeoJsonDataSource.load(`/data/${view}.geojson`, {
          stroke: C.Color.fromCssColorString('#9ac5c1').withAlpha(0.8),
          fill: C.Color.fromCssColorString('#7bbfb5').withAlpha(0.09),
          strokeWidth: 1.5,
        })
        this.pendingLayers.set(view, pending)
      }
      let ds: C.GeoJsonDataSource
      try {
        ds = await pending
      } catch (error) {
        this.pendingLayers.delete(view)
        throw error
      }
      if (this.disposed) return
      const labelled = new Map<string, { entity: C.Entity; radius: number }>()
      for (const entity of ds.entities.values) {
        const properties = entity.properties?.getValue(C.JulianDate.now())
        if (entity.polygon) {
          const hierarchy = entity.polygon.hierarchy?.getValue(C.JulianDate.now())
          if (hierarchy?.positions?.length) {
            const bounds = C.BoundingSphere.fromPoints(hierarchy.positions)
            const center = bounds.center
            const key = String(properties?.label || entity.id)
            const existing = labelled.get(key)
            if (existing && existing.radius >= bounds.radius) continue
            if (existing) existing.entity.label = undefined
            labelled.set(key, { entity, radius: bounds.radius })
            entity.position = new C.ConstantPositionProperty(
              C.Ellipsoid.WGS84.scaleToGeodeticSurface(center),
            )
            entity.label = new C.LabelGraphics({
              text: properties?.label || '',
              font: '14px sans-serif',
              fillColor: C.Color.WHITE,
              outlineColor: C.Color.fromCssColorString('#183542'),
              outlineWidth: 3,
              style: C.LabelStyle.FILL_AND_OUTLINE,
              disableDepthTestDistance: Infinity,
              distanceDisplayCondition: new C.DistanceDisplayCondition(
                0,
                Math.min(3500000, Math.max(180000, bounds.radius * 18)),
              ),
            })
          }
        }
      }
      if (epoch === this.generation) ds.show = this.view === view
      if (!this.layers.has(view)) {
        ds.show = this.view === view
        this.layers.set(view, ds)
        await this.viewer.dataSources.add(ds)
      }
    }
    this.viewer.scene.requestRender()
  }
  reset() {
    this.cameras.delete(this.view)
    void this.activate(this.view, true)
  }
  suspend() {
    this.generation++
    this.viewer.camera.cancelFlight()
    const c = this.viewer.camera
    this.cameras.set(this.view, {
      destination: c.position.clone(),
      orientation: { heading: c.heading, pitch: c.pitch, roll: c.roll },
    })
    this.viewer.useDefaultRenderLoop = false
  }
  update(snapshot: Snapshot) {
    const active = new Set<string>()
    if (this.view === 'canada') {
      for (const coast of ['atlantic', 'pacific'] as const) {
        const d = scenes[coast],
          id = `summary-${coast}`
        active.add(id)
        if (!this.viewer.entities.getById(id))
          this.viewer.entities.add({
            id,
            position: C.Cartesian3.fromDegrees(d.anchor.longitude, d.anchor.latitude),
            point: {
              pixelSize: 10,
              color: C.Color.fromCssColorString('#aee5d5'),
              outlineColor: C.Color.BLACK,
              outlineWidth: 2,
            },
            label: {
              text: `${coast.toUpperCase()}  /  ${snapshot.vessels.filter((v) => v.coast === coast).length} vessels`,
              font: '13px sans-serif',
              pixelOffset: new C.Cartesian2(0, 25),
              fillColor: C.Color.WHITE,
              showBackground: true,
              backgroundColor: C.Color.fromCssColorString('#102b36').withAlpha(0.8),
              disableDepthTestDistance: Infinity,
            },
          })
      }
    } else
      for (const vessel of snapshot.vessels.filter((v) => v.coast === this.view)) {
        const id = `v-${vessel.id}`
        active.add(id)
        let entity = this.viewer.entities.getById(id)
        if (!entity)
          entity = this.viewer.entities.add({
            id,
            point: {
              pixelSize: vessel.localScene ? 11 : 7,
              color: C.Color.fromCssColorString(vessel.localScene ? '#eac58a' : '#abe0d1'),
              outlineColor: C.Color.fromCssColorString('#102b36'),
              outlineWidth: 2,
              disableDepthTestDistance: Infinity,
            },
            label: {
              text: vessel.name,
              font: '12px sans-serif',
              pixelOffset: new C.Cartesian2(15, 0),
              horizontalOrigin: C.HorizontalOrigin.LEFT,
              fillColor: C.Color.WHITE,
              showBackground: true,
              backgroundColor: C.Color.fromCssColorString('#102b36').withAlpha(0.8),
              disableDepthTestDistance: Infinity,
            },
          })
        entity.position = new C.ConstantPositionProperty(
          C.Cartesian3.fromDegrees(vessel.position.longitude, vessel.position.latitude),
        )
      }
    for (const entity of [...this.viewer.entities.values])
      if (!active.has(entity.id)) this.viewer.entities.remove(entity)
    this.viewer.scene.requestRender()
  }
  quality(value: 'high' | 'low') {
    this.viewer.resolutionScale = value === 'high' ? 1 : 0.7
    this.viewer.scene.requestRender()
  }
  resize() {
    this.viewer.resize()
  }
  dispose() {
    this.disposed = true
    this.generation++
    this.viewer.destroy()
  }
}
