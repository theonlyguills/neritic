<script setup lang="ts">
import { FEATURED, demoClock, scenes, validView, type ViewId } from '../domain/world'
import { SIM_RATE, type HailEvent, type LiveVessel } from '../domain/simulation'
import { STATUS_COLOUR } from '../domain/palette'
import { chooseScenery } from '../domain/scenery'
import { url } from '../domain/base'
const world = useWorld()
const route = useRoute()
const router = useRouter()
const credits = ref<HTMLDialogElement>()
const scene = computed(() => scenes[world.displayView])
const coast = computed(() =>
  world.displayView === 'atlantic' || world.displayView === 'pacific'
    ? world.displayView
    : undefined,
)
const stats = computed(() => world.snapshot.stats[coast.value ?? 'canada'])
watch(
  () => [route.query.view, route.query.vessel],
  ([view, vessel]) => {
    world.view = validView(view)
    world.selectedRegion = ''
    if (typeof vessel === 'string' && vessel) world.selectVessel(vessel)
  },
  { immediate: true },
)
function go(view: ViewId) {
  void router.push({
    query: view === 'vessel' ? { view, vessel: world.selectedVessel } : { view },
  })
}
function explore(id: string) {
  world.selectVessel(id)
  go('vessel')
}
const vesselCoast = computed<ViewId>(() => world.vessel?.coast ?? 'atlantic')
const level = computed(() =>
  world.displayView === 'canada' ? '01' : world.displayView === 'vessel' ? '03' : '02',
)
const STATUS_LABEL: Record<LiveVessel['status'], string> = {
  fishing: 'Fishing',
  outbound: 'Outbound',
  inbound: 'Returning',
  'in-port': 'In port',
}
const REGION_NAME = {
  NL: 'Newfoundland & Labrador',
  MAR: 'Maritimes',
  GLF: 'Gulf',
  QC: 'Quebec',
  PAC: 'Pacific',
  ARC: 'Arctic',
} as const
const regions = computed(() => {
  const rows = Object.entries(stats.value.byRegion)
    .filter(([, r]) => r.vessels > 0)
    .map(([code, r]) => ({ code, name: REGION_NAME[code as keyof typeof REGION_NAME], ...r }))
    .sort((a, b) => b.vessels - a.vessels)
  const max = Math.max(1, ...rows.map((r) => r.vessels))
  return rows.map((r) => ({ ...r, sea: (r.atSea / max) * 100, port: (r.inPort / max) * 100 }))
})
const species = computed(() => {
  const rows = stats.value.bySpecies.slice(0, 5)
  const max = Math.max(1, ...rows.map((r) => r.atSea))
  return rows.map((r) => ({ ...r, width: (r.atSea / max) * 100 }))
})
const feed = computed(() =>
  world.snapshot.feed.filter((e) => !coast.value || e.coast === coast.value).slice(0, 6),
)
function ago(e: HailEvent) {
  const s = Math.max(0, Math.round((world.snapshot.time - e.time) / SIM_RATE))
  return s < 5 ? 'now' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`
}
const tonnes = (kg: number) =>
  kg >= 1000 ? `${(kg / 1000).toFixed(1)} t` : `${kg.toLocaleString('en-CA')} kg`
const licences = computed(() => {
  const l = world.snapshot.licences
  if (!coast.value) return l.total
  const codes = coast.value === 'pacific' ? ['PAC'] : ['NL', 'MAR', 'GLF', 'QC', 'ARC']
  return codes.reduce((n, c) => n + (l.byRegion[c as keyof typeof l.byRegion] ?? 0), 0)
})
const query = ref('')
const matches = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (q.length < 2) return []
  return world.snapshot.vessels
    .filter(
      (v) =>
        (!coast.value || v.coast === coast.value) &&
        (v.name.toLowerCase().includes(q) || v.cfv.includes(q)),
    )
    .slice(0, 7)
})
const featured = computed(() =>
  FEATURED.map((f) => ({ ...f, vessel: world.snapshot.vessels.find((v) => v.id === f.id) })).filter(
    (f) => f.vessel && (!coast.value || f.vessel.coast === coast.value),
  ),
)
const regionCount = computed(() => {
  if (!world.selectedRegion) return 0
  return world.snapshot.vessels.filter(
    (v) => v.area === world.selectedRegion && v.status === 'fishing',
  ).length
})
const setting = computed(() => {
  if (!world.vessel) return ''
  const { config, representative } = chooseScenery(world.vessel)
  return representative ? `${config.place} (representative)` : config.place
})
const clock = computed(() => demoClock(world.snapshot.time))
const clockAt = (t: number) => demoClock(t)
const heldLicences = computed(() =>
  world.simulation && world.vessel ? world.simulation.licencesOf(world.vessel.id) : [],
)
const history = computed(() =>
  world.simulation && world.vessel
    ? world.simulation.history(world.vessel.id, world.snapshot.time, 5)
    : [],
)
const hint = computed(() =>
  world.displayView === 'vessel'
    ? 'DRAG TO ORBIT · SCROLL TO ZOOM'
    : world.displayView === 'canada'
      ? 'SCROLL INTO A COAST TO OPEN IT · CLICK A BUBBLE TO EXPAND'
      : 'CLICK A BUBBLE TO EXPAND · DOUBLE-CLICK A VESSEL TO BOARD · SCROLL OUT FOR CANADA',
)
</script>
<template>
  <div class="app-shell" :class="{ 'ui-away': world.transition }">
    <header class="topbar">
      <a class="brand" href="?view=canada" @click.prevent="go('canada')"
        ><span class="brand-mark">≋</span><span>NERITIC<small>CFIS FLEETSCAPE</small></span></a
      >
      <nav class="crumbs" aria-label="Location">
        <button :class="{ active: world.view === 'canada' }" @click="go('canada')">Canada</button
        ><template v-if="world.view !== 'canada'"
          ><span class="sep">›</span
          ><button
            :class="{ active: world.view !== 'vessel' }"
            @click="go(world.view === 'vessel' ? vesselCoast : world.view)"
          >
            {{
              (world.view === 'vessel' ? vesselCoast : world.view) === 'pacific'
                ? 'Pacific'
                : 'Atlantic'
            }}
          </button></template
        ><template v-if="world.view === 'vessel' && world.vessel"
          ><span class="sep">›</span
          ><button class="active">{{ world.vessel.name }}</button></template
        >
      </nav>
      <span class="demo-tag"
        ><span class="clock"
          ><b>{{ clock }}</b> DEMO CLOCK</span
        ><i /> SYNTHETIC DATA</span
      >
    </header>
    <main>
      <WorldCanvas />
      <section class="view-heading">
        <div class="eyebrow">
          CANADIAN WATERS <span>/</span> {{ level }} —
          {{
            world.displayView === 'canada'
              ? 'NATIONAL OPERATING PICTURE'
              : world.displayView === 'vessel'
                ? `ON THE WATER · ${setting.toUpperCase()}`
                : 'REGIONAL VIEW'
          }}
        </div>
        <h1>
          {{ world.displayView === 'vessel' && world.vessel ? world.vessel.name : scene.title }}
        </h1>
        <p>
          {{
            world.displayView === 'vessel' && world.vessel
              ? `${world.vessel.gear} · ${world.vessel.species} · ${world.vessel.area}`
              : scene.subtitle
          }}
        </p>
        <button
          v-if="world.displayView !== 'canada'"
          class="back"
          @click="go(world.displayView === 'vessel' ? vesselCoast : 'canada')"
        >
          ←
          {{
            world.displayView === 'vessel'
              ? `Return to ${vesselCoast === 'pacific' ? 'Pacific' : 'Atlantic'}`
              : 'Canada overview'
          }}
        </button>
      </section>
      <section
        v-if="world.displayView !== 'vessel'"
        class="kpis"
        :class="{ regional: coast }"
        aria-label="Key figures"
      >
        <KpiTile
          label="ACTIVE LICENCES"
          :value="licences"
          :sub="coast ? 'Licences in this coast\'s regions' : 'Across 6 DFO regions'"
        />
        <KpiTile
          label="VESSELS AT SEA"
          :value="stats.atSea"
          :accent="STATUS_COLOUR.fishing"
          :sub="`${stats.fishing.toLocaleString('en-CA')} fishing · ${stats.inbound.toLocaleString('en-CA')} returning`"
        />
        <KpiTile
          label="HAILS · 24 H"
          :value="stats.hailOuts + stats.hailIns"
          :sub="`${stats.hailOuts.toLocaleString('en-CA')} out · ${stats.hailIns.toLocaleString('en-CA')} in`"
        />
        <KpiTile
          label="EST. LANDINGS · 24 H"
          :value="stats.landingsKg / 1000"
          unit="t"
          sub="From hail-in estimates"
        />
        <KpiTile
          label="IN PORT"
          :value="stats.inPort"
          :accent="STATUS_COLOUR['in-port']"
          :sub="`of ${stats.vessels.toLocaleString('en-CA')} vessels`"
        />
      </section>
      <aside class="inspector" aria-label="Activity details">
        <div class="panel-heading">
          <span class="eyebrow">{{
            world.displayView === 'vessel' ? 'VESSEL PROFILE' : 'LIVE HAILS'
          }}</span
          ><span class="live"><span class="live-dot" /> LIVE</span>
        </div>
        <template v-if="world.displayView === 'vessel'"
          ><template v-if="world.vessel"
            ><h2>{{ world.vessel.name }}</h2>
            <p class="muted">
              CFV {{ world.vessel.cfv }} · {{ world.vessel.lengthM }} m ·
              {{ world.vessel.gear.toLowerCase() }}
            </p>
            <div class="status-chip" :style="{ '--c': STATUS_COLOUR[world.vessel.status] }">
              <i />{{ STATUS_LABEL[world.vessel.status] }}
            </div>
            <div class="stats">
              <div>
                <strong>{{ world.vessel.speed.toFixed(1) }}<em> kn</em></strong
                ><span>SPEED</span>
              </div>
              <div>
                <strong
                  >{{ String(Math.round(world.vessel.heading)).padStart(3, '0') }}<em>°</em></strong
                ><span>HEADING</span>
              </div>
            </div>
            <dl>
              <dt>Fishery</dt>
              <dd>{{ world.vessel.species }}</dd>
              <dt>Area</dt>
              <dd>{{ world.vessel.area }}</dd>
              <dt>Home port</dt>
              <dd>{{ world.vessel.homePortName }}</dd>
              <dt>Licences held</dt>
              <dd>{{ world.vessel.licences }}</dd>
              <dt>On board (est.)</dt>
              <dd>{{ world.vessel.onboardKg ? tonnes(world.vessel.onboardKg) : '—' }}</dd>
              <dt>Scene</dt>
              <dd>{{ setting }}</dd>
              <dt>Position</dt>
              <dd>
                {{ world.vessel.latitude.toFixed(3) }}° N
                {{ Math.abs(world.vessel.longitude).toFixed(3) }}° W
              </dd>
            </dl>
            <h3 class="section">Licences</h3>
            <ul class="licences">
              <li v-for="l in heldLicences" :key="l.number">
                <span
                  ><strong>{{ l.species }}</strong
                  ><small>{{ l.number }} · {{ l.gear }} · {{ l.area }}</small></span
                ><em :class="{ open: l.open }">{{ l.open ? 'Open' : 'Closed' }}</em>
              </li>
            </ul>
            <h3 class="section">Recent hails</h3>
            <ol class="timeline">
              <li v-for="h in history" :key="h.key" :class="h.kind">
                <i /><span
                  ><strong>{{ h.kind === 'out' ? 'Hail out' : 'Hail in' }}</strong> ·
                  {{ clockAt(h.time) }}</span
                ><small>{{
                  h.kind === 'out'
                    ? `${h.port} → ${h.area} · ${h.species}`
                    : `${h.area} → ${h.port} · est. ${tonnes(h.estimateKg)}`
                }}</small>
              </li>
            </ol></template
          >
          <p class="muted small">
            Drag to orbit. Scroll to move closer. Scenery, weather and the vessel model illustrate
            the setting; they are not a vessel record or forecast.
          </p></template
        >
        <template v-else>
          <TransitionGroup name="feed" tag="ol" class="feed">
            <li v-for="e in feed" :key="e.key">
              <button @click="world.focusVessel(e.vesselId)">
                <span class="hail" :class="e.kind">{{ e.kind === 'out' ? '↗ OUT' : '↙ IN' }}</span
                ><span class="feed-body"
                  ><strong>{{ e.name }}</strong
                  ><small v-if="e.kind === 'out'"
                    >{{ e.port }} → {{ e.area }} · {{ e.species }}</small
                  ><small v-else
                    >{{ e.area }} → {{ e.port }} · est. {{ tonnes(e.estimateKg) }}</small
                  ></span
                ><span class="ago">{{ ago(e) }}</span>
              </button>
            </li>
          </TransitionGroup>
          <template v-if="world.displayView === 'canada'">
            <h3 class="section">Vessels by region</h3>
            <div class="legend">
              <span><i :style="{ background: STATUS_COLOUR.fishing }" />At sea</span
              ><span><i :style="{ background: STATUS_COLOUR['in-port'] }" />In port</span>
            </div>
            <div class="bars">
              <div
                v-for="r in regions"
                :key="r.code"
                class="bar-row"
                :title="`${r.name}: ${r.atSea} at sea, ${r.inPort} in port`"
              >
                <span class="bar-label">{{ r.name }}</span>
                <span class="bar-track"
                  ><span
                    class="seg"
                    :style="{ width: r.sea + '%', background: STATUS_COLOUR.fishing }" /><span
                    class="seg"
                    :style="{ width: r.port + '%', background: STATUS_COLOUR['in-port'] }"
                /></span>
                <span class="bar-value">{{ r.atSea }}</span>
              </div>
            </div>
            <h3 class="section">Fisheries at sea now</h3>
            <div class="bars">
              <div
                v-for="s in species"
                :key="s.species"
                class="bar-row"
                :title="`${s.species}: ${s.atSea} vessels at sea`"
              >
                <span class="bar-label">{{ s.species }}</span>
                <span class="bar-track"
                  ><span class="seg" :style="{ width: s.width + '%', background: '#5aa9c9' }"
                /></span>
                <span class="bar-value">{{ s.atSea }}</span>
              </div>
            </div>
          </template>
          <template v-else>
            <label class="search"
              ><span class="eyebrow">FIND A VESSEL</span
              ><input
                v-model="query"
                type="search"
                placeholder="Name or CFV number"
                autocomplete="off"
            /></label>
            <div v-if="matches.length" class="vessel-list">
              <button
                v-for="v in matches"
                :key="v.id"
                :class="{ selected: world.selectedVessel === v.id }"
                @click="world.focusVessel(v.id)"
              >
                <span class="dot" :style="{ background: STATUS_COLOUR[v.status] }" /><span
                  ><strong>{{ v.name }}</strong
                  ><small
                    >{{ v.species }} · {{ v.area }} · {{ STATUS_LABEL[v.status] }}</small
                  ></span
                >
              </button>
            </div>
            <template v-if="!query && featured.length">
              <h3 class="section">Close-up scenes</h3>
              <div class="vessel-list">
                <button
                  v-for="f in featured"
                  :key="f.id"
                  :class="{ selected: world.selectedVessel === f.id }"
                  @click="world.focusVessel(f.id)"
                >
                  <span class="dot" :style="{ background: STATUS_COLOUR[f.vessel!.status] }" /><span
                    ><strong>{{ f.vessel!.name }}</strong
                    ><small>{{ f.setting }} · {{ f.place }}</small></span
                  ><span>↗</span>
                </button>
              </div>
            </template>
            <div v-if="world.selectedRegion" class="selection-info">
              <span class="eyebrow">AREA {{ world.selectedRegion }}</span>
              <p class="muted small">{{ regionCount }} vessels fishing in this area now.</p>
            </div>
            <div v-if="world.vessel?.coast === coast" class="selection-info">
              <span class="eyebrow">SELECTED VESSEL</span>
              <h3>{{ world.vessel!.name }}</h3>
              <div class="status-chip" :style="{ '--c': STATUS_COLOUR[world.vessel!.status] }">
                <i />{{ STATUS_LABEL[world.vessel!.status] }} ·
                {{ world.vessel!.speed.toFixed(1) }} kn
              </div>
              <p class="muted small">
                {{ world.vessel!.species }} · {{ world.vessel!.gear }} · {{ world.vessel!.area }} ·
                home port {{ world.vessel!.homePortName }}
              </p>
              <button class="primary" @click="explore(world.vessel!.id)">
                Board vessel <span>→</span>
              </button>
            </div>
          </template>
        </template>
        <div class="panel-foot">SYNTHETIC ACTIVITY <span>●</span> REAL GEOGRAPHY</div>
      </aside>
      <div class="bottom-tools">
        <div v-if="world.displayView !== 'vessel'" class="map-legend" aria-label="Vessel status">
          <span v-for="(c, s) in STATUS_COLOUR" :key="s"
            ><i :style="{ background: c }" />{{ STATUS_LABEL[s] }}</span
          >
        </div>
        <span class="map-hint">{{ hint }}</span>
        <div>
          <label
            >Detail
            <select v-model="world.quality">
              <option value="high">High</option>
              <option value="low">Reduced</option>
            </select></label
          ><label class="motion-label"
            ><input v-model="world.reducedMotion" type="checkbox" /> Reduce motion</label
          ><button
            class="time-toggle"
            :aria-pressed="world.dusk"
            title="Time of day on the map and in the vessel scenes"
            @click="world.dusk = !world.dusk"
          >
            <span :class="{ on: !world.dusk }">☀ Day</span
            ><span :class="{ on: world.dusk }">☾ Dusk</span></button
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
      ><span>{{ level }} — 03</span>
    </footer>
    <dialog ref="credits" class="credits" aria-label="Sources and credits">
      <button class="close" autofocus @click="credits?.close()">Close ×</button>
      <h2>Sources & credits</h2>
      <p>
        Geographic imagery: NASA GIBS Blue Marble and, at dusk, VIIRS Black Marble city lights;
        bundled Natural Earth shaded relief. Terrain is an ellipsoid, with imagery-based relief.
      </p>
      <p>
        Boundary sources and preprocessing are recorded in
        <a :href="url('/data/manifest.json')" target="_blank">the data manifest</a>.
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
        Inshore boats: “Alma Paulin Fishing Boat” by Air Digital (a scanned Cape Islander) and
        “Fishing Vessel IV” by agt14032013, with a bucket by Melonpolygons and fish by yimit, all CC
        BY 4.0 via Sketchfab; cleaned up (the Cape Islander’s painted name removed) and ambient
        occlusion baked. Additional skies: Poly Haven “Qwantani Late Afternoon”, “Rustig Koppie”,
        “Kloofendal Overcast” and, for dusk, “Industrial Sunset 02” (CC0).
      </p>
      <p>
        Sound: engine, wind and hull wash are generated in the browser. Recordings: “BioAcoustica
        Lyme Gulls” by Edward Baker and “Shoreline, Schull, Co. Cork – Lapping Waves and Boats” by
        Benjamin Burns, both CC BY 3.0, trimmed and re-encoded; other gull and deck clips are CC0 or
        public domain (Sonothèque ADVL, avphillips, bart, qubodup, rubberduck, stephan, hc). Details
        in the manifest.
      </p>
      <p>
        Harbour locations: Fisheries and Oceans Canada, Small Craft Harbours open data, and the
        Canadian Geographical Names Database (Open Government Licence – Canada). Land mask for
        vessel tracks: Natural Earth (public domain).
      </p>
      <p>
        Coastal and harbour scenery (The Narrows, Lunenburg, Johnstone Strait, Prince Rupert): ©
        OpenStreetMap contributors, ODbL 1.0; elevation from Terrain Tiles (Tilezen, AWS Open Data),
        which contains information licensed under the Open Government Licence – Canada (CDEM,
        Natural Resources Canada), with ETOPO1 (NOAA), GMTED2010 and SRTM (USGS). Building colours,
        trees and weather are illustrative.
      </p>
      <p>
        All vessels, names, CFV numbers, licences, hails, tracks and landings are synthetic and
        illustrative; no CFIS or DFO records are used.
      </p>
    </dialog>
  </div>
</template>
