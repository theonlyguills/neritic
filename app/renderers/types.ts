import type { Snapshot, ViewId } from '../domain/world'
export interface RenderContext {
  navigate(view: ViewId): void
  selectVessel(id: string): void
  selectRegion(id: string): void
  status(message: string): void
}
export interface SceneAdapter {
  activate(view: ViewId, reducedMotion: boolean): Promise<void>
  reset(): void
  suspend(): void
  resize(): void
  update(snapshot: Snapshot): void
  quality(value: 'high' | 'low'): void
  dispose(): void
}
