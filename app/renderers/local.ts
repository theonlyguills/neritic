import * as T from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { Water } from 'three/addons/objects/Water.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { seaAt } from './sea'
import { createBowSurge, createOcean } from './ocean'
import { weatherMaterial } from './weathering'
import { createGulls } from './seabirds'
import { createLensflare, skyRotationFor, skySunDirection } from './sun'
import { Soundscape, type SoundSamples } from './soundscape'

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
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { outfitWorkingDeck } from './working-deck'
import type { Snapshot, ViewId, SceneDefinition } from '../domain/world'
import type { SceneAdapter } from './types'
export class LocalRenderer implements SceneAdapter {
  renderer: T.WebGLRenderer
  scene = new T.Scene()
  camera = new T.PerspectiveCamera(43, 1, 0.5, 20000)
  controls: OrbitControls
  boat = new T.Group()
  water: Water
  skyTexture?: T.DataTexture
  sunlight: T.DirectionalLight
  frame = 0
  running = false
  reduced = false
  time = 0
  lastFrame = 0
  disposed = false
  /** Low-passed heave, pitch and roll: a 47 m hull does not follow every crest. */
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
    blur: (t: number) => number
    finish: () => void
    resolve: () => void
  }
  gulls = createGulls(18, new T.Vector2(0, 30))
  bowSurge: ReturnType<typeof createBowSurge>
  /** Other vessels working the same ground, hull-down towards the horizon. */
  distant: { ship: T.Object3D; x: number; z: number; phase: number }[] = []
  environment?: T.WebGLRenderTarget
  constructor(
    private element: HTMLElement,
    private definition: SceneDefinition,
  ) {
    if (!definition.local) throw new Error('Local scene configuration is missing')
    this.renderer = new T.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
    this.renderer.toneMapping = T.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.85
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = T.PCFSoftShadowMap
    this.renderer.outputColorSpace = T.SRGBColorSpace
    element.appendChild(this.renderer.domElement)
    this.camera.position.set(...definition.local.cameras.elevated)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 5, 0)
    this.controls.enableDamping = true
    this.controls.minDistance = 8
    this.controls.maxDistance = 130
    this.controls.maxPolarAngle = Math.PI / 2 - 0.035
    this.controls.enablePan = false
    this.scene.add(new T.HemisphereLight(0xc1d4df, 0x223138, 0.35))
    // Low sun: warm, raking light aligned with the sun disk in the HDR sky.
    const sky = definition.local.sky
    this.skyRotation = skyRotationFor(sky.sun, T.MathUtils.degToRad(sky.sunAzimuth))
    skySunDirection(sky.sun, this.skyRotation, this.sunDirection)
    this.sunlight = new T.DirectionalLight(0xffdcae, 2.2)
    this.sunlight.position.copy(this.sunDirection).multiplyScalar(150)
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
    this.scene.add(this.sunlight)
    this.flare.position.copy(this.sunDirection).multiplyScalar(6000)
    this.scene.add(this.flare)
    this.scene.background = new T.Color('#97b2c3')
    // Marine haze: distant hulls and the horizon soften into the sky.
    this.scene.fog = new T.FogExp2('#b3b8b9', 0.0003)
    const normals = new T.TextureLoader().load('/assets/waternormals.jpg', (t) => {
      t.wrapS = t.wrapT = T.RepeatWrapping
    })
    this.water = createOcean(normals, this.sunDirection, {
      halfLength: definition.local.lengthMetres * 0.45,
      halfBeam: definition.local.beamMetres / 2,
      speed: 0,
    })
    this.water.receiveShadow = true
    this.scene.add(this.water)
    this.scene.add(this.boat)
    this.scene.add(this.gulls.mesh)
    this.bowSurge = createBowSurge(
      this.water,
      new T.Vector3(0, 0, -definition.local.lengthMetres * 0.45),
    )
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
  arrive(duration = 1.5) {
    const local = this.definition.local!
    const target = new T.Vector3(...local.targets.elevated)
    return this.fly({
      duration,
      target,
      from: this.overhead(),
      to: new T.Spherical().setFromVector3(new T.Vector3(...local.cameras.elevated).sub(target)),
      ease: (t) => 1 - Math.pow(1 - t, 3), // fast in, settling out
      blur: (t) => 1 - T.MathUtils.smoothstep(t, 0, 0.5),
      finish: () => this.preset('elevated'),
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
    const radius = Math.exp(T.MathUtils.lerp(Math.log(f.from.radius), Math.log(f.to.radius), e))
    const phi = T.MathUtils.lerp(f.from.phi, f.to.phi, f.to.phi > f.from.phi ? Math.pow(e, 1.4) : e)
    const theta = T.MathUtils.lerp(f.from.theta, f.to.theta, e)
    this.camera.position.setFromSpherical(new T.Spherical(radius, phi, theta)).add(f.target)
    this.camera.lookAt(f.target)
    this.zoomBlur.uniforms.strength!.value = f.blur(t)
    if (t < 1) return
    this.flight = undefined
    f.finish()
    this.controls.enabled = true
    f.resolve()
  }
  async initialize() {
    // Load independently, but settle all requests before cleanup on a partial failure.
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    const loaded = await Promise.allSettled([
      loader.loadAsync(this.definition.local!.modelUrl),
      loader.loadAsync(this.definition.local!.crewUrl),
      new RGBELoader().loadAsync(this.definition.local!.sky.url),
    ])
    if (this.disposed || loaded.some((result) => result.status === 'rejected')) {
      for (const result of loaded)
        if (result.status === 'fulfilled') {
          if ('scene' in result.value) this.release(result.value.scene)
          else result.value.dispose()
        }
      if (!this.disposed)
        throw new Error('The trawler, crew or sky asset could not be loaded. Please retry.')
      return
    }
    const [boatResult, crewResult, skyResult] = loaded
    if (
      boatResult!.status !== 'fulfilled' ||
      crewResult!.status !== 'fulfilled' ||
      skyResult!.status !== 'fulfilled'
    )
      return
    const model = boatResult.value.scene
    this.skyTexture = skyResult.value
    this.skyTexture.mapping = T.EquirectangularReflectionMapping
    this.scene.background = this.skyTexture
    this.scene.backgroundIntensity = 0.62
    this.scene.backgroundRotation.y = this.skyRotation
    this.scene.environmentRotation.y = this.skyRotation
    const pmrem = new T.PMREMGenerator(this.renderer)
    this.environment = pmrem.fromEquirectangular(this.skyTexture)
    this.scene.environment = this.environment.texture
    this.scene.environmentIntensity = 0.65
    pmrem.dispose()
    // Procedural wear on the vessel's own paint (not the crew); AO is baked into COLOR_0.
    model.traverse((object) => {
      const mesh = object as T.Mesh
      if (!mesh.isMesh) return
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        weatherMaterial(material, this.boatInverse)
    })
    outfitWorkingDeck(model, crewResult.value.scene)
    // Asset coordinates are metres, bow +Z. Rotate to bow -Z / wake +Z.
    model.rotation.y = Math.PI
    const box = new T.Box3().setFromObject(model)
    const size = box.getSize(new T.Vector3())
    model.scale.setScalar(this.definition.local!.lengthMetres / Math.max(size.x, size.z))
    const scaled = new T.Box3().setFromObject(model)
    const center = scaled.getCenter(new T.Vector3())
    model.position.set(-center.x, -scaled.min.y - this.definition.local!.waterlineOffset, -center.z)
    model.traverse((object) => {
      const mesh = object as T.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
    this.boat.add(model)
    // Horizon vessels load after the scene is shown; they are optional dressing.
    const farUrl = this.definition.local!.farModelUrl
    if (farUrl) void this.loadDistant(loader, farUrl, model)
    // Geometry/textures are shared by the crew clones; dispose unused original materials only.
    const used = new Set<T.Material>()
    model.traverse((object) => {
      const m = (object as T.Mesh).material
      if (m) for (const mat of Array.isArray(m) ? m : [m]) used.add(mat)
    })
    crewResult.value.scene.traverse((object) => {
      const m = (object as T.Mesh).material
      if (m) for (const mat of Array.isArray(m) ? m : [m]) if (!used.has(mat)) mat.dispose()
    })
  }

  /** Other vessels on the same ground: a low-detail copy of the hull (~24k triangles). */
  async loadDistant(loader: GLTFLoader, url: string, reference: T.Object3D) {
    const far = await loader.loadAsync(url).catch(() => undefined)
    if (!far) return
    if (this.disposed) return this.release(far.scene)
    // Same source frame as the detailed hull: reuse its rotation, scale and waterline offset.
    far.scene.rotation.copy(reference.rotation)
    far.scene.scale.copy(reference.scale)
    far.scene.position.copy(reference.position)
    for (const [x, z, heading, phase] of [
      [-1150, -1650, 0.9, 0],
      [-3400, -700, -0.4, 2.1],
      [500, -3900, 2.6, 4.2],
    ]) {
      const ship = new T.Group()
      ship.add(far.scene.clone(true))
      ship.position.set(x!, 0, z!)
      ship.rotation.y = heading!
      this.scene.add(ship)
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
    this.resize()
    this.boat.updateMatrixWorld()
    this.boatInverse.value.copy(this.boat.matrixWorld).invert()
    await this.renderer.compileAsync(this.scene, this.camera)
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
    const local = this.definition.local!
    this.sound ??= new Soundscape(
      this.camera,
      this.boat,
      this.scene,
      { length: local.lengthMetres, deckY: local.deckHeight },
      SOUND_SAMPLES,
    )
    return this.sound
  }
  async activate(_view: ViewId, reduced: boolean) {
    this.reduced = reduced
    const sound = this.createSound()
    sound.setEnabled(this.soundEnabled)
    sound.setActive(true)
    this.running = true
    this.lastFrame = performance.now()
    this.tick()
  }
  tick = () => {
    if (!this.running) return
    this.frame = requestAnimationFrame(this.tick)
    if (!this.reduced) {
      const now = performance.now()
      const dt = Math.min((now - this.lastFrame) / 1000, 0.1)
      this.time += dt
      this.lastFrame = now
      this.water.material.uniforms.time!.value = this.time
      // Sample the swell across the waterplane; low-pass so the hull responds like a mass.
      const L = this.definition.local!.lengthMetres * 0.38
      const B = this.definition.local!.beamMetres * 0.4
      const t = this.time
      const bow = seaAt(0, -L, t).height,
        stern = seaAt(0, L, t).height,
        port = seaAt(-B, 0, t).height,
        starboard = seaAt(B, 0, t).height,
        mid = seaAt(0, 0, t).height
      const target = {
        heave: (bow + stern + port + starboard + 2 * mid) / 6,
        pitch: Math.atan2(bow - stern, 2 * L),
        roll: Math.atan2(starboard - port, 2 * B) * 0.85,
      }
      const k = 1 - Math.exp(-dt / 0.7)
      for (const key of ['heave', 'pitch', 'roll'] as const)
        this.motion[key] += (target[key] - this.motion[key]) * k
      this.boat.position.y = this.motion.heave
      this.boat.rotation.x = this.motion.pitch
      this.boat.rotation.z = this.motion.roll
      this.boat.updateMatrixWorld()
      const surge = this.bowSurge(this.boat, t, dt)
      this.sound?.update(dt, t, surge, this.gulls.count, this.gulls.positionOf)
      this.gulls.update(t)
      // Beyond the displaced-swell radius the sea is flat geometry; rock gently in place.
      for (const { ship, phase } of this.distant) {
        ship.position.y = Math.sin(t * 0.7 + phase) * 0.4
        ship.rotation.x = Math.sin(t * 0.55 + phase) * 0.02
        ship.rotation.z = Math.sin(t * 0.8 + phase * 1.7) * 0.035
      }
      // Slow photographic sky drift; the lighting environment rotates with the visible sky.
      // The sun, its light, glitter and flare move with the sky.
      const rotation = this.skyRotation + this.time * 0.0007
      this.scene.backgroundRotation.y = rotation
      this.scene.environmentRotation.y = rotation
      skySunDirection(this.definition.local!.sky.sun, rotation, this.sunDirection)
      this.sunlight.position.copy(this.sunDirection).multiplyScalar(150)
      this.flare.position.copy(this.sunDirection).multiplyScalar(6000)
    }
    if (this.flight) this.stepFlight()
    else this.controls.update()
    this.boat.updateMatrixWorld()
    this.boatInverse.value.copy(this.boat.matrixWorld).invert()
    if (this.smaa || this.zoomBlur.uniforms.strength!.value > 0.002) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }
  preset(name: 'elevated' | 'water' | 'deck') {
    this.camera.position.set(...this.definition.local!.cameras[name])
    this.controls.target.set(...this.definition.local!.targets[name])
    this.controls.minDistance = name === 'deck' ? 4 : 20
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
    const vessel = snapshot.vessels.find((v) => v.localScene === this.definition.id)
    if (vessel) this.water.material.uniforms.hullSpeed!.value = vessel.speed * 0.5144
  }
  currentQuality?: 'high' | 'low'
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
    if (!w || !h) return
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
    this.water.material.uniforms.normalSampler?.value?.dispose()
    this.flare.dispose()
    this.composer.dispose()
    this.sound?.dispose()
    this.environment?.dispose()
    this.skyTexture?.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}
