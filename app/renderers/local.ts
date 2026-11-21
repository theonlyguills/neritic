import * as T from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import type { Water } from 'three/addons/objects/Water.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { seaAt } from './sea'
import { createBowSurge, createOcean } from './ocean'
import { weatherMaterial } from './weathering'
import { createGulls } from './seabirds'
import { createLensflare, skyRotationFor, skySunDirection } from './sun'
import { Soundscape, type SoundSamples } from './soundscape'
import { outfitWorkingDeck } from './working-deck'
import { glowPoints, loadScenery, type Scenery } from './scenery'
import type { Snapshot, ViewId } from '../domain/world'
import type { LiveVessel } from '../domain/simulation'
import {
  BOATS,
  CREW_URL,
  DUSK_SKY,
  SCENERIES,
  boatFor,
  sceneryForVessel,
  type BoatModel,
  type SceneryConfig,
} from '../domain/scenery'
import type { SceneAdapter } from './types'

/** Recorded one-shots; missing files are skipped (the procedural layers still play). */
const clip = (name: string) => `/audio/${name}.mp3`
const SOUND_SAMPLES: SoundSamples = {
  // Herring gull calls (Atlantic); provenance in public/data/manifest.json.
  gulls: ['gull-01', 'gull-02', 'gull-03', 'gull-04', 'gull-05', 'gull-06', 'gull-08'].map(clip),
  deck: [
    'deck-chain-01',
    'deck-chain-02',
    'deck-chain-03',
    'deck-clank-01',
    'deck-clank-02',
    'deck-door-01',
    'deck-door-02',
    'deck-creak-01',
  ].map(clip),
  sea: clip('sea-bed'),
}
type PresetName = 'elevated' | 'water' | 'deck' | 'bow'
type Preset = { position: T.Vector3; target: T.Vector3; minDistance: number }
/** What the scene is showing: a setting and the hull that represents the vessel. */
interface Placement {
  scenery: SceneryConfig
  boat: BoatModel
}
/** Most gulls any scenery asks for; each scenery shows a share of the flock. */
const MAX_GULLS = 26

