import { expect, test } from '@playwright/test'

import { assertNoHorizontalOverflow, captureRuntimeFailures } from './helpers'
import {
  expectCommittedRankedRound,
  openRankedLobby,
  waitForRoundCreate,
} from './ranked-helpers'

test('ranked alpha verifies a public replay and labels service fallback', async ({ page }, testInfo) => {
  test.skip(
    process.env.STRIKEFALL_E2E_RANKED !== '1' || testInfo.project.name !== 'desktop-1280',
    'Run explicitly against the production-shaped Compose stack.',
  )
  // The server preserves the 60-second game clock while durable Postgres
  // lifecycle writes can finish later on a contended CI runner.
  test.setTimeout(240_000)
  const runtimeFailures = captureRuntimeFailures(page)

  await openRankedLobby(page)

  const rankedRun = page.getByRole('button', { name: 'Ranked run' })
  await expect(rankedRun).toBeEnabled()
  const createdRound = waitForRoundCreate(page)
  await rankedRun.click()
  expect((await createdRound).status()).toBe(201)
  await expectCommittedRankedRound(page)
  await expect(page.locator('.phase-readout strong')).toHaveText('Read the tape', { timeout: 8_000 })
  await expect(page.getByLabel('Flag distance')).toBeVisible({ timeout: 18_000 })

  const distance = page.getByLabel('Flag distance')
  const initialDistance = await distance.inputValue()
  await distance.press('End')
  expect(await distance.inputValue()).not.toBe(initialDistance)
  await page.getByRole('button', { name: /Below/ }).click()
  await expect(page.getByRole('button', { name: /Below/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/BOT jockeyed/).first()).toBeVisible({ timeout: 11_000 })
  await expect(page.getByText(/candidates · utility/).first()).toBeVisible()
  await assertNoHorizontalOverflow(page)

  const phase = page.locator('.phase-readout strong')
  await expect(phase).toHaveText('Positions locked', { timeout: 18_000 })
  await expect(page.locator('.phase-clock')).toContainText(/0:0[12]/)
  await page.waitForTimeout(900)
  await expect(phase).toHaveText('Positions locked')
  await expect(phase).toHaveText('Line is live', { timeout: 2_500 })
  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete', { timeout: 120_000 })
  await expect(page.locator('.proof-copy')).toContainText('passed every signature', { timeout: 20_000 })

  const viewProof = page.getByRole('button', { name: 'View proof' })
  await expect(viewProof).toBeVisible({ timeout: 15_000 })
  await viewProof.click()
  await expect(page).toHaveURL(/\/replay\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: 'Verified in this browser' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/browser checks/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Bot decision audit' })).toBeVisible()
  await expect(page.getByText(/timed moves/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Share verified replay' })).toBeVisible()
  await assertNoHorizontalOverflow(page)

  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])

  await page.route('**/api/v1/solo-rounds', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'maintenance',
        message: 'Ranked maintenance window.',
        retryAfterMs: null,
      }),
    })
  })

  await openRankedLobby(page)
  await page.getByRole('button', { name: 'Ranked run' }).click()

  const fallback = page.getByRole('alert')
  await expect(fallback).toContainText('Playing locally.')
  await expect(fallback).toContainText('Ranked maintenance window.')
  await expect(fallback).toContainText('will not enter the leaderboard')
  await expect(page.locator('.mode-chip--practice')).toBeVisible()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming', { timeout: 15_000 })
  await assertNoHorizontalOverflow(page)

  const unexpectedFailures = runtimeFailures.filter((failure) => (
    !failure.includes('503 (Service Unavailable)')
  ))
  expect.soft(unexpectedFailures, unexpectedFailures.join('\n')).toEqual([])
})
