import { expect, type Page, type Response } from '@playwright/test'

export function isRoundCreateResponse(response: Response) {
  return response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/solo-rounds'
}

export function waitForRoundCreate(page: Page) {
  return page.waitForResponse(isRoundCreateResponse)
}

export async function openRankedLobby(page: Page) {
  await page.goto('/')
  const rankedMode = page.getByRole('button', { name: /Ranked alpha/i })
  if (await rankedMode.getAttribute('aria-pressed') !== 'true') await rankedMode.click()
  await expect(page.getByText(/anonymous session ready/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.phase-readout strong')).toHaveText('Solo survival')
}

export async function expectCommittedRankedRound(page: Page) {
  await expect(page.locator('.mode-chip--ranked')).toBeVisible()
  await expect(page.locator('.mode-chip--practice')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming', {
    timeout: 15_000,
  })
  await expect(page.getByText(/Proof [0-9a-f]{12}/)).toBeVisible()
}
