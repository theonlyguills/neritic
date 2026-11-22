import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { launchBrowser } from './browser.mjs'
/** Server under test (default: the local preview). */
const BASE = process.env.NERITIC_URL ?? 'http://127.0.0.1:3070'
const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 400))
})
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(4000)
await page.screenshot({ path: 'artifacts/canada.png' })
console.log('CANADA', await page.locator('.scene-error').allTextContents())
// Coasts open by zooming into the globe; the URL is the scriptable equivalent.
await page.goto(`${BASE}/?view=atlantic`, { waitUntil: 'networkidle' })
await page.waitForTimeout(4500)
await page.screenshot({ path: 'artifacts/atlantic.png' })
console.log('ATLANTIC', await page.locator('.scene-error').allTextContents())
await page.getByRole('button', { name: 'Board vessel' }).click()
await page.waitForTimeout(6000)
await page.screenshot({ path: 'artifacts/vessel.png' })
console.log('VESSEL', await page.locator('.scene-error').allTextContents())
const performanceReport = await page.evaluate(async () => {
  const times = []
  const start = performance.now()
  await new Promise((resolve) => {
    function frame(t) {
      times.push(t)
      if (t - start < 3000) requestAnimationFrame(frame)
      else resolve()
    }
    requestAnimationFrame(frame)
  })
  const canvas = document.querySelector('.render-surface:not(.hidden) canvas')
  const gl = canvas.getContext('webgl2')
  const ext = gl?.getExtension('WEBGL_debug_renderer_info')
  return {
    fps: (1000 * (times.length - 1)) / (times.at(-1) - times[0]),
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable',
    viewport: [innerWidth, innerHeight],
  }
})
writeFileSync('artifacts/performance.json', JSON.stringify(performanceReport, null, 2))
console.log('PERFORMANCE', performanceReport)
await page.getByRole('button', { name: 'Water level', exact: true }).click()
await page.waitForTimeout(1000)
await page.screenshot({ path: 'artifacts/water.png' })
await page.getByRole('button', { name: 'Return to Atlantic', exact: false }).click()
await page.waitForTimeout(1200)
await page.goto(`${BASE}/?view=pacific`)
await page.waitForTimeout(6000)
await page.screenshot({ path: 'artifacts/pacific.png' })
console.log('PACIFIC', await page.locator('.scene-error').allTextContents())
assert.equal(await page.locator('.scene-error').count(), 0)
await page.getByRole('button', { name: 'Canada overview' }).click()
await page.waitForTimeout(2500)
assert.match(page.url(), /view=canada/)
await page.goto(`${BASE}/?view=atlantic`)
await page.locator('.loading').waitFor({ state: 'hidden', timeout: 60000 })
await page.waitForTimeout(2000)
for (let i = 0; i < 3; i++) {
  await page.getByRole('button', { name: 'Board vessel' }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'Return to Atlantic', exact: false }).click()
  await page.waitForTimeout(500)
}
assert.equal(await page.locator('canvas').count(), 2)
assert.equal(await page.locator('.scene-error').count(), 0)
await page.setViewportSize({ width: 390, height: 844 })
await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true })
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
await page.setViewportSize({ width: 1920, height: 1080 })
await page.getByRole('button', { name: 'Sources' }).click()
assert.equal(await page.locator('dialog[open]').count(), 1)
await page.keyboard.press('Escape')
assert.equal(await page.locator('dialog[open]').count(), 0)
// A fresh page verifies asset failure and retry without replacing domain state.
const failure = await browser.newPage()
await failure.route('**/stern-trawler-40m.glb', (route) => route.abort())
await failure.goto(`${BASE}/?view=vessel`)
await failure.locator('.scene-error').waitFor()
await failure.unroute('**/stern-trawler-40m.glb')
await failure.getByRole('button', { name: 'Try again' }).click()
await failure.locator('.loading').waitFor({ state: 'hidden', timeout: 120000 })
assert.equal(await failure.locator('.scene-error').count(), 0)
await failure.close()
const offline = await browser.newPage()
await offline.route('https://gibs.earthdata.nasa.gov/**', (route) => route.abort())
await offline.goto(`${BASE}/`)
await offline.locator('.source-note').waitFor()
assert.equal(await offline.locator('.scene-error').count(), 0)
await offline.close()
const unsupported = await browser.newPage()
await unsupported.addInitScript(() => {
  const original = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null
    return original.call(this, type, ...args)
  }
})
await unsupported.goto(`${BASE}/?view=vessel`)
await unsupported.locator('.scene-error').waitFor()
await unsupported.close()
console.log('ERRORS', errors)
assert.equal(errors.length, 0)
await browser.close()
