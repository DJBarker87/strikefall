import { expect, test, type Page } from '@playwright/test'

import {
  captureRuntimeFailures,
  installDeterministicBrowser,
  reachBattle,
  reachPlacement,
} from './helpers'

const PROFILE_KEY = 'strikefall.profile.v1'
const EXPERIMENT_KEY = 'strikefall.experiments.v1'

type VariantSet = {
  escape: 'absent' | 'midpoint'
  risk: 'probability' | 'danger-band'
}

async function installVariants(page: Page, variants: VariantSet) {
  await page.goto('/')
  await expect.poll(() => page.evaluate((profileKey) => {
    const encoded = localStorage.getItem(profileKey)
    if (!encoded) return false
    try {
      const profile = JSON.parse(encoded) as { id?: unknown } | null
      return typeof profile?.id === 'string'
    } catch {
      return false
    }
  }, PROFILE_KEY), {
    message: 'anonymous Strikefall profile bootstrap',
  }).toBe(true)
  const subjectId = await page.evaluate((profileKey) => {
    const profile = JSON.parse(localStorage.getItem(profileKey) ?? 'null') as { id?: unknown } | null
    if (!profile || typeof profile.id !== 'string') throw new Error('Strikefall profile was not created')
    return profile.id
  }, PROFILE_KEY)
  await page.evaluate(({ key, subject, selected }) => {
    const assignedAt = new Date().toISOString()
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      subjectId: subject,
      assignments: [
        { experimentId: 'escape', experimentVersion: 2, variant: selected.escape, assignedAt },
        { experimentId: 'risk-display', experimentVersion: 2, variant: selected.risk, assignedAt },
      ],
    }))
  }, { key: EXPERIMENT_KEY, subject: subjectId, selected: variants })
  await page.reload()
}

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowser(page)
})

test('public control treatments change risk copy while Escape stays available without a deck cohort', async ({ page }) => {
  const failures = captureRuntimeFailures(page)
  await installVariants(page, { escape: 'absent', risk: 'probability' })

  await page.getByRole('button', { name: 'Quick run' }).click()
  await reachPlacement(page)
  const risk = page.locator('[data-risk-display]')
  await expect(risk).toHaveAttribute('data-risk-display', 'probability')
  await expect(risk).toContainText('% no-touch')
  await reachBattle(page)
  // Escape is core to practice and no longer gated by the local experiment.
  await expect(page.locator('.escape-dock')).toBeVisible()
  expect(failures).toEqual([])
})

test('public active treatments change risk copy and the Escape rule without a deck cohort', async ({ page }) => {
  const failures = captureRuntimeFailures(page)
  await installVariants(page, {
    escape: 'midpoint',
    risk: 'danger-band',
  })

  await page.getByRole('button', { name: 'Quick run' }).click()
  await reachPlacement(page)
  const risk = page.locator('[data-risk-display]')
  await expect(risk).toHaveAttribute('data-risk-display', 'danger-band')
  await expect(risk).toContainText(/EXTREME|HOT|TENSE|STEADY|SHELTERED/)
  await expect(risk).not.toContainText('% no-touch')
  await reachBattle(page)
  await expect(page.locator('.escape-dock')).toBeVisible()
  expect(failures).toEqual([])
})
