import * as C from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { scenes, type Coast, type Snapshot, type ViewId } from '../domain/world'
import type { RenderContext, SceneAdapter } from './types'
import { FleetLayer, heightForZoom, type FleetPick } from './fleet-layer'
import { BoundaryLayer } from './boundaries'
/** Altitude of the cut between globe and vessel scene, metres. */
const DIVE_HEIGHT = 1200
/** Zoom gestures: below this share of the overview height, open the coast under the camera. */
const ZOOM_IN_SHARE = 0.42
/** Regional views: above this multiple of the view's own height, return to the overview. */
const ZOOM_OUT_FACTOR = 2.1
interface CameraPose {
  destination: C.Cartesian3
  orientation: { direction: C.Cartesian3; up: C.Cartesian3 }
}
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
export class GeographicRenderer implements SceneAdapter {
  viewer: C.Viewer
  view: ViewId = 'canada'
  layers = new Map<string, BoundaryLayer>()
  cameras = new Map<string, CameraPose>()
  disposed = false
  generation = 0
  reducedMotion = false
  pendingLayers = new Map<string, Promise<BoundaryLayer>>()
  /** Radial zoom blur used by transitions; disabled (free) at rest. */
  blur: C.PostProcessStage
  blurStrength = 0
  blurFade = 1
  /** True between activate and suspend; only an active globe records its camera. */
  active = false
  /** Incremented to cancel an in-flight dive, rise or swoop. */
  motion = 0
  /** A scripted camera move is running: zoom gestures are not interpreted meanwhile. */
  moving = false
  /** Camera to restore for a view after a dive, instead of the dived-in position. */
  restoreCamera?: CameraPose
  fleet: FleetLayer
  hotspots = new C.CustomDataSource('coasts')
  lastHail = ''
  private introduced = false
  polarCap?: C.Entity
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
      // Live layer: arcs, pulses and moving vessels animate continuously.
      requestRenderMode: false,
      // Render at device pixels. The default (CSS pixels) is upscaled by the browser on
      // scaled displays (e.g. 125% on Windows laptops), which stair-steps every line.
      useBrowserRecommendedResolution: false,
    })
    const scene = this.viewer.scene
    scene.backgroundColor = C.Color.fromCssColorString('#030a10')
    scene.globe.baseColor = C.Color.fromCssColorString('#163648')
    scene.globe.showGroundAtmosphere = true
    scene.skyAtmosphere!.show = true
    scene.skyAtmosphere!.atmosphereLightIntensity = 14
    scene.skyBox!.show = true
    scene.sun!.show = false
    scene.moon!.show = false
    scene.fog.enabled = true
    scene.screenSpaceCameraController.minimumZoomDistance = 25000
    scene.screenSpaceCameraController.maximumZoomDistance = 16000000
    scene.globe.depthTestAgainstTerrain = false
    // Multisample anti-aliasing (WebGL2): smooth boundary lines, coastlines and markers.
    scene.msaaSamples = 4
    // Slight bloom-free "grade": a touch more contrast and saturation on the imagery.
    scene.globe.atmosphereBrightnessShift = -0.05
    this.blur = new C.PostProcessStage({
      name: 'zoom_blur',
      fragmentShader: /* glsl */ `
        uniform sampler2D colorTexture;
        uniform float strength;
        uniform float fade;
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
          colour = mix(colour, vec3(0.03, 0.08, 0.1), smoothstep(0.55, 1.0, strength) * 0.85 * fade);
          out_FragColor = vec4(colour, 1.0);
        }`,
      uniforms: { strength: () => this.blurStrength, fade: () => this.blurFade },
    })
    scene.postProcessStages.add(this.blur)
    // Compile the blur on the first rendered frame (at zero strength) rather than at the
    // start of the first transition, where the shader build would stall the animation.
    const removeWarmUp = scene.postRender.addEventListener(() => {
      removeWarmUp()
      this.blur.enabled = false
    })
    this.fleet = new FleetLayer(this.viewer)
    void this.viewer.dataSources.add(this.hotspots)
    scene.postRender.addEventListener(() => this.watchZoom())
    scene.preUpdate.addEventListener(() => (this.frameTime = performance.now()))
    const handler = this.viewer.screenSpaceEventHandler
    handler.setInputAction((event: { position: C.Cartesian2 }) => {
      if (this.moving) return
      const p = scene.pick(event.position)
      const pick = p?.id as FleetPick | C.Entity | string | undefined
      if (!pick) return
      if (typeof pick === 'string') {
        const area = this.layers.get(this.view)?.areaOf(pick)
        if (area) context.selectRegion(area)
        return
      }
      if (!(pick instanceof C.Entity)) {
        if (pick.kind === 'vessel') context.selectVessel(pick.id)
        else if (pick.kind === 'cluster') this.zoomToCluster(pick)
        return
      }
      const id = String(pick.id)
      if (id.startsWith('coast-')) context.navigate(id.slice(6) as ViewId)
    }, C.ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction((event: { position: C.Cartesian2 }) => {
      if (this.moving) return
      const p = scene.pick(event.position)
      const pick = p?.id as FleetPick | string | undefined
      if (pick && typeof pick === 'object' && !(pick instanceof C.Entity) && pick.kind === 'vessel')
        context.exploreVessel(pick.id)
    }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    element.addEventListener('wheel', () => (this.lastWheel = performance.now()), {
      capture: true,
      passive: true,
    })
    // Pointer feedback: a hand over anything clickable.
    handler.setInputAction((event: { endPosition: C.Cartesian2 }) => {
      const p = scene.pick(event.endPosition)
      element.style.cursor = p?.id ? 'pointer' : ''
    }, C.ScreenSpaceEventType.MOUSE_MOVE)
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
    layer.contrast = 1.12
    layer.saturation = 1.1
    layer.brightness = 0.95
    let failed = false
    imagery.errorEvent.addEventListener(() => {
      if (!failed && !this.disposed) {
        failed = true
        layer.show = false
        if (this.polarCap) this.polarCap.show = false
        this.context.status('Online imagery unavailable. Showing bundled Natural Earth imagery.')
      }
    })
    // Web Mercator imagery stops at ±85°: cap the pole in the Arctic Ocean's colour rather
    // than showing the paler fallback image as a hard-edged disc.
    this.polarCap = this.viewer.entities.add({
      rectangle: {
        coordinates: C.Rectangle.fromDegrees(-180, 84.9, 180, 90),
        material: C.Color.fromCssColorString('#0f2a52'),
        height: 0,
      },
    })
    this.addHotspots()
    await this.warmShaders()
  }
  /**
   * Cesium builds globe shader variants per camera range (ground atmosphere per vertex or
   * per fragment, log-depth and depth-only passes near the surface). Compiled on demand they
   * stalled the first dive by seconds on a laptop GPU, so draw a few hidden frames at the
   * dive and regional altitudes while the page is still loading.
   */
  private async warmShaders() {
    const canvas = this.viewer.scene.canvas
    canvas.style.visibility = 'hidden'
    const frames = (n: number) =>
      new Promise<void>((resolve) => {
        let left = n
        const remove = this.viewer.scene.postRender.addEventListener(() => {
          if (--left > 0) return
          remove()
          resolve()
        })
        setTimeout(() => {
          remove()
          resolve()
        }, 2500)
      })
    try {
      for (const height of [DIVE_HEIGHT, 30000, 2.4e6]) {
        this.viewer.camera.setView({
          destination: C.Cartesian3.fromDegrees(-50, 46, height),
          orientation: { heading: 0, pitch: height < 50000 ? -C.Math.PI_OVER_TWO : -1.2, roll: 0 },
        })
        await frames(6)
        if (this.disposed) return
      }
    } finally {
      canvas.style.visibility = ''
    }
  }
  /** Overview call-outs over each coast: a pulsing ring and a live count; click to zoom in. */
  private addHotspots() {
    const ping = document.createElement('canvas')
    ping.width = ping.height = 256
    const g = ping.getContext('2d')!
    g.strokeStyle = '#7fe3c9'
    g.lineWidth = 6
    g.shadowColor = '#7fe3c9'
    g.shadowBlur = 14
    g.beginPath()
    g.arc(128, 128, 110, 0, Math.PI * 2)
    g.stroke()
    const spots: Record<Coast, [number, number]> = {
      atlantic: [-57, 52.5],
      pacific: [-131, 52],
    }
    for (const [coast, [lon, lat]] of Object.entries(spots) as [Coast, [number, number]][]) {
      const born = coast === 'atlantic' ? 0 : 900
      // Radar-style pings: billboards scaled per frame (cheap), not ellipses whose
      // geometry Cesium would rebuild every frame.
      for (const delay of [0, 1300])
        this.hotspots.entities.add({
          id: `coast-${coast}-ring-${delay}`,
          position: C.Cartesian3.fromDegrees(lon, lat),
          billboard: {
            image: ping,
            scale: new C.CallbackProperty(() => this.pulse(born + delay).scale, false),
            color: new C.CallbackProperty(
              () => C.Color.WHITE.withAlpha(this.pulse(born + delay).alpha),
              false,
            ),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        })
      this.hotspots.entities.add({
        id: `coast-${coast}`,
        position: C.Cartesian3.fromDegrees(lon, lat, 60000),
        label: {
          text: coast.toUpperCase(),
          font: '600 15px "Segoe UI", sans-serif',
          fillColor: C.Color.WHITE,
          outlineColor: C.Color.fromCssColorString('#04161e'),
          outlineWidth: 4,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -64),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: C.Color.fromCssColorString('#0a2a34').withAlpha(0.78),
          backgroundPadding: new C.Cartesian2(12, 7),
        },
      })
    }
  }
  /** One timestamp per frame: both ellipse axes must read the same radius. */
  private frameTime = 0
  private pulse(offset: number) {
    const t = ((this.frameTime + offset) % 2600) / 2600
    return { scale: 0.15 + t * 0.85, alpha: 0.75 * (1 - t) ** 1.6 }
  }
  /** Camera pose for a view: looking at its anchor from `height` metres, tilted by `pitch`. */
  defaultCamera(view: ViewId): CameraPose {
    const def = scenes[view]
    const camera = this.viewer.camera
    const saved = {
      position: camera.position.clone(),
      direction: camera.direction.clone(),
      up: camera.up.clone(),
      transform: camera.transform.clone(),
    }
    const target = C.Cartesian3.fromDegrees(def.anchor.longitude, def.anchor.latitude)
    camera.lookAt(
      target,
      new C.HeadingPitchRange(0, C.Math.toRadians(def.pitch ?? -90), def.height),
    )
    const pose: CameraPose = {
      destination: camera.positionWC.clone(),
      orientation: { direction: camera.directionWC.clone(), up: camera.upWC.clone() },
    }
    camera.lookAtTransform(saved.transform)
    camera.position = saved.position
    camera.direction = saved.direction
    camera.up = saved.up
    return pose
  }
  /** Camera a view returns to: the one the viewer left it with, else its default. */
  viewCamera(view: ViewId) {
    return this.cameras.get(view) || this.defaultCamera(view)
  }
  private currentPose(): CameraPose {
    const c = this.viewer.camera
    return {
      destination: c.positionWC.clone(),
      orientation: { direction: c.directionWC.clone(), up: c.upWC.clone() },
    }
  }
  /** `keepCamera`: a transition is already driving the camera. */
  async activate(view: ViewId, reduced: boolean, keepCamera = false) {
    this.reducedMotion = reduced
    const epoch = ++this.generation
    this.active = true
    this.viewer.useDefaultRenderLoop = true
    this.view = view
    this.hotspots.show = view === 'canada'
    this.fleet.setCoast(view === 'canada' || view === 'vessel' ? undefined : view)
    this.fleet.setVisible(true)
    if (!keepCamera) {
      // The flight passes through zoom thresholds: gestures are not read until it lands.
      this.moving = true
      const done = () => {
        if (epoch === this.generation) this.moving = false
      }
      this.viewer.camera.cancelFlight()
      // First arrival: start out in space and push in to the view, a slow establishing shot.
      const intro = !this.introduced && !reduced
      this.introduced = true
      if (intro) {
        const anchor = scenes[view].anchor
        this.viewer.camera.setView({
          destination: C.Cartesian3.fromDegrees(anchor.longitude - 25, anchor.latitude - 20, 3.2e7),
        })
      }
      this.viewer.camera.flyTo({
        ...this.viewCamera(view),
        duration: reduced ? 0 : intro ? 3.6 : 1.5,
        easingFunction: intro ? C.EasingFunction.QUINTIC_IN_OUT : undefined,
        complete: done,
        cancel: done,
      })
    }
    await this.attachLayers(view)
    void epoch
  }
  /**
   * Boundary layer for a coast: fetched and built once. Its geometry is created in web
   * workers even while hidden, so preloading it keeps the overview → coast zoom smooth.
   */
  loadLayer(view: ViewId) {
    let pending = this.pendingLayers.get(view)
    if (!pending) {
      pending = fetch(`/data/${view}.geojson`)
        .then((r) => {
          if (!r.ok) throw new Error(`Boundaries: HTTP ${r.status}`)
          return r.json()
        })
        .then((data) => {
          const layer = new BoundaryLayer(this.viewer.scene, data)
          if (this.disposed) layer.destroy()
          this.layers.set(view, layer)
          layer.setShown(this.view === view && this.active)
          return layer
        })
      pending.catch(() => this.pendingLayers.delete(view))
      this.pendingLayers.set(view, pending)
    }
    return pending
  }
  private async attachLayers(view: ViewId) {
    for (const [key, layer] of this.layers) layer.setShown(key === view)
    if (view === 'canada' || view === 'vessel') return
    const layer = await this.loadLayer(view)
    if (this.disposed) return
    layer.setShown(this.view === view && this.active)
  }
  preloadLayers() {
    for (const view of ['atlantic', 'pacific'] as const)
      void this.loadLayer(view).catch(() => undefined)
  }
  /** Shade each management area by the vessels working it now; label it with the count. */
  private shadeAreas(snapshot: Snapshot) {
    if (this.view !== 'atlantic' && this.view !== 'pacific') return
    const counts = new Map<string, number>()
    for (const v of snapshot.vessels)
      if (v.coast === this.view && v.status === 'fishing')
        counts.set(v.area, (counts.get(v.area) ?? 0) + 1)
    this.layers.get(this.view)?.shade(counts)
  }
  /** Zoom gestures drive navigation: in over a coast from the overview, out from a coast. */
  private watchZoom() {
    if (!this.active || this.moving || this.view === 'vessel') return
    const height = this.viewer.camera.positionCartographic.height
    if (this.view === 'canada') {
      if (height > this.defaultHeight('canada') * ZOOM_IN_SHARE) return
      const ground = this.centreGround()
      if (!ground) return
      this.context.navigate(ground.longitude < -100 ? 'pacific' : 'atlantic')
      this.moving = true // until the swoop takes over
    } else if (height > this.defaultHeight(this.view) * ZOOM_OUT_FACTOR) {
      this.context.navigate('canada')
      this.moving = true
    }
  }
  private heights = new Map<ViewId, number>()
  private defaultHeight(view: ViewId) {
    let h = this.heights.get(view)
    if (h === undefined) {
      h = C.Cartographic.fromCartesian(this.defaultCamera(view).destination).height
      this.heights.set(view, h)
    }
    return h
  }
  private centreGround() {
    const canvas = this.viewer.scene.canvas
    const centre = new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
    const hit = this.viewer.camera.pickEllipsoid(centre)
    if (!hit) return undefined
    const c = C.Cartographic.fromCartesian(hit)
    return { longitude: C.Math.toDegrees(c.longitude), latitude: C.Math.toDegrees(c.latitude) }
  }
  private zoomToCluster(pick: Extract<FleetPick, { kind: 'cluster' }>) {
    // On the overview a bubble opens its coast (the same zoom as scrolling in).
    if (this.view === 'canada') {
      this.context.navigate(pick.lon < -100 ? 'pacific' : 'atlantic')
      return
    }
    const camera = this.viewer.camera
    const range = heightForZoom(Math.min(pick.zoom + 0.6, 10))
    camera.flyToBoundingSphere(
      new C.BoundingSphere(C.Cartesian3.fromDegrees(pick.lon, pick.lat), 1),
      {
        offset: new C.HeadingPitchRange(camera.heading, Math.max(camera.pitch, -1.2), range),
        duration: this.reducedMotion ? 0 : 1.1,
      },
    )
  }
  /** Bring a vessel to the centre (from the panel). */
  focusVessel(id: string) {
    const v = this.fleet.vessels.get(id)
    if (!v) return
    const camera = this.viewer.camera
    const height = Math.min(camera.positionCartographic.height, 420000)
    camera.flyToBoundingSphere(
      new C.BoundingSphere(C.Cartesian3.fromDegrees(v.longitude, v.latitude), 1),
      {
        offset: new C.HeadingPitchRange(camera.heading, Math.max(camera.pitch, -1.15), height),
        duration: this.reducedMotion ? 0 : 1.2,
      },
    )
  }
  /** Scripted camera move between two poses with a zoom blur that peaks mid-way. */
  private animatePose(
    from: CameraPose,
    to: CameraPose,
    duration: number,
    shape: { ease: (t: number) => number; blur: (t: number) => number; fade: number },
  ) {
    const camera = this.viewer.camera
    camera.cancelFlight()
    const a = C.Cartographic.fromCartesian(from.destination)
    const b = C.Cartographic.fromCartesian(to.destination)
    const token = ++this.motion
    this.moving = true
    this.blur.enabled = true
    this.blurFade = shape.fade
    const controller = this.viewer.scene.screenSpaceCameraController
    controller.enableInputs = false
    this.fleet.frozen = true
    const direction = new C.Cartesian3()
    const up = new C.Cartesian3()
    const right = new C.Cartesian3()
    return new Promise<void>((resolve) => {
      const begin = performance.now()
      const step = () => {
        if (this.disposed || token !== this.motion) {
          controller.enableInputs = true
          this.fleet.frozen = false
          return resolve()
        }
        const t = Math.min(1, (performance.now() - begin) / (duration * 1000))
        const e = shape.ease(t)
        const lon = a.longitude + (b.longitude - a.longitude) * e
        const lat = a.latitude + (b.latitude - a.latitude) * e
        const height = a.height * Math.pow(b.height / a.height, e)
        C.Cartesian3.lerp(from.orientation.direction, to.orientation.direction, e, direction)
        C.Cartesian3.normalize(direction, direction)
        C.Cartesian3.lerp(from.orientation.up, to.orientation.up, e, up)
        C.Cartesian3.cross(direction, up, right)
        C.Cartesian3.normalize(C.Cartesian3.cross(right, direction, up), up)
        camera.setView({
          destination: C.Cartesian3.fromRadians(lon, lat, height),
          orientation: { direction, up },
        })
        this.blurStrength = shape.blur(t)
        if (t < 1) return requestAnimationFrame(step)
        this.blur.enabled = false
        this.blurStrength = 0
        controller.enableInputs = true
        this.fleet.frozen = false
        this.fleet.select(this.fleet.selected) // re-cluster for where the camera landed
        this.moving = false
        this.settleInput()
        resolve()
      }
      step()
    })
  }
  /**
   * After a scripted move, ignore the tail of the scroll gesture that triggered it (wheel
   * ticks still arriving, and zoom inertia) so the view lands where the move put it.
   */
  private settleInput() {
    const controller = this.viewer.scene.screenSpaceCameraController
    controller.enableZoom = false
    controller.inertiaZoom = 0
    clearInterval(this.settleTimer)
    this.settleTimer = setInterval(() => {
      // Wait for the wheel to go quiet, so a long scroll cannot carry on past the move.
      if (performance.now() - this.lastWheel < 450) return
      clearInterval(this.settleTimer)
      controller.enableZoom = true
      controller.inertiaZoom = 0.8
    }, 100)
  }
  private settleTimer?: ReturnType<typeof setInterval>
  private lastWheel = 0
  /** Map ⇄ map zoom (overview ⇄ coast): a fast, blurred push in or pull out. */
  swoop(view: ViewId, duration = 1.25) {
    this.cameras.delete(view)
    const goal = this.defaultCamera(view)
    const zoomingIn = view !== 'canada'
    return this.animatePose(this.currentPose(), goal, duration, {
      ease,
      blur: (t) => (zoomingIn ? 0.85 : 0.6) * Math.sin(Math.PI * t) ** 1.5,
      fade: 0,
    })
  }
  /**
   * Zoom transition: dive straight down onto a position, accelerating, with a radial blur
   * that peaks at the end, where the caller cuts to the local scene. Altitude follows a
   * logarithmic curve so thousands of kilometres and the last few hundred metres read as
   * one continuous rush.
   */
  dive(target: { longitude: number; latitude: number }, duration = 1.0) {
    this.restoreCamera = this.currentPose()
    const surface = C.Cartesian3.fromDegrees(target.longitude, target.latitude, DIVE_HEIGHT)
    const down = C.Cartesian3.negate(
      C.Ellipsoid.WGS84.geodeticSurfaceNormal(surface, new C.Cartesian3()),
      new C.Cartesian3(),
    )
    // North-up at the bottom of the dive, like the vessel scene's overhead camera.
    const enu = C.Transforms.eastNorthUpToFixedFrame(surface)
    const north = C.Matrix4.multiplyByPointAsVector(enu, C.Cartesian3.UNIT_Y, new C.Cartesian3())
    return this.animatePose(
      this.currentPose(),
      { destination: surface, orientation: { direction: down, up: north } },
      duration,
      { ease: (t) => t * t * (2.2 - 1.2 * t), blur: (t) => Math.pow(t, 2.5), fade: 1 },
    ).then(() => {
      // Hold at peak blur for the cut.
      this.blur.enabled = true
      this.blurStrength = 1
    })
  }
  /**
   * Reverse zoom: start low over a position at peak blur (where the vessel scene cut away)
   * and pull out to the view's camera, decelerating, as the blur clears. Call just before
   * `activate(view, reduced, true)`.
   */
  rise(from: { longitude: number; latitude: number }, view: ViewId, duration = 1.3) {
    const goal = this.viewCamera(view)
    // If interrupted, the view keeps its intended camera rather than a mid-rise one.
    this.restoreCamera = goal
    const surface = C.Cartesian3.fromDegrees(from.longitude, from.latitude, DIVE_HEIGHT)
    const enu = C.Transforms.eastNorthUpToFixedFrame(surface)
    const start: CameraPose = {
      destination: surface,
      orientation: {
        direction: C.Matrix4.multiplyByPointAsVector(
          enu,
          new C.Cartesian3(0, 0, -1),
          new C.Cartesian3(),
        ),
        up: C.Matrix4.multiplyByPointAsVector(enu, C.Cartesian3.UNIT_Y, new C.Cartesian3()),
      },
    }
    return this.animatePose(start, goal, duration, {
      ease: (t) => 1 - Math.pow(1 - t, 3),
      blur: (t) => 1 - C.Math.clamp(t / 0.55, 0, 1) ** 0.8,
      fade: 1,
    }).then(() => {
      this.restoreCamera = undefined
    })
  }
  reset() {
    this.cameras.delete(this.view)
    void this.activate(this.view, this.reducedMotion)
  }
  suspend() {
    this.generation++
    this.motion++
    this.fleet.frozen = false
    this.moving = false
    this.viewer.scene.screenSpaceCameraController.enableInputs = true
    this.viewer.camera.cancelFlight()
    // Only an active globe records its camera: a second suspend must not overwrite it.
    if (!this.active) return
    this.active = false
    this.cameras.set(this.view, this.restoreCamera ?? this.currentPose())
    this.restoreCamera = undefined
    this.blur.enabled = false
    this.blurStrength = 0
    this.viewer.useDefaultRenderLoop = false
  }
  /** Leaving one map view for another: keep nothing of the old camera (zoom thresholds). */
  release() {
    this.motion++
    this.cameras.delete(this.view)
  }
  update(snapshot: Snapshot) {
    this.fleet.setVessels(snapshot.vessels)
    this.fleet.setHarbours(snapshot.harbours, snapshot.vessels)
    // New hails since the last update draw their arcs (newest first in the feed).
    const fresh = []
    for (const e of snapshot.feed) {
      if (e.key === this.lastHail) break
      fresh.push(e)
    }
    if (this.lastHail) for (const e of fresh.slice(0, 8).reverse()) this.fleet.addHail(e)
    this.lastHail = snapshot.feed[0]?.key ?? this.lastHail
    this.shadeAreas(snapshot)
    for (const coast of ['atlantic', 'pacific'] as const) {
      const label = this.hotspots.entities.getById(`coast-${coast}`)?.label
      const s = snapshot.stats[coast]
      if (label)
        (label.text as C.ConstantProperty).setValue(
          `${coast.toUpperCase()}\n${s.atSea.toLocaleString('en-CA')} at sea · ${s.inPort.toLocaleString('en-CA')} in port`,
        )
    }
  }
  select(id: string) {
    this.fleet.select(id)
  }
  quality(value: 'high' | 'low') {
    this.viewer.resolutionScale = value === 'high' ? 1 : 0.7
  }
  resize() {
    this.viewer.resize()
  }
  dispose() {
    this.disposed = true
    this.generation++
    this.fleet.dispose()
    for (const layer of this.layers.values()) layer.destroy()
    this.viewer.destroy()
  }
}
