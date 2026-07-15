export const SERVICE_WORKER_TEMPLATE = String.raw`/* Strikefall practice shell service worker.
 *
 * Generated into dist/sw.js by vite.config.ts. Ranked and replay traffic stays
 * outside this worker so offline practice can never appear authoritative.
 */

const CACHE_PREFIX = 'strikefall-practice-'
const CACHE_VERSION = __STRIKEFALL_CACHE_VERSION__
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION
const PRECACHE_URLS = __STRIKEFALL_PRECACHE_URLS__
const NETWORK_ONLY_PATHS = __STRIKEFALL_NETWORK_ONLY_PATHS__

function isExcludedPath(pathname) {
  return NETWORK_ONLY_PATHS.some((prefix) => (
    pathname === prefix || pathname.startsWith(prefix + '/')
  ))
}

function isCacheableRequest(request, url) {
  if (request.method !== 'GET' || url.origin !== self.location.origin) return false
  if (request.headers.has('authorization') || isExcludedPath(url.pathname)) return false
  return true
}

function isStaticAsset(pathname) {
  return pathname.startsWith('/assets/')
    || pathname.startsWith('/icons/')
    || pathname === '/favicon.svg'
    || pathname === '/manifest.webmanifest'
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  // Asset servers commonly emit Vary: Origin; install-time fetches do not
  // carry the module request's Origin header. The URL is fingerprinted and
  // already passed the same-origin/auth/path safety gate, so ignoring Vary for
  // this exact cache lookup is both necessary for offline modules and scoped.
  const cached = await cache.match(request, { ignoreVary: true })
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone())
  }
  return response
}

async function networkFirstNavigation(request) {
  try {
    return await fetch(request)
  } catch {
    const cache = await caches.open(CACHE_NAME)
    const shell = await cache.match('/index.html')
    if (shell) return shell
    throw new Error('Strikefall practice shell is not cached yet.')
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll(PRECACHE_URLS)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  if (event.data === 'STRIKEFALL_SKIP_WAITING') void self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (!isCacheableRequest(request, url)) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request))
  }
})
`
