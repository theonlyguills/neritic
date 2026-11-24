/**
 * Where the site is served from: '/' locally, e.g. '/neritic/' behind the CFIS docs proxy.
 * Set at build time with NUXT_APP_BASE_URL (see nuxt.config.ts); '/' when not built by Nuxt
 * (the node tests).
 */
declare const __APP_BASE__: string | undefined
export const BASE = typeof __APP_BASE__ === 'string' ? __APP_BASE__ : '/'

/** A site path ('/data/fleet.json') under the base ('/neritic/data/fleet.json'). */
export const url = (path: string) => BASE + path.replace(/^\//, '')
