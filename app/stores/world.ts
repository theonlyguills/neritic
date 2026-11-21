import { defineStore } from 'pinia'
import { snapshotAt, type ViewId, type Snapshot } from '../domain/world'
export const useWorld = defineStore('world', {
  state: () => ({
    view: 'canada' as ViewId,
    /** View currently on screen; trails `view` while a transition is in flight. */
    displayView: 'canada' as ViewId,
    /** Zoom transition phase (map ⇄ vessel); panels are hidden while non-empty. */
    transition: '' as '' | 'dive' | 'arrive' | 'depart' | 'rise',
    selectedVessel: 'nl-01',
    selectedRegion: '',
    snapshot: snapshotAt(0) as Snapshot,
    quality: 'high' as 'high' | 'low',
    reducedMotion: false,
    /** Vessel-scene soundscape; remembered per browser. */
    sound: true,
    error: '',
    loading: true,
  }),
  getters: { vessel: (state) => state.snapshot.vessels.find((v) => v.id === state.selectedVessel) },
  actions: {
    selectVessel(id: string) {
      this.selectedVessel = id
    },
    accept(snapshot: Snapshot) {
      this.snapshot = snapshot
    },
  },
})
