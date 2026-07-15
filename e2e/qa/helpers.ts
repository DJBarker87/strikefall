import { expect, type CDPSession, type Page } from '@playwright/test'

import { advance, PHASE_MS } from '../helpers'

export const TELEMETRY_STORAGE_KEY = 'strikefall.prototype.telemetry.v1'
export const PREFERENCES_STORAGE_KEY = 'strikefall.preferences.v1'

const QA_ALPHA_TOKEN = `sf_alpha_${'ab'.repeat(32)}`

/**
 * The QA preview deliberately advertises a configured ranked endpoint so it
 * exercises the public Ranked-first boot path. The standalone preview does
 * not run the round service, so provide the smallest valid anonymous-session
 * boundary needed to keep browser-runtime checks free of expected 404 noise.
 */
export async function installQaAlphaBootstrap(page: Page) {
  const session = {
    handle: 'Rider-QA000001',
    expiresAtMs: Date.now() + 24 * 60 * 60 * 1_000,
    telemetryConsent: false,
    experiments: {
      escape: 'midpoint',
      risk_display: 'probability',
    },
  }

  await page.route('**/api/v1/sessions', async (route) => {
    const request = route.request()
    if (request.method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ token: QA_ALPHA_TOKEN, session }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(session),
    })
  })
}

export async function selectPractice(page: Page) {
  const practice = page.getByRole('button', { name: /Practice/ })
  await practice.click()
  await expect(practice).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Quick run' })).toBeEnabled()
}

export interface MemorySample {
  round: number
  jsHeapUsedBytes: number
  jsHeapTotalBytes: number
  documents: number
  nodes: number
  jsEventListeners: number
}

interface CdpMetric {
  name: string
  value: number
}

interface PerformanceMetricsResult {
  metrics: CdpMetric[]
}

interface DomCountersResult {
  documents: number
  nodes: number
  jsEventListeners: number
}

function metric(metrics: readonly CdpMetric[], name: string): number {
  const found = metrics.find((entry) => entry.name === name)
  if (!found || !Number.isFinite(found.value)) {
    throw new Error(`Chromium did not expose the ${name} performance metric`)
  }
  return found.value
}

/** Chromium-only probe; callers must not use this from a WebKit project. */
export async function createChromiumMemoryProbe(page: Page) {
  const session: CDPSession = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  await session.send('HeapProfiler.enable')

  return {
    async sample(round: number): Promise<MemorySample> {
      await session.send('HeapProfiler.collectGarbage')
      await page.evaluate(() => Promise.resolve())
      const performance = await session.send('Performance.getMetrics') as PerformanceMetricsResult
      const dom = await session.send('Memory.getDOMCounters') as DomCountersResult
      return {
        round,
        jsHeapUsedBytes: metric(performance.metrics, 'JSHeapUsedSize'),
        jsHeapTotalBytes: metric(performance.metrics, 'JSHeapTotalSize'),
        documents: dom.documents,
        nodes: dom.nodes,
        jsEventListeners: dom.jsEventListeners,
      }
    },
    async close() {
      await session.detach()
    },
  }
}

export function linearSlope(
  samples: readonly MemorySample[],
  value: (sample: MemorySample) => number,
): number {
  if (samples.length < 2) return 0
  const meanRound = samples.reduce((sum, sample) => sum + sample.round, 0) / samples.length
  const meanValue = samples.reduce((sum, sample) => sum + value(sample), 0) / samples.length
  let numerator = 0
  let denominator = 0
  for (const sample of samples) {
    const x = sample.round - meanRound
    numerator += x * (value(sample) - meanValue)
    denominator += x * x
  }
  return denominator === 0 ? 0 : numerator / denominator
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('Cannot find the median of an empty list')
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

export async function startRun(page: Page, rematch = false) {
  const label = rematch ? 'Run it back' : 'Quick run'
  await page.getByRole('button', { name: label }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming', {
    timeout: 15_000,
  })
}

/** Completes the real product phase machine using Playwright's virtual clock. */
export async function completeRun(page: Page) {
  await advance(page, PHASE_MS.deck + 40)
  await expect(page.locator('.phase-readout strong')).toHaveText('Read the tape')
  await advance(page, PHASE_MS.approach + 40)
  await expect(page.locator('.phase-readout strong')).toHaveText('Plant your flag')
  await advance(page, PHASE_MS.placement + 40)
  const phase = page.locator('.phase-readout strong')
  if (await phase.textContent() !== 'Line is live') {
    await expect(page.getByText('Locked', { exact: true })).toBeVisible()
    await advance(page, PHASE_MS.lock + 40)
  }
  await expect(phase).toHaveText('Line is live')
  await advance(page, PHASE_MS.battle + 1_000)
  await expect(phase).toHaveText('Round complete')
  await expect(page.locator('.result-panel')).toBeVisible()
}

export async function telemetryCount(page: Page): Promise<number> {
  return page.evaluate((key) => {
    const encoded = localStorage.getItem(key)
    if (!encoded) return 0
    const value = JSON.parse(encoded) as unknown
    return Array.isArray(value) ? value.length : -1
  }, TELEMETRY_STORAGE_KEY)
}
