<script setup lang="ts">
import { scenes, validView, type ViewId } from '../domain/world'
const world = useWorld()
const route = useRoute()
const router = useRouter()
const credits = ref<HTMLDialogElement>()
const scene = computed(() => scenes[world.displayView])
const vessels = computed(() =>
  world.snapshot.vessels.filter(
    (v) =>
      world.displayView === 'canada' ||
      v.coast === (world.displayView === 'vessel' ? 'atlantic' : world.displayView),
  ),
)
watch(
  () => route.query.view,
  (value) => {
    world.view = validView(value)
    world.selectedRegion = ''
  },
  { immediate: true },
)
function go(view: ViewId) {
  void router.push({ query: { view } })
}
const level = computed(() =>
  world.displayView === 'canada' ? '01' : world.displayView === 'vessel' ? '03' : '02',
)
</script>
<template>
  <div class="app-shell" :class="{ 'ui-away': world.transition }">
    <header class="topbar">
      <a class="brand" href="?view=canada" @click.prevent="go('canada')"
        ><span class="brand-mark">≋</span><span>PELAGIC<small>MARINE OPERATIONS</small></span></a
      >
      <nav aria-label="Coast navigation">
        <button :class="{ active: world.view === 'canada' }" @click="go('canada')">Overview</button
        ><button :class="{ active: world.view === 'atlantic' }" @click="go('atlantic')">
          Atlantic</button
        ><button :class="{ active: world.view === 'pacific' }" @click="go('pacific')">
          Pacific
        </button>
      </nav>
      <span class="demo-tag"><i /> DEMONSTRATION</span>
    </header>
    <main>
      <WorldCanvas />
      <section class="view-heading">
        <div class="eyebrow">
          CANADIAN WATERS <span>/</span> {{ level }} —
          {{
            world.displayView === 'canada'
              ? 'OVERVIEW'
              : world.displayView === 'vessel'
                ? 'ON THE WATER'
                : 'REGIONAL VIEW'
          }}
        </div>
        <h1>{{ scene.title }}</h1>
        <p>{{ scene.subtitle }}</p>
        <button
          v-if="world.displayView !== 'canada'"
          class="back"
          @click="go(world.displayView === 'vessel' ? 'atlantic' : 'canada')"
        >
          ← {{ world.displayView === 'vessel' ? 'Return to Atlantic' : 'Canada overview' }}
        </button>
      </section>
      <aside class="inspector" aria-label="Activity details">
        <div class="panel-heading">
          <span class="eyebrow">{{
            world.displayView === 'vessel' ? 'VESSEL PROFILE' : 'OPERATING PICTURE'
          }}</span
          ><span class="live-dot" />
        </div>
        <template v-if="world.displayView === 'canada'"
          ><h2>Across the coasts</h2>
          <p class="muted">Explore regional activity, then get closer to life on the water.</p>
          <button class="coast-card" @click="go('atlantic')">
            <span
              >01 <strong>Atlantic</strong><small>Northwest Atlantic · NAFO divisions</small></span
            ><b>↗</b></button
          ><button class="coast-card" @click="go('pacific')">
            <span
              >02 <strong>Pacific</strong><small>British Columbia · Management areas</small></span
            ><b>↗</b>
          </button>
          <div class="stats">
            <div><strong>2</strong><span>OCEANS</span></div>
            <div><strong>7</strong><span>DEMO VESSELS</span></div>
          </div></template
        >
        <template v-else-if="world.displayView === 'vessel'"
          ><h2>Northern Light</h2>
          <p class="muted">Commercial stern trawler · Grand Banks</p>
          <div class="profile-art">↗ <span>NL–01</span></div>
          <div class="stats">
            <div>
              <strong>7.2<em> kn</em></strong
              ><span>DEMO SPEED</span>
            </div>
            <div>
              <strong>062<em>°</em></strong
              ><span>DEMO HEADING</span>
            </div>
          </div>
          <dl>
            <dt>Region</dt>
            <dd>NAFO 3L</dd>
            <dt>Scene anchor</dt>
            <dd>46° N / 50° W</dd>
            <dt>Vessel / crew</dt>
            <dd>47.5 m · 3 on deck</dd>
            <dt>Sea state</dt>
            <dd>Illustrative, moderate</dd>
          </dl>
          <p class="muted small">
            Drag to orbit. Scroll to move closer. The model and weather illustrate the experience;
            they are not a vessel record or forecast.
          </p></template
        >
        <template v-else
          ><h2>{{ world.selectedRegion || 'Regional activity' }}</h2>
          <p class="muted">Select a boundary on the map or a vessel below.</p>
          <div class="vessel-list">
            <button
              v-for="v in vessels"
              :key="v.id"
              :class="{ selected: world.selectedVessel === v.id }"
              @click="world.selectVessel(v.id)"
            >
              <span class="vessel-symbol">▰</span
              ><span
                ><strong>{{ v.name }}</strong
                ><small>{{ v.region }} · {{ v.speed }} kn</small></span
              ><span>↗</span>
            </button>
          </div>
          <template v-if="world.vessel?.coast === world.displayView"
            ><div class="selection-info">
              <span class="eyebrow">SELECTED VESSEL</span>
              <h3>{{ world.vessel.name }}</h3>
              <p class="muted small">
                {{ world.vessel.position.latitude.toFixed(3) }}° N ·
                {{ Math.abs(world.vessel.position.longitude).toFixed(3) }}° W
              </p>
            </div>
            <button v-if="world.vessel.localScene" class="primary" @click="go('vessel')">
              Explore vessel <span>→</span>
            </button>
            <p v-else class="muted small">
              Regional tracking view. The first detailed scene is Northern Light in the Atlantic.
            </p></template
          ></template
        >
        <div class="panel-foot">SYNTHETIC ACTIVITY <span>●</span> REAL GEOGRAPHY</div>
      </aside>
      <div class="bottom-tools">
        <span class="map-hint">{{
          world.displayView === 'vessel'
            ? 'DRAG TO ORBIT · SCROLL TO ZOOM'
            : 'DRAG TO PAN · SCROLL TO ZOOM · CLICK TO SELECT'
        }}</span>
        <div>
          <label
            >Detail
            <select v-model="world.quality">
              <option value="high">High</option>
              <option value="low">Reduced</option>
            </select></label
          ><label class="motion-label"
            ><input v-model="world.reducedMotion" type="checkbox" /> Reduce motion</label
          ><label v-if="world.displayView === 'vessel'" class="motion-label"
            ><input v-model="world.sound" type="checkbox" /> Sound</label
          ><button @click="credits?.showModal()">Sources ↗</button>
        </div>
      </div>
    </main>
    <footer>
      <span>OCEAN PERSPECTIVES / WORKING MODEL</span
      ><span>{{
        world.displayView === 'vessel'
          ? 'LOCAL SCENE · ILLUSTRATIVE'
          : 'GEOGRAPHIC VIEW · SHADED RELIEF'
      }}</span
      ><span>01 — 03</span>
    </footer>
    <dialog ref="credits" class="credits" aria-label="Sources and credits">
      <button class="close" autofocus @click="credits?.close()">Close ×</button>
      <h2>Sources & credits</h2>
      <p>
        Geographic imagery: NASA GIBS Blue Marble; bundled Natural Earth shaded relief. Terrain is
        an ellipsoid, with imagery-based relief.
      </p>
      <p>
        Boundary sources and preprocessing are recorded in
        <a href="/data/manifest.json" target="_blank">the data manifest</a>.
      </p>
      <p>
        Stern trawler: “Fishing Trawler 40m” by agt14032013,
        <a
          href="https://sketchfab.com/3d-models/fishing-trawler-40m-3e4161cfeaea45149ae1c0714bcaa912"
          target="_blank"
          >Sketchfab</a
        >, CC BY 4.0; ambient occlusion baked, compressed and weathered procedurally. Adapted crew:
        Innerscene / MakeHuman (CC0). Photographic sky: Poly Haven, “Table Mountain 2 (Pure Sky)”
        (CC0). Water rendering builds on the Three.js ocean example (MIT).
      </p>
      <p>
        Sound: engine, wind and hull wash are generated in the browser. Recordings: “BioAcoustica
        Lyme Gulls” by Edward Baker and “Shoreline, Schull, Co. Cork – Lapping Waves and Boats” by
        Benjamin Burns, both CC BY 3.0, trimmed and re-encoded; other gull and deck clips are CC0 or
        public domain (Sonothèque ADVL, avphillips, bart, qubodup, rubberduck, stephan, hc). Details
        in the manifest.
      </p>
      <p>All activity, vessel names, tracks, and environmental conditions are synthetic.</p>
    </dialog>
  </div>
</template>
