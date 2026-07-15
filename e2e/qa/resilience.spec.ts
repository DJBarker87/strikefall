import { expect, test } from '@playwright/test'

import {
  advance,
  captureRuntimeFailures,
  installDeterministicBrowser,
  PHASE_MS,
} from '../helpers'
import {
  PREFERENCES_STORAGE_KEY,
  TELEMETRY_STORAGE_KEY,
  installQaAlphaBootstrap,
  selectPractice,
  startRun,
  telemetryCount,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowser(page)
  await installQaAlphaBootstrap(page)
})

test('system reduction and explicit motion controls remain usable', async ({ page }) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  const shell = page.locator('.app-shell')
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  await expect(shell).toHaveClass(/app-shell--reduced-motion/)

  await page.getByRole('button', { name: 'Player and privacy settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Player & privacy' })
  const motion = settings.getByLabel('Motion')
  await expect(motion).toHaveValue('system')

  await motion.selectOption('full')
  await expect(shell).not.toHaveClass(/app-shell--reduced-motion/)
  await motion.selectOption('reduced')
  await expect(shell).toHaveClass(/app-shell--reduced-motion/)

  const storedMotion = await page.evaluate((key) => {
    const value = localStorage.getItem(key)
    return value ? (JSON.parse(value) as { motion?: string }).motion : null
  }, PREFERENCES_STORAGE_KEY)
  expect(storedMotion).toBe('reduced')
  expect(runtimeFailures).toEqual([])
})

test('telemetry is local by default and off means no queue or upload', async ({ page }) => {
  const runtimeFailures = captureRuntimeFailures(page)
  const uploads: string[] = []

  await page.goto('/')
  const ranked = page.getByRole('button', { name: /Ranked alpha/ })
  await expect(ranked).toHaveAttribute('aria-pressed', 'true')
  await selectPractice(page)
  page.on('request', (request) => {
    if (request.method() !== 'GET') uploads.push(`${request.method()} ${request.url()}`)
  })
  await page.getByRole('button', { name: 'Player and privacy settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Player & privacy' })
  const telemetry = settings.getByLabel('Telemetry')
  await expect(telemetry).toHaveValue('local')
  await page.getByRole('button', { name: 'Close settings' }).click()

  await startRun(page)
  expect(await telemetryCount(page)).toBeGreaterThan(0)
  expect(uploads).toEqual([])

  await page.getByRole('button', { name: 'Player and privacy settings' }).click()
  await telemetry.selectOption('off')
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), TELEMETRY_STORAGE_KEY))
    .toBeNull()
  await page.getByRole('button', { name: 'Close settings' }).click()

  await advance(page, PHASE_MS.deck + 40)
  await advance(page, PHASE_MS.approach + 40)
  expect(await telemetryCount(page)).toBe(0)
  expect(uploads).toEqual([])
  expect(runtimeFailures).toEqual([])
})

test('WASM-unavailable startup fails closed with an explicit retry', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'WebAssembly', {
      configurable: true,
      value: undefined,
    })
  })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Exact scoring is unavailable' })).toBeVisible()
  await expect(page.getByText(/never substitutes browser floating-point math/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Quick run' })).toHaveCount(0)

  const retry = page.getByRole('button', { name: 'Retry SolMath' })
  await retry.click()
  await expect(page.getByRole('heading', { name: 'Exact scoring is unavailable' })).toBeVisible()
  await expect(retry).toBeEnabled()
  expect(pageErrors).toEqual([])
})
