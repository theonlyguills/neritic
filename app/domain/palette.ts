import type { VesselStatus } from './simulation'
/**
 * Vessel status colours, shared by the map and the panels. Validated as a categorical set
 * for colour-vision deficiency and contrast on the dark panel surface (#0b1f29).
 */
export const STATUS_COLOUR: Record<VesselStatus, string> = {
  fishing: '#26a884',
  outbound: '#4593dc',
  inbound: '#c97d30',
  'in-port': '#a77fd6',
}
