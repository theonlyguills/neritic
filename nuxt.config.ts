import { cpSync, mkdirSync } from 'node:fs'
// Cesium workers resolve assets relative to this same-origin path.
mkdirSync('public/cesium', { recursive: true })
for (const name of ['Workers', 'Assets', 'Widgets', 'ThirdParty'])
  cpSync(`node_modules/cesium/Build/Cesium/${name}`, `public/cesium/${name}`, { recursive: true })
// Serving path: '/' locally; set NUXT_APP_BASE_URL=/neritic/ (trailing slash) to build for a
// sub-path. app/domain/base.ts reads the same value through __APP_BASE__.
const base = process.env.NUXT_APP_BASE_URL ?? '/'
export default defineNuxtConfig({
  ssr: false,
  modules: ['@pinia/nuxt'],
  devtools: { enabled: false },
  css: ['~/assets.css'],
  app: {
    baseURL: base,
    head: {
      title: 'Neritic · CFIS fleetscape',
      meta: [{ name: 'description', content: 'Interactive marine operations demonstration' }],
    },
  },
  vite: {
    define: {
      CESIUM_BASE_URL: JSON.stringify(`${base}cesium/`),
      __APP_BASE__: JSON.stringify(base),
    },
  },
  compatibilityDate: '2025-09-01',
})
