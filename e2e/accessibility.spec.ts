import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

import {
  installDeterministicBrowser,
  reachBattle,
  reachPlacement,
} from './helpers'
import {
  completeRun,
  installQaAlphaBootstrap,
  selectPractice,
  startRun,
} from './qa/helpers'

const WCAG_AA_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  // axe-core 4.12 exposes no `wcag22a` tag; applicable Level A rules retain
  // their base `wcag2a`/`wcag21a` tags, while 2.2-specific AA uses this tag.
  'wcag22aa',
] as const

const RANKED_CONFIGURED = Boolean(process.env.VITE_ROUND_API_URL?.trim())

interface AxeViolationNode {
  readonly target: unknown
  readonly html: string
  readonly failureSummary?: string
}

interface AxeViolation {
  readonly id: string
  readonly impact?: string | null
  readonly help: string
  readonly helpUrl: string
  readonly nodes: readonly AxeViolationNode[]
}

function violationReport(state: string, violations: readonly AxeViolation[]): string {
  if (violations.length === 0) return `${state}: no WCAG A/AA violations`
  const details = violations.flatMap((violation) => [
    `${violation.id} [${violation.impact ?? 'impact unknown'}] ${violation.help}`,
    `  ${violation.helpUrl}`,
    ...violation.nodes.flatMap((node, index) => [
      `  node ${index + 1}: ${JSON.stringify(node.target)}`,
      `    ${node.html.replace(/\s+/g, ' ').trim()}`,
      ...(node.failureSummary
        ? [`    ${node.failureSummary.replace(/\s+/g, ' ').trim()}`]
        : []),
    ]),
  ])
  return `${state}: ${violations.length} axe violation(s)\n${details.join('\n')}`
}

async function expectWcagAa(
  page: Page,
  testInfo: TestInfo,
  state: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags([...WCAG_AA_TAGS])
    .analyze()
  const violations = results.violations as readonly AxeViolation[]
  await testInfo.attach(`axe-${state}.json`, {
    body: JSON.stringify({
      state,
      tags: WCAG_AA_TAGS,
      violations,
    }, null, 2),
    contentType: 'application/json',
  })
  expect.soft(violations.length, violationReport(state, violations)).toBe(0)
}

async function prepareBrowser(page: Page): Promise<void> {
  await installQaAlphaBootstrap(page)
  await page.addInitScript(() => {
    localStorage.setItem('strikefall.preferences.v1', JSON.stringify({
      version: 1,
      motion: 'reduced',
      mutedFlash: true,
      telemetry: 'local',
      breakReminderRounds: 0,
      onboardingComplete: true,
    }))
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(Navigator.prototype, 'canShare', {
      configurable: true,
      value: undefined,
    })
  })
}

async function openLobby(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Plant outside/i })).toBeVisible()
  if (RANKED_CONFIGURED) {
    await expect(page.getByText(/anonymous session ready/i)).toBeVisible()
  }
}

