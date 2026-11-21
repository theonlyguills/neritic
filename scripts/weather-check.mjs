import { launchBrowser } from './browser.mjs'
import assert from 'node:assert/strict'
/** Server under test (default: the local preview). */
const BASE = process.env.PELAGIC_URL ?? 'http://127.0.0.1:3070'
const browser = await launchBrowser()
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`${BASE}/?view=vessel`)
  await page.locator('.loading').waitFor({ state: 'hidden', timeout: 60000 })
  assert.equal(await page.locator('.scene-error').count(), 0)
  await page.getByRole('button', { name: 'Water level', exact: true }).click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'artifacts/weather-moving-a.png' })
  await page.waitForTimeout(3500)
  await page.screenshot({ path: 'artifacts/weather-moving-b.png' })
  await page.getByRole('checkbox', { name: 'Reduce motion' }).check()
  await page.waitForTimeout(1000)
  // The canvas is full-bleed under live panels: compare the rendering alone.
  const overlays = await page.addStyleTag({
    content: '.inspector, .view-heading, .bottom-tools, .camera-tools { visibility: hidden }',
  })
  const canvas = page.locator('.render-surface:not(.hidden) canvas')
  const a = await canvas.screenshot({ path: 'artifacts/weather-paused-a.png' })
  await page.waitForTimeout(2200)
  const b = await canvas.screenshot({ path: 'artifacts/weather-paused-b.png' })
  assert.ok(
    a.equals(b),
    'Reduced motion must freeze the rendered sea, vessel and clouds across feed updates',
  )
  await overlays.evaluate((style) => (style.disabled = true))
  await page.getByRole('checkbox', { name: 'Reduce motion' }).uncheck()
  await overlays.evaluate((style) => (style.disabled = false))
  await page.waitForTimeout(1800)
  assert.ok(!b.equals(await canvas.screenshot()), 'Unchecking reduced motion must resume animation')
  await overlays.evaluate((style) => style.remove())
  await page.getByRole('button', { name: 'Elevated view', exact: true }).click()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'artifacts/weather-elevated.png' })
  await page.getByRole('button', { name: 'Working deck', exact: true }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'artifacts/working-deck.png' })
  assert.deepEqual(errors, [])
  console.log('Weather render, shader compilation, pause and resume checks passed')
} finally {
  await browser.close()
}