export class LocalRenderer implements SceneAdapter {
  renderer: T.WebGLRenderer
  scene = new T.Scene()
  camera = new T.PerspectiveCamera(43, 1, 0.5, 30000)
  controls: OrbitControls
  /** Container that floats, pitches and rolls; the hull model inside it is swapped. */
  boat = new T.Group()
  water: Water
  sunlight: T.DirectionalLight
  frame = 0
  running = false
  reduced = false
  time = 0
  lastFrame = 0
  disposed = false
  /** Low-passed heave, pitch and roll: a hull does not follow every crest. */
  motion = { heave: 0, pitch: 0, roll: 0 }
  boatInverse = { value: new T.Matrix4() }
  /** World direction towards the photographed sun; shared with the water shader. */
  sunDirection = new T.Vector3()
  skyRotation = 0
  flare = createLensflare()
  /** Created on first visible activation (audio needs a user gesture), not during warm-up. */
  sound?: Soundscape
  soundEnabled = true
  /** Zoom-blur post-processing, used only while a transition is blurring the frame. */
  composer: EffectComposer
  zoomBlur: ShaderPass
  /**
   * Post-process anti-aliasing, only when the browser did not grant multisampling on the
   * canvas (it asks for `antialias: true`, but e.g. Chrome on some Intel GPUs ignores
   * that). With MSAA available this stays off and costs nothing.
   */
  smaa?: SMAAPass
  /** Scripted camera move around the vessel (zoom transitions); controls are off meanwhile. */
  flight?: {
    begin: number
    duration: number
    from: T.Spherical
    to: T.Spherical
    target: T.Vector3
    ease: (t: number) => number
    /** Easing of the orbit angle, if it differs from the rest of the move. */
    spin?: (t: number) => number
    /** Easing of the camera's tilt (polar angle), if it differs. */
    tilt?: (t: number) => number
    blur: (t: number) => number
    finish: () => void
    resolve: () => void
    /** Town flyover: camera and look-at points on splines instead of an orbit. */
    path?: { positions: T.CatmullRomCurve3; targets: T.CatmullRomCurve3; start: T.Vector3 }
    /** The viewer may cut it short (click, scroll or the Skip button). */
    skippable?: boolean
  }
  /** Raised over hills during a flyover; eases back down once they are passed. */
  private clearance = 0
  gulls = createGulls(MAX_GULLS, new T.Vector2(0, 30))
  bowSurge: ReturnType<typeof createBowSurge>
  /** Other vessels working the same ground, hull-down towards the horizon. */
  distant: { ship: T.Object3D; x: number; z: number; phase: number }[] = []
  distantGroup = new T.Group()
  /** Boats moored near the hero in harbour scenes (low-detail copies). */
  moored = new T.Group()
  /** Gear on the hero's wharf (fish totes). */
  wharfProps = new T.Group()
  mooredBoats: { ship: T.Object3D; phase: number }[] = []
  placement?: Placement
  model?: T.Object3D
  terrain?: Scenery
  presets: Record<PresetName, Preset> = {
    elevated: {
      position: new T.Vector3(58, 20, 66),
      target: new T.Vector3(0, 9, 0),
      minDistance: 20,
    },
    water: { position: new T.Vector3(52, 5, 58), target: new T.Vector3(0, 7, 0), minDistance: 20 },
    deck: { position: new T.Vector3(-12, 14, 31), target: new T.Vector3(0, 5, 14), minDistance: 4 },
    bow: {
      position: new T.Vector3(-50, 22, -72),
      target: new T.Vector3(0, 8, -6),
      minDistance: 20,
    },
  }
  hemisphere = new T.HemisphereLight(0xc1d4df, 0x223138, 0.35)
  /** Dusk look requested, and the 0…1 fade the lights follow. */
  dusk = false
  duskFade = 0
  private lastFade = 0
  /** Navigation lights on the hero hull (dusk only). */
  navLights?: T.Points
  /** Centre of the scenery's town (densest real buildings), for the flyover. */
  town?: T.Vector3
  /** Bow heading, radians clockwise from north (world −Z). */
  heading = 0
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  private gltfs = new Map<string, Promise<GLTF>>()
  private skies = new Map<string, Promise<{ texture: T.DataTexture; env: T.WebGLRenderTarget }>>()
  private boats = new Map<string, Promise<T.Object3D>>()
  private terrains = new Map<string, Promise<Scenery | undefined>>()
  private warmed = new Set<string>()
  private size = ''
  private vesselId = ''
  private seaState = 1
  /** Harbour scenes with an inbound vessel: the last stretch of the approach to the berth. */
  private arriving = false
  arrival?: {
    curve: T.CatmullRomCurve3
    from: number
    length: number
    begin: number
    /** Last step's demo time, for the heading's rate of turn. */
    last?: number
  }
  constructor(private element: HTMLElement) {
    this.renderer = new T.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
    this.renderer.toneMapping = T.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.85
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = T.PCFSoftShadowMap
    this.renderer.outputColorSpace = T.SRGBColorSpace
    element.appendChild(this.renderer.domElement)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.minDistance = 8
    this.controls.maxDistance = 160
    this.controls.maxPolarAngle = Math.PI / 2 - 0.035
    this.controls.enablePan = false
    // Any click or scroll during the town flyover lands it straight away.
    for (const type of ['pointerdown', 'wheel'] as const)
      this.renderer.domElement.addEventListener(type, () => this.skipFlight(), { passive: true })
    this.boat.rotation.order = 'YXZ'
    this.scene.add(this.hemisphere)
    this.sunlight = new T.DirectionalLight(0xffdcae, 2.2)
    this.sunlight.castShadow = true
    this.sunlight.shadow.mapSize.set(2048, 2048)
    Object.assign(this.sunlight.shadow.camera, {
      left: -40,
      right: 40,
      top: 40,
      bottom: -40,
      near: 1,
      far: 400,
    })
    this.sunlight.shadow.bias = -0.0003
    this.sunlight.shadow.normalBias = 0.08
    this.scene.add(this.sunlight, this.sunlight.target)
    this.scene.add(this.flare)
    this.scene.background = new T.Color('#97b2c3')
    // Marine haze: distant hulls and the horizon soften into the sky.
    this.scene.fog = new T.FogExp2('#b3b8b9', 0.0003)
    const normals = new T.TextureLoader().load('/assets/waternormals.jpg', (t) => {
      t.wrapS = t.wrapT = T.RepeatWrapping
    })
    this.water = createOcean(normals, this.sunDirection, {
      halfLength: 21,
      halfBeam: 5.7,
      speed: 0,
    })
    this.water.receiveShadow = true
    this.scene.add(
      this.water,
      this.boat,
      this.gulls.mesh,
      this.distantGroup,
      this.moored,
      this.wharfProps,
    )
    this.bowSurge = createBowSurge(this.water, new T.Vector3(0, 0, -21))
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.zoomBlur = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, strength: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float strength;
        varying vec2 vUv;
        void main() {
          vec2 toCentre = vUv - vec2(0.5);
          vec4 sum = vec4(0.0);
          for (int i = 0; i < 20; i++) {
            float t = float(i) / 19.0;
            sum += texture2D(tDiffuse, vUv - toCentre * t * strength * 0.4);
          }
          // Same deep-water fade as the globe's dive blur, for a seamless hand-off.
          vec3 colour = sum.rgb / 20.0 * (1.0 + strength * 0.12);
          colour = mix(colour, vec3(0.03, 0.08, 0.1), smoothstep(0.55, 1.0, strength) * 0.85);
          gl_FragColor = vec4(colour, 1.0);
        }`,
    })
    // Tone mapping and sRGB first, so the blur and its fade work in display colour, like
    // Cesium's post-process (the fade colour then matches on both sides of the cut).
    this.composer.addPass(new OutputPass())
    const gl = this.renderer.getContext()
    if ((gl.getParameter(gl.SAMPLES) as number) < 2) {
      this.smaa = new SMAAPass()
      this.composer.addPass(this.smaa)
    }
    // Recorded on the canvas for diagnosis (which anti-aliasing this browser is using).
    this.renderer.domElement.dataset.antialias = this.smaa ? 'smaa' : 'msaa'
    this.composer.addPass(this.zoomBlur)
    this.resize()
  }
  /** Overhead and slightly south of the boat: north-up, like the globe camera at the cut. */
  private overhead() {
    return new T.Spherical(340, 0.06, 0)
  }
  private fly(flight: Omit<NonNullable<LocalRenderer['flight']>, 'begin' | 'resolve'>) {
    this.flight?.resolve()
    this.controls.enabled = false
    this.controls.target.copy(flight.target)
    return new Promise<void>((resolve) => {
      this.flight = { ...flight, begin: performance.now(), resolve }
      this.stepFlight()
    })
  }
  /**
   * Second half of the map → vessel zoom: start high overhead, fully blurred, then swoop
   * down on an arc into the elevated preset while the blur clears. Call before `activate`
   * so the first visible frame is the overhead one.
   */
  /** How long the entrance about to play will run, s (the page holds its panels back). */
  arrivalDuration() {
    return this.placement?.scenery.tour && this.town ? this.tourPlan().duration : 5.6
  }
  /** End the entrance flight now, on its final view (presenter's Skip). */
  skipFlight() {
    if (!this.flight?.skippable) return
    this.flight.begin = -Infinity
    this.stepFlight()
  }
  /**
   * Town flyover keyframes: from high beyond the town (its densest real buildings), down
   * over the rooftops, along the shore and in to the view off the vessel's bow.
   */
  private tourPlan() {
    const town = this.town!
    const boat = this.offset
    const bow = this.presets.bow
    const end = bow.position.clone().add(boat)
    const endTarget = bow.target.clone().add(boat)
    const ground = (x: number, z: number) => Math.max(0, this.terrain!.heightAt(x, z))
    const away = new T.Vector3(town.x - boat.x, 0, town.z - boat.z)
    const distance = Math.max(200, away.length())
    away.normalize()
    const side = new T.Vector3(-away.z, 0, away.x)
    const at = (base: T.Vector3, back: number, across: number, height: number) => {
      const p = base.clone().addScaledVector(away, back).addScaledVector(side, across)
      p.y = ground(p.x, p.z) + height
      return p
    }
    const reach = Math.min(1, distance / 1500)
    // Far towns (St. John's, 3 km behind The Narrows): look ahead down the harbour as we
    // leave the rooftops, then come in close to the vessel early rather than over open sea.
    const toward = (k: number) => town.clone().lerp(boat, k)
    const positions = [
      at(town, 200 + 120 * reach, 220, 260 + 100 * reach),
      at(town, 90, 140, 150),
      // Near towns swing out over the harbour; a far one stays in the channel between the
      // hills (The Narrows), below the hilltops.
      at(toward(0.55 + 0.35 * reach), 0, -160 * (0.6 + reach) * (1 - reach * 0.9), 95 - 20 * reach),
      end,
    ]
    const targets = [
      town.clone().setY(ground(town.x, town.z)),
      toward(0.35 + 0.35 * reach).setY(ground(town.x, town.z) * 0.3),
      boat.clone().setY(3),
      endTarget,
    ]
    let length = 0
    for (let i = 1; i < positions.length; i++) length += positions[i]!.distanceTo(positions[i - 1]!)
    return {
      positions: new T.CatmullRomCurve3(positions, false, 'centripetal'),
      targets: new T.CatmullRomCurve3(targets, false, 'centripetal'),
      duration: T.MathUtils.clamp(7 + length / 360, 11, 18),
    }
  }
  arrive(duration = 5.6) {
    if (this.placement?.scenery.tour && this.town) {
      const plan = this.tourPlan()
      this.clearance = 0
      return this.fly({
        duration: plan.duration,
        target: this.presets.bow.target.clone().add(this.offset),
        from: new T.Spherical(),
        to: new T.Spherical(),
        path: { positions: plan.positions, targets: plan.targets, start: this.offset },
        skippable: true,
        // Gentle start out of the blur, unhurried glide, soft landing.
        ease: (t) => (1 - Math.cos(Math.PI * t)) / 2,
        blur: (t) => 1 - T.MathUtils.smoothstep(t, 0, 0.08),
        finish: () => this.preset('bow'),
      })
    }
    // Cinematic entrance: out of the blur high over the area, spiral down around the vessel
    // (the coast and harbour sweep past) and settle on a three-quarter view off the bow.
    const preset = this.presets.bow
    const target = preset.target.clone().add(this.offset)
    const to = new T.Spherical().setFromVector3(preset.position.clone().sub(preset.target))
    const coastal = !!this.terrain
    const from = new T.Spherical(coastal ? 620 : 420, 0.08, to.theta - Math.PI * 1.25)
    return this.fly({
      duration,
      target,
      from,
      to,
      ease: (t) => 1 - Math.pow(1 - t, 1.7), // stay wide while circling, then close in
      spin: (t) => 1 - Math.pow(1 - t, 1.8), // keep turning all the way down
      tilt: (t) => 1 - Math.pow(1 - Math.min(1, t * 1.6), 3), // to an oblique view early
      // so the coast and harbour sweep across the frame during the turn.
      blur: (t) => 1 - T.MathUtils.smoothstep(t, 0, 0.3),
      finish: () => this.preset('bow'),
    })
  }
  /**
   * First half of the vessel → map zoom: lift from wherever the viewer is to high overhead,
   * accelerating, as the blur builds to its peak, where the caller cuts to the globe.
   */
  depart(duration = 0.9) {
    const target = this.controls.target.clone()
    const from = new T.Spherical().setFromVector3(this.camera.position.clone().sub(target))
    const to = this.overhead()
    // Unwind the azimuth the short way round so the lift does not spin.
    to.theta =
      from.theta + Math.atan2(Math.sin(to.theta - from.theta), Math.cos(to.theta - from.theta))
    return this.fly({
      duration,
      target,
      from,
      to,
      ease: (t) => t * t * (2.2 - 1.2 * t), // accelerating, still moving at the cut
      blur: (t) => Math.pow(t, 2.5),
      finish: () => undefined,
    })
  }
  private stepFlight() {
    const f = this.flight!
    const t = Math.min(1, (performance.now() - f.begin) / (f.duration * 1000))
    const e = f.ease(t)
    if (f.path) {
      const p = f.path.positions.getPoint(e, this.camera.position)
      const look = f.path.targets.getPoint(e)
      // An arriving vessel keeps moving: the end of the flight follows it.
      const drift = this.offset.sub(f.path.start).multiplyScalar(e)
      p.add(drift)
      look.add(drift)
      if (this.terrain) {
        const need = Math.max(0, this.terrain.heightAt(p.x, p.z) + 28 - p.y)
        this.clearance = Math.max(need, this.clearance * 0.97)
        p.y += this.clearance * (1 - e * e)
      }
      this.camera.lookAt(look)
      this.zoomBlur.uniforms.strength!.value = f.blur(t)
      if (t < 1) return
      this.flight = undefined
      f.finish()
      this.controls.enabled = true
      f.resolve()
      return
    }
    const radius = Math.exp(T.MathUtils.lerp(Math.log(f.from.radius), Math.log(f.to.radius), e))
    const phi = T.MathUtils.lerp(
      f.from.phi,
      f.to.phi,
      f.tilt ? f.tilt(t) : f.to.phi > f.from.phi ? Math.pow(e, 1.4) : e,
    )
    const theta = T.MathUtils.lerp(f.from.theta, f.to.theta, f.spin ? f.spin(t) : e)
    this.camera.position.setFromSpherical(new T.Spherical(radius, phi, theta)).add(f.target)
    // Never fly through the hills on the way round.
    if (this.terrain) {
      const p = this.camera.position
      p.y = Math.max(p.y, this.terrain.heightAt(p.x, p.z) + 10)
    }
    this.camera.lookAt(f.target)
    this.zoomBlur.uniforms.strength!.value = f.blur(t)
    if (t < 1) return
    this.flight = undefined
    f.finish()
    this.controls.enabled = true
    f.resolve()
  }

  // ---- Asset loading (cached; each asset is fetched and prepared once) ----------------

  private gltf(url: string) {
    let pending = this.gltfs.get(url)
    if (!pending) {
      pending = this.loader.loadAsync(url)
      pending.catch(() => this.gltfs.delete(url))
      this.gltfs.set(url, pending)
    }
    return pending
  }
  private sky(url: string) {
    let pending = this.skies.get(url)
    if (!pending) {
      pending = new RGBELoader().loadAsync(url).then((texture) => {
        texture.mapping = T.EquirectangularReflectionMapping
        const pmrem = new T.PMREMGenerator(this.renderer)
        const env = pmrem.fromEquirectangular(texture)
        pmrem.dispose()
        return { texture, env }
      })
      pending.catch(() => this.skies.delete(url))
      this.skies.set(url, pending)
    }
    return pending
  }
  /** A hull scaled to its real length with its waterline at y = 0, bow towards −Z. */
  private hull(boat: BoatModel) {
    let pending = this.boats.get(boat.id)
    if (!pending) {
      pending = (async () => {
        const [gltf, crew] = await Promise.all([
          this.gltf(boat.url),
          boat.trawlerDeck ? this.gltf(CREW_URL) : undefined,
        ])
        const model = gltf.scene
        // Procedural wear on the vessel's own paint (not the crew); AO is baked into COLOR_0.
        model.traverse((object) => {
          const mesh = object as T.Mesh
          if (!mesh.isMesh) return
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
            weatherMaterial(material, this.boatInverse)
        })
        if (crew) outfitWorkingDeck(model, crew.scene)
        const wrapper = new T.Group()
        wrapper.add(model)
        this.fit(model, boat)
        wrapper.traverse((object) => {
          const mesh = object as T.Mesh
          if (mesh.isMesh) mesh.castShadow = mesh.receiveShadow = true
        })
        return wrapper
      })()
      pending.catch(() => this.boats.delete(boat.id))
      this.boats.set(boat.id, pending)
    }
    return pending
  }
  /** Asset coordinates are metres, bow +Z: rotate to bow −Z, scale, sit on the waterline. */
  private fit(model: T.Object3D, boat: BoatModel) {
    model.rotation.y = Math.PI
    model.position.set(0, 0, 0)
    model.scale.setScalar(1)
    model.updateMatrixWorld(true)
    const box = new T.Box3().setFromObject(model)
    const size = box.getSize(new T.Vector3())
    model.scale.setScalar(boat.lengthM / Math.max(size.x, size.z))
    model.updateMatrixWorld(true)
    const scaled = new T.Box3().setFromObject(model)
    const center = scaled.getCenter(new T.Vector3())
    model.position.set(-center.x, -scaled.min.y - boat.waterlineOffset, -center.z)
  }
  private terrainFor(scenery: SceneryConfig) {
    if (!scenery.terrainUrl) return Promise.resolve(undefined)
    let pending = this.terrains.get(scenery.id)
    if (!pending) {
      pending = loadScenery(scenery.terrainUrl, this.renderer, { carShare: scenery.carShare })
      pending.catch(() => this.terrains.delete(scenery.id))
      this.terrains.set(scenery.id, pending)
    }
    return pending
  }
  private placementFor(vessel?: LiveVessel): Placement {
    if (!vessel) return { scenery: SCENERIES['grand-banks']!, boat: BOATS.trawler! }
    return { scenery: sceneryForVessel(vessel), boat: boatFor(vessel) }
  }
  private async load(placement: Placement) {
    const [model, sky, terrain] = await Promise.all([
      this.hull(placement.boat),
      this.sky(this.skyFor(placement.scenery).url),
      // Real-geography scenery is optional dressing: without it the scene is open water.
      this.terrainFor(placement.scenery).catch(() => undefined),
    ])
    return { model, sky, terrain }
  }
  /** Fetch and prepare a vessel's scene in the background (no visible change). */
  preload(vessel?: LiveVessel) {
    void this.load(this.placementFor(vessel)).catch(() => undefined)
  }

  async initialize() {
    await this.prepare()
  }

  /** Load (if needed) and switch to the scene for a vessel. */
  async prepare(vessel?: LiveVessel) {
    const placement = this.placementFor(vessel)
    this.vesselId = vessel?.id ?? ''
    this.arriving = vessel?.status === 'inbound'
    let loaded: Awaited<ReturnType<LocalRenderer['load']>>
    try {
      loaded = await this.load(placement)
    } catch {
      throw new Error('The vessel, sky or scenery assets could not be loaded. Please retry.')
    }
    if (this.disposed) return
    this.apply(placement, loaded)
  }

  private apply(placement: Placement, loaded: Awaited<ReturnType<LocalRenderer['load']>>) {
    const { scenery, boat } = placement
    const same = this.placement?.scenery.id === scenery.id && this.placement?.boat.id === boat.id
    this.placement = placement
    // Hull.
    if (this.model !== loaded.model) {
      if (this.model) this.boat.remove(this.model)
      this.model = loaded.model
      this.boat.add(loaded.model)
      const uniforms = this.water.material.uniforms
      uniforms.hullHalfLength!.value = boat.lengthM * 0.45
      uniforms.hullHalfBeam!.value = boat.beamM / 2
      this.bowSurge = createBowSurge(this.water, new T.Vector3(0, 0, -boat.lengthM * 0.45))
      const shadow = this.sunlight.shadow.camera
      const r = Math.max(14, boat.lengthM * 0.85)
      Object.assign(shadow, { left: -r, right: r, top: r, bottom: -r })
      shadow.updateProjectionMatrix()
      this.boat.updateMatrixWorld(true)
      this.buildNavLights()
      this.sound?.setHull({ length: boat.lengthM, engine: boat.engine })
    }
    this.seaState = scenery.seaState
    this.water.material.uniforms.seaState!.value = scenery.seaState
    // Terrain.
    if (this.terrain !== loaded.terrain) {
      if (this.terrain) this.scene.remove(this.terrain.group)
      this.terrain = loaded.terrain
      if (this.terrain) this.scene.add(this.terrain.group)
      const shore = this.water.material.uniforms
      if (this.terrain) {
        shore.shoreHeight!.value = this.terrain.heightTexture
        const b = this.terrain.bounds
        shore.shoreBounds!.value.set(b.minX, b.minZ, b.size, 1)
      } else shore.shoreBounds!.value.set(0, 0, 1, 0)
    }
    // Hero heading: coastal sceneries say how the hull lies (alongside the wharf, etc.).
    const meta = this.terrain?.meta
    this.heading = T.MathUtils.degToRad(meta?.boat?.headingDeg ?? 0)
    this.boat.rotation.y = -this.heading
    this.water.material.uniforms.hullForward!.value.set(
      Math.sin(this.heading),
      -Math.cos(this.heading),
    )
    this.water.material.uniforms.hullPosition!.value.set(0, 0)
    if (scenery.kind === 'harbour') this.water.material.uniforms.hullSpeed!.value = 0
    this.applyLook(scenery, loaded.sky)
    this.boat.position.set(0, 0, 0)
    this.arrival = undefined
    const path = meta?.arrival
    if (scenery.kind === 'harbour' && this.arriving && path && path.length > 1) {
      // Give breakwaters a wide berth: at least 24 m from their rock, hull centre to edge.
      const rocks = meta?.features.breakwaters ?? []
      const points = path.map(([x, z]) => {
        const p = new T.Vector2(x, z)
        for (const { polygon } of rocks)
          for (let i = 0; i < polygon.length; i++) {
            const a = new T.Vector2(...polygon[i]!)
            const b = new T.Vector2(...polygon[(i + 1) % polygon.length]!)
            const ab = b.clone().sub(a)
            const t = T.MathUtils.clamp(
              p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6),
              0,
              1,
            )
            const closest = a.add(ab.multiplyScalar(t))
            const away = p.clone().sub(closest)
            const d = away.length()
            if (d < 24 && d > 1e-3) p.add(away.multiplyScalar((24 - d) / d))
          }
        return p
      })
      // A smooth track through the waypoints (the raw path has corners, and the push
      // away from the breakwater adds kinks): the boat follows the spline by arc length.
      const curve = new T.CatmullRomCurve3(
        points.map((p) => new T.Vector3(p.x, 0, p.y)),
        false,
        'centripetal',
      )
      curve.arcLengthDivisions = 600
      const length = curve.getLength()
      this.arrival = {
        curve,
        from: Math.max(0, length - 320),
        length,
        begin: -1,
      }
      this.stepArrival()
    }
    this.town = this.terrain ? townCentre(this.terrain) : undefined
    this.distantGroup.visible = scenery.distantShips
    this.gulls.mesh.count = Math.min(MAX_GULLS, scenery.gulls)
    this.placeMoored(scenery, boat)
    this.dressWharf(scenery)
    this.computePresets(scenery, boat)
    if (!same || !this.running) this.preset('elevated')
    this.boat.updateMatrixWorld(true)
    if (scenery.distantShips && !this.distant.length && BOATS.trawler!.farUrl)
      void this.loadDistant(BOATS.trawler!)
  }

  /**
   * Inbound in a harbour: motor in along the real approach, slowing to the berth. The
   * camera keeps its offset from the hull, so the viewer rides in with the boat.
   */
  private stepArrival() {
    const a = this.arrival
    if (!a) return
    if (a.begin < 0) a.begin = this.time
    const span = a.length - a.from
    const duration = (span / 3.6) * 2 // decelerating from ~7 kn to a stop
    const u = Math.min(1, (this.time - a.begin) / duration)
    const along = a.from + span * (1 - (1 - u) ** 2)
    const speed = ((2 * span) / duration) * (1 - u)
    const point = a.curve.getPointAt(Math.min(1, along / a.length))
    const x = point.x,
      z = point.z
    // Steer for a point a boat length or so ahead on the track, then turn onto the berth
    // heading over the last 45 m.
    const ahead = a.curve.getPointAt(Math.min(1, (along + 15) / a.length))
    const track =
      ahead.distanceTo(point) > 0.5
        ? Math.atan2(ahead.x - point.x, -(ahead.z - point.z))
        : this.heading
    const berth = T.MathUtils.degToRad(this.terrain?.meta.boat.headingDeg ?? 0)
    const settle = 1 - T.MathUtils.smoothstep(a.length - along, 5, 45)
    const delta = Math.atan2(Math.sin(berth - track), Math.cos(berth - track))
    const goal = track + delta * settle
    // A hull answers the rudder gradually: ease the heading toward the goal.
    if (a.last === undefined) this.heading = goal // start on the track
    const dt = a.last === undefined ? 0 : Math.max(0, this.time - a.last)
    a.last = this.time
    const turn = Math.atan2(Math.sin(goal - this.heading), Math.cos(goal - this.heading))
    this.heading += turn * (1 - Math.exp(-dt / 1.2))
    const moved = new T.Vector3(x - this.boat.position.x, 0, z - this.boat.position.z)
    this.boat.position.x = x
    this.boat.position.z = z
    this.boat.rotation.y = -this.heading
    const uniforms = this.water.material.uniforms
    uniforms.hullPosition!.value.set(x, z)
    uniforms.hullForward!.value.set(Math.sin(this.heading), -Math.cos(this.heading))
    uniforms.hullSpeed!.value = speed
    if (!this.flight) {
      this.camera.position.add(moved)
      this.controls.target.add(moved)
    }
    if (u >= 1) this.arrival = undefined
  }

  /**
   * Where the cinematic entrance lands: off the bow, on the open-water side, looking back
   * along the hull at the vessel with the setting around it.
   */
  private bowPreset(boat: BoatModel): Preset {
    const L = boat.lengthM
    const d = Math.max(30, L * 1.9)
    const forward = new T.Vector3(Math.sin(this.heading), 0, -Math.cos(this.heading))
    const side = new T.Vector3(-forward.z, 0, forward.x)
    const candidate = (sign: number) =>
      forward
        .clone()
        .multiplyScalar(d * 0.82)
        .addScaledVector(side, sign * d * 0.55)
        .setY(Math.max(6, d * 0.24))
    let position = candidate(-1)
    if (this.terrain) {
      // Pick the side over open water, and stay well clear of the ground.
      const ground = (p: T.Vector3) => this.terrain!.heightAt(p.x, p.z)
      const other = candidate(1)
      if (ground(other) < ground(position)) position = other
      position.y = Math.max(position.y, ground(position) + 12)
    }
    return {
      position,
      target: forward
        .clone()
        .multiplyScalar(L * 0.12)
        .setY(boat.deckHeight * 0.7 + L * 0.06),
      minDistance: Math.max(8, L * 0.6),
    }
  }

  private skyFor(scenery: SceneryConfig) {
    return this.dusk ? DUSK_SKY : scenery.sky
  }
  /**
   * Sky, light, haze and water tint for the scenery at the current time of day. Dusk: the
   * sun on the horizon, a darker sky and environment, warmer low light, deeper water.
   */
  private applyLook(
    scenery: SceneryConfig,
    sky: { texture: T.DataTexture; env: T.WebGLRenderTarget },
  ) {
    const cfg = this.skyFor(scenery)
    const dusk = this.dusk
    this.scene.background = sky.texture
    this.scene.backgroundIntensity = cfg.intensity
    this.scene.environment = sky.env.texture
    this.scene.environmentIntensity = dusk ? 0.28 : 0.65
    const fog = this.scene.fog as T.FogExp2
    fog.color.set(scenery.fog.colour)
    if (dusk) fog.color.lerp(new T.Color('#4a4650'), 0.65)
    fog.density = scenery.fog.density * (dusk ? 1.15 : 1)
    this.hemisphere.intensity = dusk ? 0.09 : 0.35
    this.sunlight.color.set(dusk ? 0xff9b5c : 0xffdcae)
    this.sunlight.intensity = cfg.sunlight
    this.flare.visible = cfg.flare
    this.renderer.toneMappingExposure = dusk ? 0.74 : 0.85
    const water = this.water.material.uniforms
    water.sunColor!.value.set(dusk ? 0xffa266 : 0xffe2b8)
    water.waterColor!.value.set(dusk ? 0x030d14 : 0x04141a)
    // Coastal scenes: the sun sits off to one side of the view towards land, so the low
    // light rakes the hills and the sky's sun disk can appear at the edge of the frame.
    const meta = this.terrain?.meta
    const sunBearing =
      meta?.viewBearingDeg !== undefined
        ? T.MathUtils.degToRad(meta.viewBearingDeg + (scenery.sunOffsetDeg ?? 35))
        : undefined
    const sunAzimuth =
      sunBearing !== undefined
        ? Math.atan2(-Math.cos(sunBearing), Math.sin(sunBearing))
        : T.MathUtils.degToRad(cfg.sunAzimuth)
    this.skyRotation = skyRotationFor(cfg.sun, sunAzimuth)
    this.scene.backgroundRotation.y = this.scene.environmentRotation.y =
      this.skyRotation + this.time * 0.0007
  }
  /** Switch between day and dusk (the dusk sky loads on first use). */
  async setDusk(on: boolean) {
    this.dusk = on
    const scenery = this.placement?.scenery
    if (!scenery) return
    const sky = await this.sky(this.skyFor(scenery).url).catch(() => undefined)
    if (!sky || this.disposed || this.dusk !== on || this.placement?.scenery !== scenery) return
    this.applyLook(scenery, sky)
    if (!this.running) await this.warmUp()
  }
  /** Load the dusk sky in the background so the first switch is quick. */
  prefetchDusk() {
    void this.sky(DUSK_SKY.url).catch(() => undefined)
  }
  /** Sidelights, masthead and stern lights at the positions measured on each hull. */
  private buildNavLights() {
    const boat = this.placement?.boat
    if (!this.model || !boat) return
    const { side, masthead, stern, work } = boat.navLights
    const positions = [-side[0], side[1], side[2], ...side, ...masthead, ...stern]
    const colours = [1, 0.12, 0.08, 0.1, 1, 0.3, 1, 0.97, 0.9, 1, 0.95, 0.85]
    if (work) {
      positions.push(...work)
      colours.push(1, 0.95, 0.85)
    }
    const L = boat.lengthM
    const fresh = glowPoints(positions, colours, Math.max(1.6, L * 0.05), 'nav-lights')
    if (!this.navLights) {
      this.navLights = fresh
      this.boat.add(fresh)
      return
    }
    // Keep the existing material: a shader warm-up (compileAsync) may still hold it, and
    // disposing it mid-compile breaks three's ready check. Swap the geometry only.
    const old = this.navLights.geometry
    this.navLights.geometry = fresh.geometry
    ;(this.navLights.material as T.PointsMaterial).size = (fresh.material as T.PointsMaterial).size
    ;(fresh.material as T.Material).dispose()
    old.dispose()
  }

  /** Camera presets: framed on the hull, looking towards the land where there is some. */
  private computePresets(scenery: SceneryConfig, boat: BoatModel) {
    const L = boat.lengthM
    const bearing = this.terrain?.meta.viewBearingDeg
    if (bearing === undefined && boat.id === 'trawler') {
      this.presets = {
        elevated: {
          position: new T.Vector3(58, 20, 66),
          target: new T.Vector3(0, 9, 0),
          minDistance: 20,
        },
        water: {
          position: new T.Vector3(52, 5, 58),
          target: new T.Vector3(0, 7, 0),
          minDistance: 20,
        },
        deck: {
          position: new T.Vector3(-12, 14, 31),
          target: new T.Vector3(0, 5, 14),
          minDistance: 4,
        },
        bow: this.bowPreset(boat),
      }
      return
    }
    // Look direction (towards land), world xz; the camera sits on the far side of the hull.
    const b = T.MathUtils.degToRad(bearing ?? 225)
    const look = new T.Vector3(Math.sin(b), 0, -Math.cos(b))
    const side = new T.Vector3(-look.z, 0, look.x)
    const d = Math.max(30, L * 2.3)
    const at = (back: number, across: number, up: number) =>
      look.clone().multiplyScalar(-back).addScaledVector(side, across).setY(up)
    const deckY = boat.deckHeight
    const stern = new T.Vector3(Math.sin(this.heading), 0, -Math.cos(this.heading)).multiplyScalar(
      -L * 0.62,
    )
    this.presets = {
      elevated: {
        position: at(d, d * 0.42, d * 0.33),
        target: look
          .clone()
          .multiplyScalar(L * 0.6)
          .setY(deckY * 0.8),
        minDistance: Math.max(8, L * 0.6),
      },
      water: {
        position: at(d * 0.75, -d * 0.35, 2.4),
        target: look
          .clone()
          .multiplyScalar(L * 0.4)
          .setY(deckY + 1),
        minDistance: Math.max(8, L * 0.6),
      },
      deck: {
        position: stern.clone().setY(deckY + 3.2),
        target: stern
          .clone()
          .multiplyScalar(-0.6)
          .setY(deckY + 1.2),
        minDistance: 2,
      },
      bow: this.bowPreset(boat),
    }
    void scenery
  }

  /**
   * Harbour scenes, small-town style: a boat alongside each of the other wharves and a
   * couple swinging on moorings out in the harbour, well apart from each other and the hero.
   */
  private placeMoored(scenery: SceneryConfig, boat: BoatModel) {
    this.moored.clear()
    this.mooredBoats = []
    const terrain = this.terrain
    if (scenery.kind !== 'harbour' || !terrain) return
    const model = BOATS[`inshore-${scenery.coast}`] ?? boat
    const far = model.farUrl ?? BOATS.trawler!.farUrl
    if (!far) return
    const L = model.lengthM
    const wet = (x: number, z: number, heading: number, depth = 1.2) => {
      const fx = Math.sin(heading) * L * 0.5,
        fz = -Math.cos(heading) * L * 0.5
      return [0, 1, -1].every((k) => terrain.heightAt(x + fx * k, z + fz * k) < -depth)
    }
    const spots: { x: number; z: number; heading: number }[] = []
    // Keep the fairway into the berth free (the arriving hero motors along it).
    const fairway = terrain.meta.arrival ?? []
    const clear = (x: number, z: number, gap: number) =>
      Math.hypot(x, z) > gap &&
      spots.every((p) => Math.hypot(p.x - x, p.z - z) > gap) &&
      fairway.every(([fx, fz]) => Math.hypot(fx - x, fz - z) > L * 1.6)
    // Alongside: the longest face of each other wharf, a beam's width off it.
    for (const pier of terrain.meta.features.piers) {
      const ring = pier.polygon
      let best = -1,
        bestLength = 0
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!,
          b = ring[(i + 1) % ring.length]!
        const length = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (length > bestLength) [best, bestLength] = [i, length]
      }
      if (best < 0 || bestLength < L * 0.8) continue
      const a = ring[best]!,
        b = ring[(best + 1) % ring.length]!
      const ux = (b[0] - a[0]) / bestLength,
        uz = (b[1] - a[1]) / bestLength
      const heading = Math.atan2(ux, -uz)
      for (const side of [1, -1])
        for (const along of [0.5, 0.3, 0.7]) {
          const off = model.beamM / 2 + 1.4
          const x = a[0] + ux * bestLength * along - uz * off * side
          const z = a[1] + uz * bestLength * along + ux * off * side
          if (wet(x, z, heading) && clear(x, z, L * 2.2)) {
            spots.push({ x, z, heading: heading + (spots.length % 2 ? Math.PI : 0) })
            break
          }
        }
    }
    // On moorings: open water within a few hundred metres, bows to the breeze.
    for (let k = 0; k < 24 && spots.length < 5; k++) {
      const angle = k * 2.39996 + 0.7
      const r = 70 + ((k * 37) % 160)
      const x = Math.sin(angle) * r,
        z = -Math.cos(angle) * r
      const heading = 0.6 + Math.sin(k * 1.7) * 0.25
      if (wet(x, z, heading, 2.5) && clear(x, z, L * 3.5)) spots.push({ x, z, heading })
    }
    void this.gltf(far).then((gltf) => {
      if (this.placement?.scenery.id !== scenery.id) return
      for (const [index, spot] of spots.entries()) {
        const ship = new T.Group()
        const copy = gltf.scene.clone(true)
        this.fit(copy, model)
        ship.add(copy)
        ship.position.set(spot.x, 0, spot.z)
        ship.rotation.order = 'YXZ'
        ship.rotation.y = -spot.heading
        this.moored.add(ship)
        this.mooredBoats.push({ ship, phase: index * 1.9 })
      }
      if (!this.running) void this.warmUp()
    })
  }

  /** Stacks of fish totes on the hero's wharf, a few metres in from the berth face. */
  private dressWharf(scenery: SceneryConfig) {
    this.wharfProps.clear()
    const meta = this.terrain?.meta
    const face = meta?.berthFace
    if (scenery.kind !== 'harbour' || !meta || !face || face.length < 2) return
    const [a, b] = face as [[number, number], [number, number]]
    const along = new T.Vector2(b[0] - a[0], b[1] - a[1]).normalize()
    const mid = new T.Vector2((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    const inward = mid.clone().normalize() // the berth is at the origin, the wharf beyond the face
    let deck = 1.5
    let nearest = Infinity
    for (const pier of meta.features.piers)
      for (const [x, z] of pier.polygon) {
        const d = Math.hypot(x - mid.x, z - mid.y)
        if (d < nearest) [nearest, deck] = [d, pier.deckHeight]
      }
    void this.gltf('/assets/fish-crate.glb').then((gltf) => {
      if (this.placement?.scenery.id !== scenery.id) return
      const box = new T.Box3().setFromObject(gltf.scene)
      const size = box.getSize(new T.Vector3())
      const scale = 0.8 / Math.max(size.x, size.z)
      const height = size.y * scale * 0.96
      const stacks: [number, number, number][] = [
        [-3.5, 2.0, 3],
        [-2.6, 2.1, 2],
        [1.2, 2.6, 4],
        [2.1, 2.5, 1],
        [4.6, 3.4, 2],
      ]
      for (const [u, v, count] of stacks)
        for (let i = 0; i < count; i++) {
          const crate = gltf.scene.clone(true)
          crate.scale.setScalar(scale)
          const p = mid.clone().addScaledVector(along, u).addScaledVector(inward, v)
          crate.position.set(p.x, deck + i * height - box.min.y * scale, p.y)
          crate.rotation.y = Math.atan2(along.x, along.y) + Math.sin(u * 7 + i * 3) * 0.12
          crate.traverse((o) =>
            (o as T.Mesh).isMesh ? ((o.castShadow = o.receiveShadow = true), undefined) : undefined,
          )
          this.wharfProps.add(crate)
        }
    })
  }

  /** Other vessels on the same ground: a low-detail copy of the hull (~24k triangles). */
  async loadDistant(boat: BoatModel) {
    const far = await this.gltf(boat.farUrl!).catch(() => undefined)
    if (!far || this.disposed || this.distant.length) return
    for (const [x, z, heading, phase] of [
      [-1150, -1650, 0.9, 0],
      [-3400, -700, -0.4, 2.1],
      [500, -3900, 2.6, 4.2],
    ]) {
      const ship = new T.Group()
      const model = far.scene.clone(true)
      this.fit(model, boat)
      ship.add(model)
      ship.position.set(x!, 0, z!)
      ship.rotation.y = heading!
      this.distantGroup.add(ship)
      this.distant.push({ ship, x: x!, z: z!, phase: phase! })
    }
    // They arrive after the background warm-up: upload them too while still hidden.
    if (!this.running) await this.warmUp()
  }
  /**
   * Prepare GPU state while hidden: compile every material's program and upload geometry
   * and textures with one off-screen frame, so the first visible frame does not stall.
   */
  async warmUp() {
    if (this.disposed || this.running) return
    // Already compiled and uploaded for this setting and hull: nothing to do (re-running it
    // re-allocates the canvas and redraws everything, a visible stall on laptop GPUs).
    const key = `${this.placement?.scenery.id}/${this.placement?.boat.id}/${this.distant.length}/${this.moored.children.length}`
    if (this.warmed.has(key)) return
    this.warmed.add(key)
    this.resize()
    this.boat.updateMatrixWorld()
    this.boatInverse.value.copy(this.boat.matrixWorld).invert()
    // Compile the dusk light sprites too (hidden by day), so switching to dusk is smooth.
    const sprites: T.Object3D[] = []
    this.scene.traverse((o) => {
      if ((o as T.Points).isPoints && !o.visible) sprites.push(o)
    })
    for (const o of sprites) o.visible = true
    await this.renderer.compileAsync(this.scene, this.camera)
    for (const o of sprites) o.visible = false
    if (this.disposed || this.running) return
    this.renderer.render(this.scene, this.camera)
    // Also build the transition's post-processing (blur + output passes): compiling those
    // at the cut stalled the zoom by seconds on Windows/ANGLE, where shader compiles are slow.
    this.zoomBlur.uniforms.strength!.value = 0.5
    this.composer.render()
    this.zoomBlur.uniforms.strength!.value = 0
    this.createSound()
  }
  /**
   * Build the soundscape (silent and suspended until a user gesture and activation), so
   * its audio graph and sample decoding are not paid for at the moment of the cut.
   */
  private createSound() {
    const boat = this.placement?.boat ?? BOATS.trawler!
    this.sound ??= new Soundscape(
      this.camera,
      this.boat,
      this.scene,
      { length: boat.lengthM, deckY: boat.deckHeight },
      SOUND_SAMPLES,
    )
    this.sound.setHull({ length: boat.lengthM, engine: boat.engine })
    return this.sound
  }
  async activate(_view: ViewId, reduced: boolean) {
    this.reduced = reduced
    const sound = this.createSound()
    sound.setSeaState(this.seaState)
    sound.setEnabled(this.soundEnabled)
    sound.setActive(true)
    this.running = true
    this.lastFade = performance.now()
    // Arriving at dusk (chosen on the map): the lights are already on for the flyover.
    this.duskFade = this.dusk ? 1 : 0
    // The dusk sky is a few megabytes: fetch it once the scene has settled.
    setTimeout(() => this.prefetchDusk(), 4000)
    this.lastFrame = this.lastFrameAt = this.stepSince = performance.now()
    this.frameMs = 16
    this.tick()
  }
  /** Smoothed frame time (ms) and when the current resolution step began. */
  private frameMs = 16
  private stepSince = 0
  /**
   * Keep the scene fluid on modest laptop GPUs: if frames stay slow for a couple of seconds,
   * render at a lower pixel ratio (one step at a time, never back up during a visit).
   */
  private governResolution(now: number) {
    const dt = now - this.lastFrameAt
    this.lastFrameAt = now
    if (dt <= 0 || dt > 250 || this.flight || this.currentQuality === 'low') return
    // Ignore the first moments of a visit (texture uploads, first draws).
    if (now - this.stepSince < 1500) return
    this.frameMs += (dt - this.frameMs) * 0.05
    if (now - this.stepSince < 4000 || this.frameMs < 26) return
    const ratio = this.renderer.getPixelRatio()
    // One step at most (device pixels → CSS pixels): sharpness matters for the demo.
    const next = ratio > 1.01 ? 1 : 0
    if (!next) return
    this.renderer.setPixelRatio(next)
    this.composer.setPixelRatio(next)
    this.resize()
    this.stepSince = now
    this.frameMs = 16
  }
  private lastFrameAt = 0
  tick = () => {
    if (!this.running) return
    this.frame = requestAnimationFrame(this.tick)
    this.governResolution(performance.now())
    if (!this.reduced) {
      const now = performance.now()
      const dt = Math.min((now - this.lastFrame) / 1000, 0.1)
      this.time += dt
      this.lastFrame = now
      this.water.material.uniforms.time!.value = this.time
      // Sample the swell across the waterplane; low-pass so the hull responds like a mass.
      this.stepArrival()
      const boat = this.placement?.boat ?? BOATS.trawler!
      const L = boat.lengthM * 0.38
      const B = boat.beamM * 0.4
      const t = this.time
      const s = this.seaState
      const fx = Math.sin(this.heading),
        fz = -Math.cos(this.heading)
      const ox = this.boat.position.x,
        oz = this.boat.position.z
      const at = (along: number, across: number) =>
        seaAt(ox + fx * along - fz * across, oz + fz * along + fx * across, t, s).height
      const bow = at(L, 0),
        stern = at(-L, 0),
        port = at(0, -B),
        starboard = at(0, B),
        mid = at(0, 0)
      const target = {
        heave: (bow + stern + port + starboard + 2 * mid) / 6,
        pitch: Math.atan2(bow - stern, 2 * L),
        roll: Math.atan2(starboard - port, 2 * B) * 0.85,
      }
      // Small hulls answer the sea faster than a 47 m trawler.
      const k = 1 - Math.exp(-dt / (0.25 + boat.lengthM * 0.01))
      for (const key of ['heave', 'pitch', 'roll'] as const)
        this.motion[key] += (target[key] - this.motion[key]) * k
      this.boat.position.y = this.motion.heave
      this.boat.rotation.x = this.motion.pitch
      this.boat.rotation.z = this.motion.roll
      this.boat.updateMatrixWorld()
      const surge = this.bowSurge(this.boat, t, dt)
      this.sound?.update(dt, t, surge, this.gulls.mesh.count, this.gulls.positionOf)
      this.gulls.update(t)
      // Beyond the displaced-swell radius the sea is flat geometry; rock gently in place.
      for (const { ship, phase } of this.distant) {
        ship.position.y = Math.sin(t * 0.7 + phase) * 0.4
        ship.rotation.x = Math.sin(t * 0.55 + phase) * 0.02
        ship.rotation.z = Math.sin(t * 0.8 + phase * 1.7) * 0.035
      }
      for (const { ship, phase } of this.mooredBoats) {
        ship.position.y = Math.sin(t * 0.9 + phase) * 0.06 * (s * 4)
        ship.rotation.z = Math.sin(t * 0.7 + phase * 1.3) * 0.012 * (s * 4)
      }
      // Slow photographic sky drift; the lighting environment rotates with the visible sky.
      // The sun, its light, glitter and flare move with the sky.
      const rotation = this.skyRotation + this.time * 0.0007
      this.scene.backgroundRotation.y = rotation
      this.scene.environmentRotation.y = rotation
    }
    const sky = this.placement ? this.skyFor(this.placement.scenery) : undefined
    // Lights fade on over a couple of seconds; the lighthouse flashes every five.
    const now = performance.now()
    const step = Math.min(0.1, (now - this.lastFade) / 1000)
    this.lastFade = now
    this.duskFade = T.MathUtils.clamp(this.duskFade + (this.dusk ? step / 1.6 : -step / 0.8), 0, 1)
    this.terrain?.setNight(this.duskFade)
    if (this.navLights) {
      ;(this.navLights.material as T.PointsMaterial).opacity = this.duskFade
      this.navLights.visible = this.duskFade > 0.01
    }
    const beacons = this.terrain?.beacons
    if (beacons) {
      const phase = (this.time % 5) / 5
      ;(beacons.material as T.PointsMaterial).opacity =
        this.duskFade * (phase < 0.12 ? Math.sin((phase / 0.12) * Math.PI) : 0.08)
      beacons.visible = this.duskFade > 0.01
    }
    if (sky) {
      skySunDirection(sky.sun, this.scene.backgroundRotation.y, this.sunDirection)
      // Shadows follow the hull (it moves when arriving in harbour).
      this.sunlight.target.position.set(this.boat.position.x, 0, this.boat.position.z)
      this.sunlight.position
        .copy(this.sunDirection)
        .multiplyScalar(150)
        .add(this.sunlight.target.position)
      this.flare.position.copy(this.sunDirection).multiplyScalar(6000)
    }
    if (this.flight) this.stepFlight()
    else this.controls.update()
    this.boat.updateMatrixWorld()
    this.boatInverse.value.copy(this.boat.matrixWorld).invert()
    if (this.smaa || this.zoomBlur.uniforms.strength!.value > 0.002) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }
  /** Presets are relative to the hull's position (it is off the origin while arriving). */
  private get offset() {
    return new T.Vector3(this.boat.position.x, 0, this.boat.position.z)
  }
  preset(name: PresetName) {
    // A preset chosen mid-entrance ends the flight where the viewer asked to be.
    if (this.flight) {
      const f = this.flight
      this.flight = undefined
      this.zoomBlur.uniforms.strength!.value = 0
      this.controls.enabled = true
      f.resolve()
    }
    const p = this.presets[name]
    this.camera.position.copy(p.position).add(this.offset)
    this.controls.target.copy(p.target).add(this.offset)
    this.controls.minDistance = p.minDistance
    this.controls.update()
  }
  reset() {
    this.preset('elevated')
  }
  setSound(enabled: boolean) {
    this.soundEnabled = enabled
    this.sound?.setEnabled(enabled)
  }
  /** Retry starting audio from a user gesture (browser autoplay policy). */
  resumeAudio() {
    this.sound?.resume()
  }
  suspend() {
    // A suspended flight finishes instantly so controls are never left disabled.
    if (this.flight) {
      this.flight.begin = -Infinity
      this.stepFlight()
    }
    this.zoomBlur.uniforms.strength!.value = 0
    this.sound?.setActive(false)
    this.running = false
    cancelAnimationFrame(this.frame)
  }
  update(snapshot: Snapshot) {
    // Wake length and foam flow follow the vessel's reported speed (knots → m/s).
    // Environmental animation uses its own monotonic clock, paused while suspended.
    const vessel = snapshot.vessels.find((v) => v.id === this.vesselId)
    const harbour = this.placement?.scenery.kind === 'harbour'
    if (vessel && !this.arrival)
      this.water.material.uniforms.hullSpeed!.value = harbour ? 0 : vessel.speed * 0.5144
  }
  /** The constructor already set up 'high' (device pixel ratio, shadows). */
  currentQuality?: 'high' | 'low' = 'high'
  quality(value: 'high' | 'low') {
    // Re-applying the same pixel ratio reallocates the canvas and render targets (a visible
    // hitch at every scene entry), so only act on a real change.
    if (value === this.currentQuality) return
    this.currentQuality = value
    this.renderer.setPixelRatio(value === 'high' ? Math.min(devicePixelRatio, 1.5) : 0.65)
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.renderer.shadowMap.enabled = value === 'high'
  }
  resize() {
    const { clientWidth: w, clientHeight: h } = this.element
    const size = `${w}x${h}@${this.renderer.getPixelRatio()}`
    if (!w || !h || size === this.size) return
    this.size = size
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
  }
  release(root: T.Object3D) {
    root.traverse((object) => {
      const mesh = object as T.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      if (mesh.material)
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          for (const value of Object.values(m)) if (value instanceof T.Texture) value.dispose()
          m.dispose()
        }
    })
  }
  dispose() {
    this.disposed = true
    this.suspend()
    this.controls.dispose()
    this.release(this.scene)
    for (const pending of this.boats.values())
      void pending.then((model) => this.release(model)).catch(() => undefined)
    for (const pending of this.terrains.values())
      void pending.then((terrain) => terrain?.dispose()).catch(() => undefined)
    for (const pending of this.skies.values())
      void pending
        .then(({ texture, env }) => {
          texture.dispose()
          env.dispose()
        })
        .catch(() => undefined)
    this.water.material.uniforms.normalSampler?.value?.dispose()
    this.flare.dispose()
    this.composer.dispose()
    this.sound?.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}

/** Densest 200 m cell of real buildings within 4.5 km of the vessel (the town centre). */
function townCentre(terrain: Scenery) {
  const counts = new Map<string, { n: number; x: number; z: number }>()
  for (const b of terrain.meta.features.buildings) {
    let x = 0,
      z = 0
    for (const [px, pz] of b.footprint) {
      x += px
      z += pz
    }
    x /= b.footprint.length
    z /= b.footprint.length
    if (Math.hypot(x, z) > 4500) continue
    const key = `${Math.floor(x / 200)},${Math.floor(z / 200)}`
    const cell = counts.get(key) ?? { n: 0, x: 0, z: 0 }
    cell.n++
    cell.x += x
    cell.z += z
    counts.set(key, cell)
  }
  let best: { n: number; x: number; z: number } | undefined
  for (const cell of counts.values()) if (!best || cell.n > best.n) best = cell
  if (!best || best.n < 12) return undefined
  return new T.Vector3(best.x / best.n, 0, best.z / best.n)
}
