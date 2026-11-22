<script setup lang="ts">
import { loadDemoProvider, scenes, type ViewId } from '../domain/world'
import { sceneryForVessel } from '../domain/scenery'
import type { HailEvent } from '../domain/simulation'
import { STATUS_COLOUR } from '../domain/palette'
import type { GeographicRenderer } from '../renderers/geographic'
import type { LocalRenderer } from '../renderers/local'
const world = useWorld()
const router = useRouter()
const globe = ref<HTMLElement>()
const local = ref<HTMLElement>()
const note = ref('')
let geographic: GeographicRenderer | undefined
let detailed: LocalRenderer | undefined
let observer: ResizeObserver
let stop: () => void
let generation = 0
let disposed = false
let ready: Promise<void> | undefined
let localReady: Promise<void> | undefined
let localLoaded = false
let globeLoaded = false
/** Resolves with the first fleet snapshot (a vessel's scene depends on its status). */
let fleetReady: () => void
const firstSnapshot = new Promise<void>((resolve) => (fleetReady = resolve))
/** Create and load the vessel scene once; shared by navigation and background preload. */
function ensureLocal() {
  if (!localReady)
    localReady = (async () => {
      const { LocalRenderer } = await import('../renderers/local')
      if (disposed) return
      detailed = new LocalRenderer(local.value!)
      detailed.dusk = world.dusk
      await detailed.initialize()
      localLoaded = true
    })()
  return localReady
}
/**
 * Build the vessel scene in the background once the globe is up, so opening a vessel is
 * instant: assets load, shaders compile and textures upload while the map is in use.
 * Skipped when the browser asks to save data. A failure here is retried on navigation.
 */
function preloadLocal() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  if (localReady || connection?.saveData) return
  const start = () => {
    if (disposed || localReady) return
    ensureLocal()
      .then(() => (world.view === 'vessel' ? undefined : detailed?.warmUp()))
      .then(() => detailed?.prefetchDusk())
      // Then the coast boundary layers, one background job at a time.
      .then(() => geographic?.preloadLayers())
      .catch(() => {
        // Leave the error for an explicit visit; discard the partial renderer.
        detailed?.dispose()
        detailed = undefined
        localReady = undefined
      })
  }
  // After the opening flight has landed: loading shaders and textures during it stutters.
  const idle = () =>
    'requestIdleCallback' in window ? requestIdleCallback(start, { timeout: 2000 }) : start()
  setTimeout(idle, 4200)
}
/**
 * Map → vessel zoom: the globe dives onto the vessel with a building radial blur, the
 * vessel scene takes over at peak blur from high overhead and swoops down as it clears.
 * Panels slide out for the move and back in once the camera settles (CSS, `transition`).
 * The dive also covers any remaining load time of the vessel scene.
 */
async function diveToVessel(epoch: number) {
  const target = world.vessel
  const anchor = target ?? scenes[world.view].anchor
  world.transition = 'dive'
  const vessel = world.vessel
  // Load and compile the vessel's scene while the dive plays (it is hidden until the cut).
  const loading = ensureLocal()
    .then(() => detailed!.prepare(vessel))
    .then(() => detailed!.warmUp())
  await geographic!.dive(anchor)
  if (epoch !== generation || disposed) return
  if (!localLoaded) world.loading = true // hold at peak blur until the scene is ready
  await loading
  world.loading = false
  if (epoch !== generation || disposed) return
  geographic!.suspend()
  detailed!.setSound(world.sound)
  const setting = vessel ? sceneryForVessel(vessel) : undefined
  const long = !!setting?.tour && detailed!.arrivalDuration() > 6
  world.tour = setting?.caption ? { ...setting.caption, long } : null
  const arrival = detailed!.arrive()
  world.displayView = world.view
  world.transition = 'arrive'
  await detailed!.activate(world.view, world.reducedMotion)
  detailed!.resize()
  detailed!.quality(world.quality)
  // Quick entrance: panels return once the blur has cleared while the flight carries on.
  // Town flyover: the screen stays cinematic (letterbox, caption) until it lands.
  if (long) await arrival
  else await Promise.race([arrival, new Promise((r) => setTimeout(r, 2600))])
  world.tour = null
}
/**
 * Vessel → map zoom, the dive in reverse: the vessel camera lifts to high overhead as the
 * blur builds, the globe takes over low over the vessel and pulls out to the camera the
 * map view had before the dive while the blur clears.
 */