test.describe('WCAG A/AA accessibility regression', () => {
  test('landing and lobby', async ({ page }, testInfo) => {
    await prepareBrowser(page)
    await openLobby(page)

    await expectWcagAa(page, testInfo, 'landing-lobby')
  })

  test('help, settings, lobby, and metrics dialogs', async ({ page }, testInfo) => {
    await prepareBrowser(page)
    await openLobby(page)

    const dialogs = [
      {
        trigger: 'How to play',
        name: 'How to survive',
        close: 'Close rules',
        state: 'help-dialog',
      },
      {
        trigger: 'Player and privacy settings',
        name: 'Player & privacy',
        close: 'Close settings',
        state: 'settings-dialog',
      },
      {
        trigger: 'Open lobby and strike feed',
        name: 'Live lobby',
        close: 'Close lobby',
        state: 'live-lobby-dialog',
      },
      {
        trigger: 'Open alpha metrics dashboard',
        name: 'Closed alpha metrics',
        close: 'Close alpha metrics',
        state: 'metrics-dialog',
      },
    ] as const

    for (const dialogCase of dialogs) {
      await page.getByRole('button', { name: dialogCase.trigger }).click()
      const dialog = page.getByRole('dialog', { name: dialogCase.name })
      await expect(dialog).toBeVisible()
      await expectWcagAa(page, testInfo, dialogCase.state)
      await dialog.getByRole('button', { name: dialogCase.close }).click()
      await expect(dialog).toBeHidden()
    }
  })

  test('placement and active battle', async ({ page }, testInfo) => {
    await installDeterministicBrowser(page)
    await prepareBrowser(page)
    await openLobby(page)
    await selectPractice(page)
    await startRun(page)
    await reachPlacement(page)

    await expectWcagAa(page, testInfo, 'active-placement')

    await reachBattle(page)
    await expect(page.locator('.phase-readout strong')).toHaveText('Line is live')
    await expectWcagAa(page, testInfo, 'active-battle')
  })

  test('result and share dialog', async ({ page }, testInfo) => {
    await installDeterministicBrowser(page)
    await prepareBrowser(page)
    await openLobby(page)
    await selectPractice(page)
    await startRun(page)
    await completeRun(page)

    await expectWcagAa(page, testInfo, 'result')

    await page.getByRole('button', { name: 'Share result' }).click()
    const share = page.getByRole('dialog', { name: 'Frame the strike' })
    await expect(share).toBeVisible()
    await expectWcagAa(page, testInfo, 'share-dialog')

    await share.getByRole('button', { name: 'Back to result' }).click()
    await expect(share).toBeHidden()
    await page.getByRole('button', { name: 'Watch replay' }).click()
    const replay = page.getByRole('dialog', { name: 'Local round replay' })
    await expect(replay).toBeVisible()
    await expectWcagAa(page, testInfo, 'local-replay-dialog')
  })

  test('offline practice lobby', async ({ page }, testInfo) => {
    await prepareBrowser(page)
    await openLobby(page)
    await selectPractice(page)

    await page.context().setOffline(true)
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false)
    const ranked = page.getByRole('button', { name: /Ranked alpha/i })
    await expect(ranked).toBeDisabled()
    await expect(ranked).toHaveAttribute('aria-describedby', 'ranked-mode-availability')
    await expect(page.getByText('Ranked needs a connection. Practice still works offline.')).toBeVisible()

    await expectWcagAa(page, testInfo, 'offline-practice')
  })

  test('public replay invalid-link recovery honours stored reduced motion', async ({ page }, testInfo) => {
    await prepareBrowser(page)
    await page.goto('/replay/not-a-ranked-replay-id')

    await expect(page.locator('.replay-page')).toHaveClass(/app-shell--reduced-motion/)
    await expect(page.getByRole('heading', { level: 1, name: 'This replay ID isn’t valid' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Back to Strikefall' })).toBeEnabled()
    await expectWcagAa(page, testInfo, 'public-replay-invalid-link')
  })

  test('scoring-engine error and retry', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'WebAssembly', {
        configurable: true,
        value: undefined,
      })
    })
    await prepareBrowser(page)
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Exact scoring is unavailable' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry SolMath' })).toBeEnabled()
    await expectWcagAa(page, testInfo, 'scoring-engine-error')
  })

  test('ranked-ready and service-fallback states', async ({ page }, testInfo) => {
    test.skip(!RANKED_CONFIGURED, 'Dedicated accessibility lane enables the ranked client.')
    await installDeterministicBrowser(page)
    await prepareBrowser(page)
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
    await openLobby(page)

    const ranked = page.getByRole('button', { name: /Ranked alpha/i })
    if (await ranked.getAttribute('aria-pressed') !== 'true') await ranked.click()
    await expect(page.getByText(/anonymous session ready/i)).toBeVisible()
    await expectWcagAa(page, testInfo, 'ranked-ready')

    await page.getByRole('button', { name: 'Ranked run' }).click()
    const fallback = page.getByRole('alert')
    await expect(fallback).toContainText('Playing locally.')
    await expect(fallback).toContainText('Ranked maintenance window.')
    await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
    await expectWcagAa(page, testInfo, 'ranked-service-fallback')
  })
})
