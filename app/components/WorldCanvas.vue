<script setup lang="ts">
import { createDemoProvider, scenes } from '../domain/world'
import type { SceneAdapter } from '../renderers/types'
import type { LocalRenderer } from '../renderers/local'
const world = useWorld()
const router = useRouter()
const globe = ref<HTMLElement>()
const local = ref<HTMLElement>()
const note = ref('')
let geographic: SceneAdapter | undefined
let detailed: LocalRenderer | undefined
let observer: ResizeObserver
let stop: () => void
let generation = 0
let disposed = false
let ready: Promise<void> | undefined
let localReady: Promise<void> | undefined
let localLoaded = false
let globeLoaded = false
/** Create and load the vessel scene once; shared by navigation and background preload. */
function ensureLocal() {
  if (!localReady)
    localReady = (async () => {
      const { LocalRenderer } = await import('../renderers/local')
      if (disposed) return
      detailed = new LocalRenderer(local.value!, scenes.vessel)
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
      .catch(() => {
        // Leave the error for an explicit visit; discard the partial renderer.
        detailed?.dispose()
        detailed = undefined
        localReady = undefined
      })
  }
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 })
  else setTimeout(start, 1500)
}
async function switchView() {
  const epoch = ++generation
  const three = scenes[world.view].renderer === 'three'
  // No spinner when the target scene is already built: the switch is immediate.
  world.loading = three ? !localLoaded : !globeLoaded
  world.error = ''
  try {
    geographic?.suspend()
    detailed?.suspend()
    if (three) {
      await ensureLocal()
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
            navigate: (view) => {
              void router.push({ query: { view } })
            },
            selectVessel: (id) => world.selectVessel(id),
            selectRegion: (id) => {
              world.selectedRegion = id
            },
            status: (message) => {
              note.value = message
            },
          })
          await (geographic as InstanceType<typeof GeographicRenderer>).initialize()
          globeLoaded = true
        })()
      await ready
      if (epoch !== generation || disposed) return
      await geographic!.activate(world.view, world.reducedMotion)
      if (epoch !== generation) return
      geographic!.update(world.snapshot)
      geographic!.resize()
      geographic!.quality(world.quality)
      if (epoch === generation) preloadLocal()
    }
  } catch (error) {
    if (epoch === generation)
      world.error = `Scene could not load: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (epoch === generation) world.loading = false
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
function preset(name: 'elevated' | 'water' | 'deck') {
  detailed?.preset(name)
}
function resumeAudio() {
  detailed?.resumeAudio()
}
onMounted(() => {
  world.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  try {
    world.sound = localStorage.getItem('pelagic.sound') !== 'off'
  } catch {
    // Storage unavailable: keep the default.
  }
  window.addEventListener('pointerdown', resumeAudio)
  window.addEventListener('keydown', resumeAudio)
  stop = createDemoProvider().subscribe((snapshot) => {
    world.accept(snapshot)
    if (world.view === 'vessel') detailed?.update(snapshot)
    else geographic?.update(snapshot)
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
      localStorage.setItem('pelagic.sound', enabled ? 'on' : 'off')
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
  geographic?.dispose()
  detailed?.dispose()
})
</script>
<template>
  <div class="world-stage">
    <div
      ref="globe"
      class="render-surface"
      :class="{ hidden: world.view === 'vessel' }"
      aria-label="Interactive geographic view"
    />
    <div
      ref="local"
      class="render-surface"
      :class="{ hidden: world.view !== 'vessel' }"
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
    <div v-if="note && world.view !== 'vessel'" class="source-note">{{ note }}</div>
    <div class="camera-tools">
      <button @click="world.view === 'vessel' ? detailed?.reset() : geographic?.reset()">
        Reset camera</button
      ><template v-if="world.view === 'vessel'"
        ><button @click="preset('elevated')">Elevated view</button
        ><button @click="preset('water')">Water level</button
        ><button @click="preset('deck')">Working deck</button></template
      >
    </div>
  </div>
</template>
