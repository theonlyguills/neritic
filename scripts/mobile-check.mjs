import { launchBrowser } from './browser.mjs'
import assert from 'node:assert/strict'
/** Server under test (default: the local preview). */
const BASE = process.env.PELAGIC_URL ?? 'http://127.0.0.1:3070'
const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
await page.goto(`${BASE}/?view=atlantic`)
await page.locator('.loading').waitFor({ state: 'hidden', timeout: 30000 })
const explore = page.getByRole('button', { name: 'Board vessel' })
await explore.scrollIntoViewIfNeeded()
await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true })
await explore.click()
await page.waitForURL(/view=vessel/)
await page.locator('.loading').waitFor({ state: 'hidden', timeout: 30000 })
assert.equal(await page.locator('.scene-error').count(), 0)
assert.match(page.url(), /view=vessel/)
await browser.close()
console.log('Mobile drilldown passes')