async function riseToMap(epoch: number) {
  const vessel = world.vessel
  const anchor = vessel ?? scenes[world.displayView].anchor
  world.transition = 'depart'
  await detailed!.depart()
  if (epoch !== generation || disposed) return
  detailed!.suspend()
  const rising = geographic!.rise(anchor, world.view)
  world.displayView = world.view
  world.transition = 'rise'
  await geographic!.activate(world.view, world.reducedMotion, true)
  if (epoch !== generation) return
  geographic!.update(world.snapshot)
  geographic!.resize()
  geographic!.quality(world.quality)
  await rising
}
/** Overview ⇄ coast: one continuous blurred camera move on the globe; panels swap mid-way. */
async function swoopTo(epoch: number) {
  world.transition = 'swoop'
  geographic!.release()
  const moving = geographic!.swoop(world.view)
  const view = world.view
  setTimeout(() => {
    if (epoch === generation) world.displayView = view
  }, 450)
  await geographic!.activate(view, world.reducedMotion, true)
  if (epoch !== generation) return
  geographic!.update(world.snapshot)
  await moving
  world.displayView = view
}
async function switchView() {
  const epoch = ++generation
  const three = scenes[world.view].renderer === 'three'
  const fromMap = scenes[world.displayView].renderer === 'cesium'
  world.error = ''
  try {
    if (three && fromMap && globeLoaded && !world.reducedMotion) {
      detailed?.suspend()
      await diveToVessel(epoch)
      return
    }
    if (!three && !fromMap && globeLoaded && detailed && !world.reducedMotion) {
      await riseToMap(epoch)
      return
    }
    if (
      !three &&
      fromMap &&
      globeLoaded &&
      !world.reducedMotion &&
      world.displayView !== world.view
    ) {
      await swoopTo(epoch)
      return
    }
    // No spinner when the target scene is already built: the switch is immediate.
    world.loading = three ? !localLoaded : !globeLoaded
    world.displayView = world.view
    geographic?.suspend()
    detailed?.suspend()
    if (three) {
      await Promise.all([ensureLocal(), firstSnapshot])
      if (epoch !== generation || disposed) return
      await detailed!.prepare(world.vessel)
      if (epoch !== generation || disposed) return
      detailed!.setSound(world.sound)
      await detailed!.activate(world.view, world.reducedMotion)
      detailed!.resize()
      detailed!.quality(world.quality)
    } else {
      if (!ready)
        ready = (async () => {
          const { GeographicRenderer } = await import('../renderers/geographic')
          if (disposed) return
          geographic = new GeographicRenderer(globe.value!, {
            navigate: (view: ViewId) => {
              void router.push({ query: { view } })
            },
            selectVessel: (id) => world.selectVessel(id),
            exploreVessel: (id) => {
              world.selectVessel(id)
              void router.push({ query: { view: 'vessel', vessel: id } })
            },
            selectRegion: (id) => {
              world.selectedRegion = id
            },
            status: (message) => {
              note.value = message
            },
          })
          geographic.dusk = world.dusk
          await geographic.initialize()
          globeLoaded = true
          if (import.meta.dev || location.search.includes('debug'))
            Object.assign(window, { __geographic: geographic })
        })()
      await ready
      if (epoch !== generation || disposed) return
      await geographic!.activate(world.view, world.reducedMotion)
      if (epoch !== generation) return
      geographic!.select(world.selectedVessel)
      geographic!.update(world.snapshot)
      geographic!.resize()
      geographic!.quality(world.quality)
      if (epoch === generation) preloadLocal()
    }
  } catch (error) {
    if (epoch === generation)
      world.error = `Scene could not load: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (epoch === generation) {
      world.loading = false
      world.transition = ''
    }
  }
}
function retry() {
  if (world.view === 'vessel') {
    detailed?.dispose()
    detailed = undefined
    localReady = undefined
    localLoaded = false
  } else {
    geographic?.dispose()
    geographic = undefined
    ready = undefined
    globeLoaded = false
  }
  void switchView()
}
/**
 * Hail alerts on the map: every ~9 s a fresh hail (on the coast in view) pops up, its
 * vessel pings on the map, and one click flies there or boards it.
 */
const alert = ref<HailEvent | null>(null)
let lastAlert = 0
let alertTimer: ReturnType<typeof setTimeout> | undefined
function considerAlert() {
  const view = world.displayView
  if (view === 'vessel' || world.transition || world.loading) return
  if (performance.now() - lastAlert < 9000) return
  const fresh = world.snapshot.feed.filter(
    (e) => world.snapshot.time - e.time < 3 && (view === 'canada' || e.coast === view),
  )
  // Prefer a good landing coming in; otherwise whatever just hailed.
  const pick =
    fresh.find((e) => e.kind === 'in' && e.estimateKg >= 3000) ??
    fresh.find((e) => e.kind === 'out')
  if (!pick) return
  lastAlert = performance.now()
  alert.value = pick
  geographic?.fleet.ping(
    pick.vesselId,
    pick.kind === 'out' ? STATUS_COLOUR.outbound : STATUS_COLOUR.inbound,
  )
  clearTimeout(alertTimer)
  alertTimer = setTimeout(() => (alert.value = null), 7000)
}
function showAlert() {
  if (!alert.value) return
  world.focusVessel(alert.value.vesselId)
  alert.value = null
}
function boardAlert() {
  if (!alert.value) return
  const id = alert.value.vesselId
  alert.value = null
  world.selectVessel(id)
  void router.push({ query: { view: 'vessel', vessel: id } })
}
const alertTonnes = (kg: number) =>
  kg >= 1000 ? `${(kg / 1000).toFixed(1)} t` : `${kg.toLocaleString('en-CA')} kg`
function preset(name: 'elevated' | 'water' | 'deck') {
  detailed?.preset(name)
}
function resumeAudio() {
  detailed?.resumeAudio()
}
onMounted(() => {
  // Diagnostics only (dev server, or ?debug): renderer handles for profiling.
  if (import.meta.dev || location.search.includes('debug'))
    Object.assign(window, { __local: () => detailed })
  world.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  try {
    world.sound = localStorage.getItem('neritic.sound') !== 'off'
  } catch {
    // Storage unavailable: keep the default.
  }
  window.addEventListener('pointerdown', resumeAudio)
  window.addEventListener('keydown', resumeAudio)
  void loadDemoProvider()
    .then((provider) => {
      if (disposed) return
      world.simulation = markRaw(provider.simulation)
      stop = provider.subscribe((snapshot) => {
        world.accept(snapshot)
        fleetReady()
        considerAlert()
        if (world.displayView === 'vessel') detailed?.update(snapshot)
        else geographic?.update(snapshot)
      })
    })
    .catch((error) => {
      world.error = `Fleet data could not load: ${error instanceof Error ? error.message : String(error)}`
    })
  observer = new ResizeObserver(() => {
    geographic?.resize()
    detailed?.resize()
  })
  observer.observe(globe.value!)
  observer.observe(local.value!)
  void switchView()
})
watch(
  () => world.view,
  () => void switchView(),
)
watch(
  () => world.focus.n,
  () => geographic?.focusVessel(world.focus.id),
)
watch(
  () => world.selectedVessel,
  (id) => {
    geographic?.select(id)
    // Fetch the selected vessel's close-up scene now, so boarding it is instant.
    // Loaded and compiled in the hidden scene, so the dive cuts straight to a ready frame.
    if (localLoaded && world.view !== 'vessel' && world.vessel && !world.transition)
      void detailed
        ?.prepare(world.vessel)
        .then(() => (world.view === 'vessel' ? undefined : detailed?.warmUp()))
        .catch(() => undefined)
  },
  { immediate: true },
)
watch(
  () => world.dusk,
  (on) => {
    void detailed?.setDusk(on)
    geographic?.setDusk(on)
  },
)
watch(
  () => world.quality,
  (value) => {
    geographic?.quality(value)
    detailed?.quality(value)
  },
)
watch(
  () => world.sound,
  (enabled) => {
    detailed?.setSound(enabled)
    try {
      localStorage.setItem('neritic.sound', enabled ? 'on' : 'off')
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  },
)
watch(
  () => world.reducedMotion,
  () => {
    if (detailed && world.view === 'vessel') {
      detailed.suspend()
      void detailed.activate('vessel', world.reducedMotion)
    }
  },
)
onBeforeUnmount(() => {
  disposed = true
  generation++
  stop?.()
  observer?.disconnect()
  window.removeEventListener('pointerdown', resumeAudio)
  window.removeEventListener('keydown', resumeAudio)
  clearTimeout(alertTimer)
  geographic?.dispose()
  detailed?.dispose()
})
</script>
<template>
  <div class="world-stage">
    <div
      ref="globe"
      class="render-surface"
      :class="{ hidden: world.displayView === 'vessel' }"
      aria-label="Interactive geographic view"
    />
    <div
      ref="local"
      class="render-surface"
      :class="{ hidden: world.displayView !== 'vessel' }"
      aria-label="Interactive fishing vessel scene"
    />
    <div v-if="world.loading" class="loading" role="status">
      <span class="spinner" />Preparing your view
    </div>
    <div v-if="world.error" class="scene-error" role="alert">
      <strong>We couldn’t open this view.</strong>
      <p>{{ world.error }}</p>
      <button @click="retry">Try again</button>
    </div>
    <div v-if="note && world.displayView !== 'vessel'" class="source-note">{{ note }}</div>
    <Transition name="alert">
      <div v-if="alert && world.displayView !== 'vessel'" class="hail-alert" role="status">
        <span class="hail" :class="alert.kind">{{
          alert.kind === 'out' ? '↗ HAIL OUT' : '↙ HAIL IN'
        }}</span>
        <div>
          <strong>{{ alert.name }}</strong>
          <small v-if="alert.kind === 'out'"
            >{{ alert.port }} → {{ alert.area }} · {{ alert.species }}</small
          >
          <small v-else
            >{{ alert.area }} → {{ alert.port }} · est. {{ alertTonnes(alert.estimateKg) }}
            {{ alert.species.toLowerCase() }}</small
          >
        </div>
        <button @click="showAlert">Show</button>
        <button class="board" @click="boardAlert">Board ›</button>
      </div>
    </Transition>
    <div class="letterbox" :class="{ on: world.transition === 'arrive' && world.tour?.long }">
      <i /><i />
    </div>
    <Transition name="caption">
      <div v-if="world.tour && world.transition === 'arrive'" class="scene-caption">
        <span>REAL TERRAIN · OPENSTREETMAP</span>
        <strong>{{ world.tour.title }}</strong>
        <small>{{ world.tour.line }}</small>
      </div>
    </Transition>
    <button
      v-if="world.tour?.long && world.transition === 'arrive'"
      class="skip-intro"
      @click="detailed?.skipFlight()"
    >
      Skip ›
    </button>
    <div v-if="world.displayView === 'vessel'" class="camera-tools">
      <button @click="detailed?.reset()">Reset camera</button
      ><button @click="preset('elevated')">Elevated view</button
      ><button @click="preset('water')">Water level</button
      ><button @click="preset('deck')">Working deck</button>
    </div>
  </div>
</template>
