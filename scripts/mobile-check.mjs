import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
await page.goto('http://127.0.0.1:3070/?view=atlantic')
await page.locator('.loading').waitFor({ state: 'hidden', timeout: 30000 })
const explore = page.getByRole('button', { name: 'Explore vessel' })
await explore.scrollIntoViewIfNeeded()
await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true })
await explore.click()
await page.waitForURL(/view=vessel/)
await page.locator('.loading').waitFor({ state: 'hidden', timeout: 30000 })
assert.equal(await page.locator('.scene-error').count(), 0)
assert.match(page.url(), /view=vessel/)
await browser.close()
console.log('Mobile drilldown passes')
