import * as C from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { scenes, type Snapshot, type ViewId } from '../domain/world'
import type { RenderContext, SceneAdapter } from './types'
/** Altitude of the cut between globe and vessel scene, metres. */
const DIVE_HEIGHT = 1200
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
  /** Radial zoom blur used by the dive transition; disabled (free) at rest. */
  blur: C.PostProcessStage
  blurStrength = 0
  /** True between activate and suspend; only an active globe records its camera. */
  active = false
  /** Incremented to cancel an in-flight dive or rise. */
  motion = 0
  /** Camera to restore for a view after a dive, instead of the dived-in position. */
  restoreCamera?: {
    destination: C.Cartesian3
    orientation: { heading: number; pitch: number; roll: number }
  }
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
      // Render at device pixels. The default (CSS pixels) is upscaled by the browser on
      // scaled displays (e.g. 125% on Windows laptops), which stair-steps every line.
      useBrowserRecommendedResolution: false,
      maximumRenderTimeChange: Infinity,
    })
    this.viewer.scene.skyBox!.show = false
    this.viewer.scene.backgroundColor = C.Color.fromCssColorString('#07141e')
    this.viewer.scene.globe.baseColor = C.Color.fromCssColorString('#163648')
    this.viewer.scene.globe.showGroundAtmosphere = true
    this.viewer.scene.screenSpaceCameraController.minimumZoomDistance = 25000
    this.viewer.scene.screenSpaceCameraController.maximumZoomDistance = 14000000
    this.viewer.scene.globe.depthTestAgainstTerrain = false
    // Multisample anti-aliasing (WebGL2): smooth boundary lines, coastlines and markers.
    this.viewer.scene.msaaSamples = 4
    this.blur = new C.PostProcessStage({
      name: 'zoom_blur',
      fragmentShader: /* glsl */ `
        uniform sampler2D colorTexture;
        uniform float strength;
        in vec2 v_textureCoordinates;
        void main() {
          vec2 uv = v_textureCoordinates;
          vec2 toCentre = uv - vec2(0.5);
          vec4 sum = vec4(0.0);
          for (int i = 0; i < 20; i++) {
            float t = float(i) / 19.0;
            sum += texture(colorTexture, uv - toCentre * t * strength * 0.4);
          }
          // Fade toward deep water at the peak so the cut matches the vessel scene's sea.
          vec3 colour = sum.rgb / 20.0 * (1.0 + strength * 0.12);
          colour = mix(colour, vec3(0.03, 0.08, 0.1), smoothstep(0.55, 1.0, strength) * 0.85);
          out_FragColor = vec4(colour, 1.0);
        }`,
      uniforms: { strength: () => this.blurStrength },
    })
    this.viewer.scene.postProcessStages.add(this.blur)
    // Compile the dive blur on the first rendered frame (at zero strength) rather than at
    // the start of the first dive, where the shader build would stall the animation.
    const removeWarmUp = this.viewer.scene.postRender.addEventListener(() => {
      removeWarmUp()
      this.blur.enabled = false
    })
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
  /** Camera a view returns to: the one the viewer left it with, else its default. */
  viewCamera(view: ViewId) {
    const def = scenes[view]
    return (
      this.cameras.get(view) || {
        destination: C.Cartesian3.fromDegrees(
          def.anchor.longitude,
          def.anchor.latitude,
          def.height,
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      }
    )
  }
  /** `keepCamera`: a rise transition is already driving the camera. */
  async activate(view: ViewId, reduced: boolean, keepCamera = false) {
    this.reducedMotion = reduced
    const epoch = ++this.generation
    this.active = true
    this.viewer.useDefaultRenderLoop = true
    this.view = view
    for (const [key, layer] of this.layers) layer.show = key === view
    if (!keepCamera) {
      this.viewer.camera.cancelFlight()
      this.viewer.camera.flyTo({ ...this.viewCamera(view), duration: reduced ? 0 : 1.5 })
    }
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
            // Boundary as a real polyline: polygon outlines are 1 px GL lines (width is
            // ignored on Windows/ANGLE) and stair-step badly. MSAA is not honoured on every
            // GPU/browser (it was not on Chrome/Intel), so the line anti-aliases itself:
            // Cesium's outline material smooths its edges in the shader, and a transparent
            // 1 px "outline" turns that into a soft edge. Rhumb lines follow NAFO's lat/long.
            const stroke = C.Color.fromCssColorString('#9ac5c1')
            entity.polygon.outline = new C.ConstantProperty(false)
            entity.polyline = new C.PolylineGraphics({
              positions: [...hierarchy.positions, hierarchy.positions[0]],
              width: 3,
              arcType: C.ArcType.RHUMB,
              material: new C.PolylineOutlineMaterialProperty({
                color: stroke.withAlpha(0.85),
                outlineColor: stroke.withAlpha(0),
                outlineWidth: 1,
              }),
            })
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
  /**
   * Zoom transition: dive straight down onto a position, accelerating, with a radial blur
   * that peaks at the end, where the caller cuts to the local scene. Altitude follows a
   * logarithmic curve so thousands of kilometres and the last few hundred metres read as
   * one continuous rush.
   */
  dive(target: { longitude: number; latitude: number }, duration = 1.0) {
    const camera = this.viewer.camera
    camera.cancelFlight()
    this.restoreCamera = {
      destination: camera.position.clone(),
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
    }
    const start = camera.positionCartographic.clone()
    const startPitch = camera.pitch
    const endHeight = DIVE_HEIGHT
    const token = ++this.motion
    this.blur.enabled = true
    return new Promise<void>((resolve) => {
      const begin = performance.now()
      const step = () => {
        if (this.disposed || token !== this.motion) return resolve()
        const t = Math.min(1, (performance.now() - begin) / (duration * 1000))
        const e = t * t * (2.2 - 1.2 * t) // accelerating, still moving at the cut
        const lon = C.Math.lerp(
          C.Math.toDegrees(start.longitude),
          target.longitude,
          Math.min(1, e * 1.6),
        )
        const lat = C.Math.lerp(
          C.Math.toDegrees(start.latitude),
          target.latitude,
          Math.min(1, e * 1.6),
        )
        const height = start.height * Math.pow(endHeight / start.height, e)
        camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat, height),
          orientation: {
            heading: 0,
            pitch: C.Math.lerp(startPitch, -C.Math.PI_OVER_TWO, e),
            roll: 0,
          },
        })
        this.blurStrength = Math.pow(t, 2.5)
        this.viewer.scene.requestRender()
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  }
  /**
   * Reverse zoom: start low over a position at peak blur (where the vessel scene cut away)
   * and pull out to the view's camera, decelerating, as the blur clears. Call just before
   * `activate(view, reduced, true)`.
   */
  rise(from: { longitude: number; latitude: number }, view: ViewId, duration = 1.3) {
    const camera = this.viewer.camera
    camera.cancelFlight()
    const goal = this.viewCamera(view)
    // If interrupted, the view keeps its intended camera rather than a mid-rise one.
    this.restoreCamera = goal
    const end = C.Cartographic.fromCartesian(goal.destination)
    const token = ++this.motion
    this.blur.enabled = true
    this.blurStrength = 1
    return new Promise<void>((resolve) => {
      const begin = performance.now()
      const step = () => {
        if (this.disposed || token !== this.motion) return resolve()
        const t = Math.min(1, (performance.now() - begin) / (duration * 1000))
        const e = 1 - Math.pow(1 - t, 3) // fast out of the water, settling at altitude
        const across = Math.max(0, (e - 0.35) / 0.65) // climb first, then slide over
        camera.setView({
          destination: C.Cartesian3.fromDegrees(
            C.Math.lerp(from.longitude, C.Math.toDegrees(end.longitude), across),
            C.Math.lerp(from.latitude, C.Math.toDegrees(end.latitude), across),
            DIVE_HEIGHT * Math.pow(end.height / DIVE_HEIGHT, e),
          ),
          orientation: {
            heading: C.Math.lerp(0, goal.orientation.heading, e),
            pitch: C.Math.lerp(-C.Math.PI_OVER_TWO, goal.orientation.pitch, e),
            roll: 0,
          },
        })
        this.blurStrength = 1 - C.Math.clamp(t / 0.55, 0, 1) ** 0.8
        this.viewer.scene.requestRender()
        if (t < 1) return requestAnimationFrame(step)
        this.blur.enabled = false
        this.blurStrength = 0
        this.restoreCamera = undefined
        resolve()
      }
      step()
    })
  }
  reset() {
    this.cameras.delete(this.view)
    void this.activate(this.view, true)
  }
  suspend() {
    this.generation++
    this.motion++
    this.viewer.camera.cancelFlight()
    // Only an active globe records its camera: a second suspend must not overwrite it.
    if (!this.active) return
    this.active = false
    const c = this.viewer.camera
    this.cameras.set(this.view, {
      destination: c.position.clone(),
      orientation: { heading: c.heading, pitch: c.pitch, roll: c.roll },
    })
    if (this.restoreCamera) this.cameras.set(this.view, this.restoreCamera)
    this.restoreCamera = undefined
    this.blur.enabled = false
    this.blurStrength = 0
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
