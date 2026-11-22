import { cpSync, mkdirSync } from 'node:fs'
// Cesium workers resolve assets relative to this same-origin path.
mkdirSync('public/cesium', { recursive: true })
for (const name of ['Workers', 'Assets', 'Widgets', 'ThirdParty'])
  cpSync(`node_modules/cesium/Build/Cesium/${name}`, `public/cesium/${name}`, { recursive: true })
export default defineNuxtConfig({
  ssr: false,
  modules: ['@pinia/nuxt'],
  devtools: { enabled: false },
  css: ['~/assets.css'],
  app: {
    head: {
      title: 'Neritic · CFIS fleetscape',
      meta: [{ name: 'description', content: 'Interactive marine operations demonstration' }],
    },
  },
  vite: { define: { CESIUM_BASE_URL: JSON.stringify('/cesium/') } },
  compatibilityDate: '2025-09-01',
})
