import { expect, test } from '@playwright/test'

import {
  captureRuntimeFailures,
  installDeterministicBrowser,
} from '../helpers'
import { completeRun, installQaAlphaBootstrap, startRun } from './helpers'

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowser(page)
  await installQaAlphaBootstrap(page)
})

test('an online visit installs a complete offline practice shell', async ({ page, context }) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.goto('/')

  const installed = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
      })
    }
    const cacheNames = await caches.keys()
    const requests = (await Promise.all(cacheNames.map(async (name) => {
      const cache = await caches.open(name)
      return cache.keys()
    }))).flat()
    return {
      active: Boolean(registration.active),
      controlled: Boolean(navigator.serviceWorker.controller),
      cacheNames,
      urls: requests.map((request) => request.url),
    }
  })

  expect(installed.active).toBe(true)
  expect(installed.controlled).toBe(true)
  expect(installed.cacheNames.some((name) => name.startsWith('strikefall-practice-'))).toBe(true)
  expect(installed.urls.some((url) => url.endsWith('.wasm'))).toBe(true)
  expect(installed.urls.some((url) => url.endsWith('/manifest.webmanifest'))).toBe(true)
  await expect(page.locator('.offline-status')).toContainText('Offline ready')
  const ranked = page.getByRole('button', { name: /Ranked alpha/ })
  await expect(ranked).toBeEnabled()
  await expect(ranked).toHaveAttribute('aria-pressed', 'true')
  await page.clock.fastForward(5_000)
  await expect(page.locator('.offline-status')).toHaveCount(0)

  await page.evaluate(async () => {
    await Promise.all([
      fetch('/api/v1/offline-cache-probe').catch(() => null),
      fetch('/ranked/offline-cache-probe').catch(() => null),
      fetch('/replay/offline-cache-probe').catch(() => null),
    ])
  })
  const leakedNetworkUrls = await page.evaluate(async () => {
    const names = await caches.keys()
    const requests = (await Promise.all(names.map(async (name) => {
      const cache = await caches.open(name)
      return cache.keys()
    }))).flat()
    return requests
      .map((request) => new URL(request.url).pathname)
      .filter((pathname) => /^(\/api|\/ranked|\/replay)(\/|$)/.test(pathname))
  })
  expect(leakedNetworkUrls).toEqual([])

  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  expect(await page.evaluate(() => navigator.onLine)).toBe(false)
  await expect(page.locator('.offline-status')).toContainText('Offline · practice only')
  await expect(page.getByText('Exact SolMath scoring', { exact: true })).toBeVisible()

  await expect(page.getByRole('button', { name: /Ranked alpha/ })).toBeDisabled()
  await startRun(page)
  await completeRun(page)
  await expect(page.locator('.proof-copy')).toContainText(/practice path is unranked|verified locally/)
  await expect(page.getByRole('button', { name: 'Run it back' })).toBeEnabled()
  expect(runtimeFailures).toEqual([])
})
