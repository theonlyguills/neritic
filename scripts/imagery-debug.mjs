import { chromium } from '@playwright/test'
const b = await chromium.launch({
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const p = await b.newPage()
p.on('response', (r) => {
  if (r.status() >= 400) console.log(r.status(), r.url())
})
await p.goto('http://127.0.0.1:3070')
await p.waitForTimeout(6000)
await b.close()
