import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import { emptySnapshot, type ViewId, type Snapshot } from '../domain/world'
import type { FleetSimulation } from '../domain/simulation'
export const useWorld = defineStore('world', {
  state: () => ({
    view: 'canada' as ViewId,
    /** View currently on screen; trails `view` while a transition is in flight. */
    displayView: 'canada' as ViewId,
    /** Zoom transition phase; panels are hidden while non-empty. */
    transition: '' as '' | 'dive' | 'arrive' | 'depart' | 'rise' | 'swoop',
    selectedVessel: 'nl-01',
    selectedRegion: '',
    /** The running simulation (raw), for per-vessel detail: licences and hail history. */
    simulation: null as FleetSimulation | null,
    /** Raw (non-reactive inside): thousands of vessels are replaced every tick. */
    snapshot: markRaw(emptySnapshot) as Snapshot,
    quality: 'high' as 'high' | 'low',
    reducedMotion: false,
    /** Vessel scenes at dusk (town lights, boat lights) instead of daylight. */
    dusk: false,
    /** Vessel-scene soundscape; remembered per browser. */
    sound: true,
    /** Entrance caption for the vessel scene; `long` = town flyover (letterbox, Skip). */
    tour: null as null | { title: string; line: string; long: boolean },
    /** Ask the map to centre a vessel (bumped on each request). */
    focus: { id: '', n: 0 },
    error: '',
    loading: true,
  }),
  getters: {
    vessel: (state) => state.snapshot.vessels.find((v) => v.id === state.selectedVessel),
  },
  actions: {
    selectVessel(id: string) {
      this.selectedVessel = id
    },
    focusVessel(id: string) {
      this.selectedVessel = id
      this.focus = { id, n: this.focus.n + 1 }
    },
    accept(snapshot: Snapshot) {
      this.snapshot = markRaw(snapshot)
    },
  },
})
