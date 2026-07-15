import { expect, test } from '@playwright/test'

import {
  advance,
  assertNoHorizontalOverflow,
  captureRuntimeFailures,
  installDeterministicBrowser,
  PHASE_MS,
  reachBattle,
  reachPlacement,
  screenshot,
} from './helpers'

type MotionPreference = 'full' | 'reduced'

function preferences(motion: MotionPreference) {
  return {
    version: 1,
    motion,
    mutedFlash: false,
    telemetry: 'local',
    breakReminderRounds: 0,
    onboardingComplete: true,
  }
}

async function expectCompactHeaderVisible(page: import('@playwright/test').Page) {
  const geometry = await page.evaluate(() => ({
    scrollY: window.scrollY,
    topbar: document.querySelector<HTMLElement>('.topbar')?.getBoundingClientRect().toJSON() ?? null,
    phase: document.querySelector<HTMLElement>('.status-card--phase')?.getBoundingClientRect().toJSON() ?? null,
  }))
  expect(geometry.topbar, `missing topbar: ${JSON.stringify(geometry)}`).not.toBeNull()
  expect(geometry.phase, `missing phase card: ${JSON.stringify(geometry)}`).not.toBeNull()
  expect.soft(geometry.topbar!.top, `topbar clipped: ${JSON.stringify(geometry)}`).toBeGreaterThanOrEqual(0)
  expect.soft(geometry.topbar!.left, `topbar clipped: ${JSON.stringify(geometry)}`).toBeGreaterThanOrEqual(0)
  expect.soft(geometry.phase!.left, `phase card clipped: ${JSON.stringify(geometry)}`).toBeGreaterThanOrEqual(0)
}

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowser(page)
  await page.addInitScript((initialPreferences) => {
    if (sessionStorage.getItem('strikefall.visual-matrix.initialized') === '1') return
    localStorage.setItem(
      'strikefall.preferences.v1',
      JSON.stringify(initialPreferences),
    )
    sessionStorage.setItem('strikefall.visual-matrix.initialized', '1')
  }, preferences('full'))
})

test('full and reduced motion both complete responsive game journeys', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const runtimeFailures = captureRuntimeFailures(page)
  await page.goto('/')
  await expect(page.locator('.app-shell')).not.toHaveClass(/app-shell--reduced-motion/)

  await page.getByRole('button', { name: 'Quick run' }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await reachPlacement(page)
  await assertNoHorizontalOverflow(page)
  await page.waitForTimeout(400)
  await expectCompactHeaderVisible(page)
  await screenshot(page, testInfo, 'visual-full-placement.png', false)

  await reachBattle(page)
  await advance(page, 8_000)
  await assertNoHorizontalOverflow(page)
  await page.waitForTimeout(400)
  await expectCompactHeaderVisible(page)
  await screenshot(page, testInfo, 'visual-full-battle.png', false)
  await advance(page, PHASE_MS.battle)
  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete')
  await page.getByRole('button', { name: 'Share result' }).click()
  const fullShare = page.getByRole('dialog', { name: 'Frame the strike' })
  await expect(fullShare).toBeVisible()
  await expect(fullShare).not.toContainText('Reduced motion is on')
  await screenshot(page, testInfo, 'visual-full-share.png', false)
  await fullShare.getByRole('button', { name: 'Back to result' }).click()
  await expect(fullShare).toBeHidden()

  await page.getByRole('button', { name: 'Player and privacy settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Player & privacy' })
  await settings.getByLabel('Motion').selectOption('reduced')
  await expect(settings.getByLabel('Motion')).toHaveValue('reduced')
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await page.reload()
  await expect(page.locator('.app-shell')).toHaveClass(/app-shell--reduced-motion/)

  const compactLobby = page.getByRole('button', { name: /9 bots, Fast cast/i })
  await compactLobby.click()
  await page.getByRole('button', { name: 'Quick run' }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await page.getByRole('button', { name: 'Pause practice round' }).click()
  await expect(page.locator('.phase-clock')).toHaveText('PAUSED')
  await page.getByRole('button', { name: 'Resume practice round' }).click()
  await reachPlacement(page)
  await assertNoHorizontalOverflow(page)
  await screenshot(page, testInfo, 'visual-reduced-placement.png', false)

  await reachBattle(page)
  await advance(page, 8_000)
  await assertNoHorizontalOverflow(page)
  await screenshot(page, testInfo, 'visual-reduced-battle.png', false)
  await advance(page, PHASE_MS.battle)
  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete')
  await page.getByRole('button', { name: 'Share result' }).click()
  const reducedShare = page.getByRole('dialog', { name: 'Frame the strike' })
  await expect(reducedShare).toContainText('Reduced motion is on')
  await screenshot(page, testInfo, 'visual-reduced-share.png', false)
  await assertNoHorizontalOverflow(page)

  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})
