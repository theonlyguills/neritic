/**
 * Browser for the visual checks.
 *
 * Default: headless Chromium with SwiftShader (software WebGL; works anywhere, slow).
 * `NERITIC_BROWSER=edge`: Windows Edge on the real GPU, for WSL with mirrored networking.
 * It starts Edge with a throwaway profile and a debug port, drives it over CDP, and closes
 * that Edge instance when done. An Edge window appears on the desktop while checks run.
 */
import { spawn, execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'

const EDGE =
  process.env.EDGE_PATH ?? '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROFILE = 'neritic-check'

function closeEdge() {
  // Only the Edge processes started with our throwaway profile.
  const filter = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', filter], { stdio: 'ignore' })
  } catch {
    // Already gone.
  }
}

export async function launchBrowser() {
  if (process.env.NERITIC_BROWSER !== 'edge')
    return chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
  const port = Number(process.env.EDGE_PORT ?? 9333)
  closeEdge()
  spawn(
    EDGE,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=C:\\Temp\\${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1600,1000',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  ).unref()
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((r) => r.ok)
      .catch(() => false)
    if (!ready) await new Promise((r) => setTimeout(r, 500))
  }
  if (!ready) throw new Error(`Edge did not open its debug port ${port}`)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const disconnect = browser.close.bind(browser)
  browser.close = async () => {
    await disconnect().catch(() => undefined)
    closeEdge()
  }
  return browser
}
