import { expect, test } from '@playwright/test'
import { performance } from 'node:perf_hooks'

import { advance, installDeterministicBrowser, PHASE_MS, reachPlacement } from '../helpers'
import { installQaAlphaBootstrap, selectPractice } from './helpers'

const INTERACTION_TARGET_MS = 2_000
const CROWD_UPDATE_TARGET_MS = 16

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowser(page)
  await installQaAlphaBootstrap(page)
})

test('mobile Quick Run, crowd response, and rematch stay inside product budgets', async ({ page }, testInfo) => {
  await page.goto('/')
  const ranked = page.getByRole('button', { name: /Ranked alpha/ })
  await expect(ranked).toHaveAttribute('aria-pressed', 'true')
  await selectPractice(page)

  const quickRunStartedAt = performance.now()
  await page.getByRole('button', { name: 'Quick run' }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  const quickRunMs = performance.now() - quickRunStartedAt

  await reachPlacement(page)
  const crowdTiming = await page.getByLabel('Flag distance').evaluate(async (input) => {
    const range = input as HTMLInputElement
    const minimum = Number(range.min)
    const maximum = Number(range.max)
    const samples: number[] = []
    for (let index = 0; index < 160; index += 1) {
      range.value = String(index % 2 === 0 ? minimum : maximum)
      const startedAt = performance.now()
      range.dispatchEvent(new Event('input', { bubbles: true }))
      range.dispatchEvent(new Event('change', { bubbles: true }))
      samples.push(performance.now() - startedAt)
      if (index % 20 === 19) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
    }
    samples.sort((left, right) => left - right)
    const percentile = (fraction: number) => samples[Math.ceil(samples.length * fraction) - 1] ?? 0
    return {
      samples: samples.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: samples.at(-1) ?? 0,
    }
  })

  await advance(
    page,
    PHASE_MS.placement + PHASE_MS.lock + PHASE_MS.battle + 3_000,
  )
  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete')
  const rematchStartedAt = performance.now()
  await page.getByRole('button', { name: 'Run it back' }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  const rematchMs = performance.now() - rematchStartedAt

  const metrics = {
    quickRunMs: Number(quickRunMs.toFixed(2)),
    rematchMs: Number(rematchMs.toFixed(2)),
    crowd: Object.fromEntries(
      Object.entries(crowdTiming).map(([key, value]) => [key, Number(value.toFixed(2))]),
    ),
  }
  testInfo.annotations.push({
    type: 'performance',
    description: JSON.stringify(metrics),
  })
  await testInfo.attach('performance-metrics.json', {
    body: Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`),
    contentType: 'application/json',
  })
  console.log(`Strikefall interaction performance: ${JSON.stringify(metrics)}`)

  expect(quickRunMs, 'Quick Run should enter its first phase in under two seconds').toBeLessThan(INTERACTION_TARGET_MS)
  expect(rematchMs, 'one-tap rematch should enter its first phase in under two seconds').toBeLessThan(INTERACTION_TARGET_MS)
  expect(crowdTiming.p99Ms, 'crowd-factor UI updates should remain below one 60 Hz frame at p99').toBeLessThan(CROWD_UPDATE_TARGET_MS)
})
