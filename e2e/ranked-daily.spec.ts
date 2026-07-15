import { expect, test, type Page, type TestInfo } from '@playwright/test'

import { assertNoHorizontalOverflow, captureRuntimeFailures } from './helpers'
import {
  expectCommittedRankedRound,
  openRankedLobby,
  waitForRoundCreate,
} from './ranked-helpers'

interface DailyCreateEvidence {
  featuredName: string
  request: {
    deckId?: string
    deckVersion?: number
  }
  response: {
    roundId: string
    commitment: string
    deck: {
      id: string
      version: number
      displayName: string
    }
  }
}

async function launchRankedDaily(page: Page): Promise<DailyCreateEvidence> {
  const daily = page.locator('.daily-launch')
  await expect(daily).toBeVisible()
  await expect(daily).toContainText('Today’s Daily Deck')
  await expect(daily).toContainText('fresh unseen path')
  const featuredName = (await daily.locator('.daily-launch__copy strong').textContent())?.trim()
  expect(featuredName).toBeTruthy()

  const responsePromise = waitForRoundCreate(page)
  await daily.click()
  const response = await responsePromise
  expect(response.status()).toBe(201)
  const request = response.request().postDataJSON() as DailyCreateEvidence['request']
  const created = await response.json() as DailyCreateEvidence['response']

  expect(request).toEqual({
    deckId: created.deck.id,
    deckVersion: 3,
  })
  expect(created.deck).toMatchObject({
    version: 3,
    displayName: featuredName,
  })
  expect(created.roundId).toMatch(/^[0-9a-f-]{36}$/)
  expect(created.commitment).toMatch(/^[0-9a-f]{64}$/)
  await expectCommittedRankedRound(page)
  await expect(page.locator('.deck-reveal h1')).toHaveText(featuredName!)
  await assertNoHorizontalOverflow(page)

  return { featuredName: featuredName!, request, response: created }
}

async function attachEvidence(
  testInfo: TestInfo,
  first: DailyCreateEvidence,
  second: DailyCreateEvidence,
) {
  const evidence = {
    scope: 'production-compose-ranked-daily',
    featuredDeck: {
      id: first.response.deck.id,
      version: first.response.deck.version,
      displayName: first.featuredName,
    },
    attempts: [first, second].map(({ request, response }) => ({
      request,
      status: 201,
      roundId: response.roundId,
      commitment: response.commitment,
    })),
    assertions: {
      authoritativeDeckMatched: true,
      remainedRanked: true,
      freshRoundIdentity: true,
      freshCommitment: true,
      replayVerifiedInBrowser: true,
    },
  }
  await testInfo.attach('ranked-daily-v3-evidence.json', {
    body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
    contentType: 'application/json',
  })
}

test('ranked Daily Deck requests v3, stays authoritative, and refreshes hidden proof', async ({ page }, testInfo) => {
  test.skip(
    process.env.STRIKEFALL_E2E_RANKED !== '1' || testInfo.project.name !== 'desktop-1280',
    'Run explicitly against the production-shaped Compose stack.',
  )
  // The second attempt resolves on the authoritative wall clock while the
  // first continues independently in the recovery worker.
  test.setTimeout(240_000)
  const runtimeFailures = captureRuntimeFailures(page)

  await openRankedLobby(page)
  const first = await launchRankedDaily(page)

  // Reloading closes only the browser controller. The server keeps advancing
  // the first attempt, while the persisted anonymous session starts another
  // attempt against the same UTC Daily identity.
  await openRankedLobby(page)
  const second = await launchRankedDaily(page)

  expect(second.featuredName).toBe(first.featuredName)
  expect(second.request).toEqual(first.request)
  expect(second.response.deck).toEqual(first.response.deck)
  expect(second.response.roundId).not.toBe(first.response.roundId)
  expect(second.response.commitment).not.toBe(first.response.commitment)

  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete', {
    timeout: 130_000,
  })
  await expect(page.locator('.proof-copy')).toContainText('passed every signature', {
    timeout: 20_000,
  })
  const viewProof = page.getByRole('button', { name: 'View proof' })
  await expect(viewProof).toBeVisible({ timeout: 15_000 })
  await viewProof.click()
  await expect(page).toHaveURL(new RegExp(`/replay/${second.response.roundId}$`))
  await expect(page.getByRole('heading', { name: 'Verified in this browser' })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText(`${second.featuredName} · deck v3`)).toBeVisible()
  await expect(page.getByText(/browser checks/)).toBeVisible()
  const playFresh = page.getByRole('button', { name: 'Play a fresh round' })
  await expect(playFresh).toBeVisible()
  const freshResponsePromise = waitForRoundCreate(page)
  await playFresh.click()
  const freshResponse = await freshResponsePromise
  expect(freshResponse.status()).toBe(201)
  const fresh = await freshResponse.json() as DailyCreateEvidence['response']
  expect(fresh.roundId).not.toBe(second.response.roundId)
  expect(fresh.commitment).not.toBe(second.response.commitment)
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await expect(page.locator('.deck-reveal')).toBeVisible()
  await assertNoHorizontalOverflow(page)
  await attachEvidence(testInfo, first, second)

  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})
