import { expect, test, type Page } from '@playwright/test'
import { performance } from 'node:perf_hooks'

import { captureRuntimeFailures } from './helpers'

const INTERACTION_TARGET_MS = 2_000
const CONTROLLED_FAST_3G = {
  name: 'Chromium Fast 3G',
  latencyMs: 150,
  downloadKbps: 1_600,
  uploadKbps: 750,
  connectionType: 'cellular3g',
} as const

interface ResourceMetric {
  name: string
  initiatorType: string
  duration: number
  transferSize: number
  encodedBodySize: number
}

async function resourceMetrics(page: Page): Promise<ResourceMetric[]> {
  return page.evaluate(() => performance.getEntriesByType('resource').map((entry) => {
    const resource = entry as PerformanceResourceTiming
    return {
      name: resource.name,
      initiatorType: resource.initiatorType,
      duration: resource.duration,
      transferSize: resource.transferSize,
      encodedBodySize: resource.encodedBodySize,
    }
  }))
}

async function warmImmutableGameAssets(page: Page): Promise<string[]> {
  await page.goto('/')
  await expect(page.getByText(/anonymous session ready/i)).toBeVisible({ timeout: 15_000 })
  const practice = page.getByRole('button', { name: /Practice/ })
  await practice.click()
  await expect(practice).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Quick run' }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')

  const warmed = (await resourceMetrics(page))
    .map((entry) => entry.name)
    .filter((name) => new URL(name).pathname.startsWith('/assets/'))
  expect(
    warmed.some((name) => new URL(name).pathname.endsWith('.wasm')),
    'the warm-up must compile the real SolMath WASM before timing ranked startup',
  ).toBe(true)

  // A fresh document keeps the production HTTP cache but resets application
  // state, so the measured action starts from the real ranked home screen.
  await page.goto('/')
  await expect(page.getByRole('button', { name: /Ranked alpha/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByText(/anonymous session ready/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Ranked run' })).toBeEnabled()
  await expect(page.locator('.phase-readout strong')).toHaveText('Solo survival')
  return warmed
}

test('warm-cache ranked Quick Run enters its first phase within the mobile budget', async ({ page }, testInfo) => {
  test.skip(
    process.env.STRIKEFALL_E2E_RANKED !== '1'
      || testInfo.project.name !== 'ranked-mobile-network',
    'Run explicitly against the production-shaped Compose stack in Chromium.',
  )
  test.setTimeout(60_000)
  const runtimeFailures = captureRuntimeFailures(page)
  const warmedAssets = await warmImmutableGameAssets(page)
  await page.evaluate(() => performance.clearResourceTimings())

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false })
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: CONTROLLED_FAST_3G.latencyMs,
    downloadThroughput: CONTROLLED_FAST_3G.downloadKbps * 1_024 / 8,
    uploadThroughput: CONTROLLED_FAST_3G.uploadKbps * 1_024 / 8,
    connectionType: CONTROLLED_FAST_3G.connectionType,
  })

  try {
    const rankedRun = page.getByRole('button', { name: 'Ranked run' })
    const createdRound = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/solo-rounds'
    ))
    const startedAt = performance.now()
    await rankedRun.click()
    const response = await createdRound
    expect(response.status()).toBe(201)
    await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
    await expect(page.getByText(/Proof [0-9a-f]{12}/)).toBeVisible()
    const interactionMs = performance.now() - startedAt

    expect(await response.finished(), 'ranked create response should finish cleanly').toBeNull()
    const requestTiming = response.request().timing()
    const measuredResources = await resourceMetrics(page)
    const coldAssetTransfers = measuredResources.filter((entry) => (
      new URL(entry.name).pathname.startsWith('/assets/') && entry.transferSize > 0
    ))
    const metrics = {
      scope: 'controlled-warm-cache-browser-emulation',
      network: CONTROLLED_FAST_3G,
      interactionTargetMs: INTERACTION_TARGET_MS,
      interactionMs: Number(interactionMs.toFixed(2)),
      emulatedApiTransportMs: Number(requestTiming.responseEnd.toFixed(2)),
      createResponseBytes: (await response.body()).byteLength,
      warmedAssetCount: new Set(warmedAssets).size,
      coldAssetTransferCount: coldAssetTransfers.length,
      coldAssetTransferBytes: coldAssetTransfers.reduce(
        (total, entry) => total + entry.transferSize,
        0,
      ),
      apiServerBudget: {
        targetMs: 300,
        evidenceCommand: 'npm run test:performance:api',
        includedInInteractionAssertion: false,
      },
      limitation: 'Controlled Chromium shaping is not real-radio or physical-device evidence.',
    }

    testInfo.annotations.push({
      type: 'performance',
      description: JSON.stringify(metrics),
    })
    await testInfo.attach('ranked-mobile-network-metrics.json', {
      body: Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`),
      contentType: 'application/json',
    })
    console.log(`Strikefall ranked mobile performance: ${JSON.stringify(metrics)}`)

    expect(
      coldAssetTransfers,
      'timed interaction must not include a cold JavaScript, CSS, or WASM transfer',
    ).toEqual([])
    expect(
      interactionMs,
      'warm-cache ranked Quick Run should enter its committed deck phase in under two seconds',
    ).toBeLessThan(INTERACTION_TARGET_MS)
    expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
  } finally {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: 'none',
    }).catch(() => {})
    await cdp.detach().catch(() => {})
  }
})
