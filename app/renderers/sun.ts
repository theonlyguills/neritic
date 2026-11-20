import * as T from 'three'
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js'

/**
 * Keeps the directional sunlight, water glitter and lens flare aligned with the sun that
 * is photographed in the HDR sky, including while the sky slowly rotates for cloud drift.
 *
 * `u`/`elevation` locate the sun disk in the equirectangular image (measured from the
 * brightest pixels). three samples the panorama with u = atan(z, x) / 2π + 0.5, and a
 * scene background rotation R about Y moves a sky direction's azimuth from φ to φ − R.
 */
export interface SkySun {
  /** Horizontal image coordinate of the sun disk, 0–1. */
  u: number
  /** Sun elevation above the horizon, degrees. */
  elevation: number
}

export function skySunDirection(sun: SkySun, rotation: number, target = new T.Vector3()) {
  const azimuth = (sun.u - 0.5) * Math.PI * 2 - rotation
  const elevation = T.MathUtils.degToRad(sun.elevation)
  return target.set(
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth),
  )
}

/** Sky rotation that puts the sun at a chosen world azimuth (radians, atan2(z, x)). */
export function skyRotationFor(sun: SkySun, worldAzimuth: number) {
  return (sun.u - 0.5) * Math.PI * 2 - worldAzimuth
}

function glowTexture(size: number, stops: [number, string][]) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [at, colour] of stops) g.addColorStop(at, colour)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const texture = new T.CanvasTexture(canvas)
  texture.colorSpace = T.SRGBColorSpace
  return texture
}

function ghostTexture(size: number) {
  // Soft hexagonal aperture ghost.
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.translate(size / 2, size / 2)
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6
    ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * size * 0.45, Math.sin(a) * size * 0.45)
  }
  ctx.closePath()
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.45)
  g.addColorStop(0, 'rgba(255,255,255,0.15)')
  g.addColorStop(0.8, 'rgba(255,255,255,0.35)')
  g.addColorStop(1, 'rgba(255,255,255,0.05)')
  ctx.fillStyle = g
  ctx.filter = 'blur(2px)'
  ctx.fill()
  const texture = new T.CanvasTexture(canvas)
  texture.colorSpace = T.SRGBColorSpace
  return texture
}

/** Restrained flare: warm bloom on the disk, a faint streak and a few aperture ghosts. */
export function createLensflare() {
  const glow = glowTexture(256, [
    [0, 'rgba(255,250,235,0.9)'],
    [0.06, 'rgba(255,236,190,0.55)'],
    [0.25, 'rgba(255,205,140,0.1)'],
    [1, 'rgba(255,190,120,0)'],
  ])
  const halo = glowTexture(128, [
    [0, 'rgba(255,255,255,0)'],
    [0.82, 'rgba(255,235,200,0)'],
    [0.9, 'rgba(255,225,180,0.25)'],
    [1, 'rgba(255,225,180,0)'],
  ])
  const ghost = ghostTexture(128)
  const flare = new Lensflare()
  flare.addElement(new LensflareElement(glow, 220, 0, new T.Color(1, 0.95, 0.85)))
  flare.addElement(new LensflareElement(halo, 170, 0, new T.Color(0.45, 0.4, 0.33)))
  flare.addElement(new LensflareElement(ghost, 34, 0.45, new T.Color(0.22, 0.26, 0.32)))
  flare.addElement(new LensflareElement(ghost, 58, 0.62, new T.Color(0.26, 0.22, 0.16)))
  flare.addElement(new LensflareElement(ghost, 24, 0.78, new T.Color(0.16, 0.26, 0.22)))
  flare.addElement(new LensflareElement(ghost, 80, 1.0, new T.Color(0.2, 0.18, 0.28)))
  flare.name = 'Sun lens flare'
  return flare
}
