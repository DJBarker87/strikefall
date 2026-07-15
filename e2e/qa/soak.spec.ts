import { expect, test } from '@playwright/test'

import { captureRuntimeFailures } from '../helpers'
import {
  completeRun,
  createChromiumMemoryProbe,
  installQaAlphaBootstrap,
  linearSlope,
  median,
  selectPractice,
  startRun,
  telemetryCount,
  type MemorySample,
} from './helpers'

const ROUND_COUNT = 50
const SAMPLE_INTERVAL = 5
const MIB = 1024 * 1024

test('50 consecutive rounds stay bounded after forced-GC warmup', async ({ page }, testInfo) => {
  test.setTimeout(12 * 60_000)
  const runtimeFailures = captureRuntimeFailures(page)
  await installQaAlphaBootstrap(page)
  await page.clock.install({ time: new Date('2026-07-14T12:00:00Z') })
  await page.goto('/')
  const ranked = page.getByRole('button', { name: /Ranked alpha/ })
  await expect(ranked).toHaveAttribute('aria-pressed', 'true')
  await selectPractice(page)

  const probe = await createChromiumMemoryProbe(page)
  const samples: MemorySample[] = []
  try {
    for (let round = 1; round <= ROUND_COUNT; round += 1) {
      await startRun(page, round > 1)
      await completeRun(page)
      await expect(page.locator('.side-panel .contender-row')).toHaveCount(20)

      if (round % SAMPLE_INTERVAL === 0) {
        const sample = await probe.sample(round)
        samples.push(sample)
        testInfo.annotations.push({
          type: 'memory',
          description: `r${round}: heap ${(sample.jsHeapUsedBytes / MIB).toFixed(1)} MiB, nodes ${sample.nodes}, listeners ${sample.jsEventListeners}`,
        })
      }
    }

    await expect(page.locator('.proof-copy')).toContainText(/verified locally|unranked/)
    await expect(page.getByRole('button', { name: 'Run it back' })).toBeEnabled()
    expect(runtimeFailures).toEqual([])
    const queuedTelemetry = await telemetryCount(page)
    expect(queuedTelemetry).toBeGreaterThanOrEqual(0)
    expect(queuedTelemetry).toBeLessThanOrEqual(500)

    expect(samples).toHaveLength(ROUND_COUNT / SAMPLE_INTERVAL)
    const warm = samples.slice(0, 3)
    const tail = samples.slice(-5)
    const warmHeap = median(warm.map((sample) => sample.jsHeapUsedBytes))
    const tailHeap = median(tail.slice(-3).map((sample) => sample.jsHeapUsedBytes))
    const allowedHeapGrowth = Math.max(16 * MIB, warmHeap * 0.75)
    const heapSlope = linearSlope(tail, (sample) => sample.jsHeapUsedBytes)
    const nodeSlope = linearSlope(tail, (sample) => sample.nodes)
    const listenerSlope = linearSlope(tail, (sample) => sample.jsEventListeners)

    expect(
      tailHeap - warmHeap,
      `forced-GC median heap grew from ${(warmHeap / MIB).toFixed(1)} MiB to ${(tailHeap / MIB).toFixed(1)} MiB`,
    ).toBeLessThan(allowedHeapGrowth)
    expect(
      heapSlope,
      `late forced-GC heap slope was ${(heapSlope / 1024).toFixed(1)} KiB/round`,
    ).toBeLessThan(384 * 1024)
    expect(nodeSlope, `late DOM node slope was ${nodeSlope.toFixed(1)} nodes/round`)
      .toBeLessThan(12)
    expect(listenerSlope, `late listener slope was ${listenerSlope.toFixed(1)} listeners/round`)
      .toBeLessThan(8)
    expect(samples.at(-1)!.documents - samples[0]!.documents).toBeLessThanOrEqual(2)

    await testInfo.attach('soak-memory-report.json', {
      body: Buffer.from(JSON.stringify({
        rounds: ROUND_COUNT,
        sampleInterval: SAMPLE_INTERVAL,
        warmHeap,
        tailHeap,
        allowedHeapGrowth,
        heapSlopeBytesPerRound: heapSlope,
        nodeSlopePerRound: nodeSlope,
        listenerSlopePerRound: listenerSlope,
        queuedTelemetry,
        samples,
      }, null, 2)),
      contentType: 'application/json',
    })
  } finally {
    await probe.close()
  }
})
