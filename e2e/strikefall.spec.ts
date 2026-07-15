import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

import {
  advance,
  artifactPath,
  assertNoHorizontalOverflow,
  captureRuntimeFailures,
  expectContainedInArena,
  installDeterministicBrowser,
  PHASE_MS,
  reachBattle,
  reachPlacement,
  screenshot,
} from './helpers'

function pngDimensions(path: string): readonly [number, number] {
  const bytes = readFileSync(path)
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

async function expectMinimumTouchTargets(
  scope: import('@playwright/test').Locator,
  selector: string,
  label: string,
) {
  const undersized = await scope.locator(selector).evaluateAll((elements) => elements
    .map((element) => {
      const box = element.getBoundingClientRect()
      return {
        name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
        width: box.width,
        height: box.height,
      }
    })
    .filter(({ width, height }) => width < 40 || height < 40))
  expect(undersized, `${label} touch targets must be at least 40×40 px`).toEqual([])
}

async function expectInsideViewport(
  locator: import('@playwright/test').Locator,
  width: number,
  height: number,
  label: string,
) {
  const box = await locator.boundingBox()
  expect(box, `${label} must render`).not.toBeNull()
  expect(box!.x, `${label} clipped on the left`).toBeGreaterThanOrEqual(0)
  expect(box!.y, `${label} clipped at the top`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${label} clipped on the right`).toBeLessThanOrEqual(width)
  expect(box!.y + box!.height, `${label} clipped at the bottom`).toBeLessThanOrEqual(height)
}

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowser(page)
})

test('home screen is usable and visually contained', async ({ page }, testInfo) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.goto('/')

  await expect(page.getByText('Strikefall', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: /Plant outside/i })).toBeVisible()
  await expect(page.locator('.phase-clock')).toHaveText('READY')
  const quickRun = page.getByRole('button', { name: 'Quick run' })
  await expect(quickRun).toBeVisible()
  await expect(page.getByText(/place where 19 bots will not/i)).toBeVisible()
  const clippedModeLabels = await page.locator('.play-mode-selector small').evaluateAll(
    (labels) => labels
      .filter((label) => label.scrollWidth > label.clientWidth)
      .map((label) => label.textContent),
  )
  expect(clippedModeLabels, 'play-mode details must remain readable without ellipsis').toEqual([])
  await assertNoHorizontalOverflow(page)

  const buttonBox = await quickRun.boundingBox()
  expect(buttonBox, 'Quick run must have a rendered hit target').not.toBeNull()
  expect(buttonBox!.height).toBeGreaterThanOrEqual(44)
  expect(buttonBox!.y).toBeGreaterThanOrEqual(0)
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(testInfo.project.use.viewport!.height)

  const onboarding = page.locator('.onboarding-prompt')
  await expect(onboarding).toContainText('New here? Read the 30-second briefing')
  await onboarding.click()
  const dialog = page.getByRole('dialog', { name: 'How to survive' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(
    'Plant one flag outside the line. One touch destroys it. The most points at the end wins the round.',
  )
  await expect(dialog.getByText('Find clean air.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(onboarding).toBeFocused()
  await expect(onboarding).toContainText('Replay the 30-second briefing')

  const helpTrigger = page.getByRole('button', { name: 'How to play' })
  await helpTrigger.click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Drag in the arena or use the slider.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(helpTrigger).toBeFocused()
  await helpTrigger.click()
  await expect(dialog).toBeVisible()
  await page.getByRole('button', { name: 'Close rules' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'Player and privacy settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Player & privacy' })
  await expect(settings).toBeVisible()
  await expect(settings.getByText('Nothing financial')).toBeVisible()
  await expect(settings.getByLabel('Telemetry')).toHaveValue('local')
  await settings.getByLabel('Callsign').fill('x')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings.getByRole('alert')).toHaveText('Callsign must contain at least two characters.')
  await expect(settings.getByLabel('Callsign')).toHaveAttribute('aria-invalid', 'true')
  await settings.getByLabel('Callsign').fill('Night Wick')
  await expect(settings.getByRole('alert')).toBeHidden()
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings.getByRole('status')).toHaveText('Callsign saved.')
  await settings.getByLabel('Lower flash intensity').check()
  await screenshot(page, testInfo, 'settings.png', false)
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(settings).toBeHidden()
  await expect(page.getByText('Night Wick')).toBeVisible()

  await page.getByRole('button', { name: 'Open alpha metrics dashboard' }).click()
  const metrics = page.getByRole('dialog', { name: 'Closed alpha metrics' })
  await expect(metrics).toBeVisible()
  await expect(metrics.getByRole('heading', { name: 'Strikefall alpha signals' })).toBeVisible()
  await expect(metrics.getByText(/Product signals, not verdicts/i)).toBeVisible()
  await expect(metrics.getByText(/No raw paths, seeds, or private identifiers/i)).toBeVisible()
  const metricsGeometry = await metrics.evaluate((dialog) => {
    const header = dialog.querySelector<HTMLElement>('.alpha-dashboard-header')
      ?.getBoundingClientRect()
    const close = dialog.querySelector<HTMLElement>('.metrics-dialog__close')
      ?.getBoundingClientRect()
    return {
      headerRight: header?.right ?? null,
      closeLeft: close?.left ?? null,
    }
  })
  expect(metricsGeometry.headerRight).not.toBeNull()
  expect(metricsGeometry.closeLeft).not.toBeNull()
  expect(
    metricsGeometry.headerRight!,
    `metrics close button overlaps header: ${JSON.stringify(metricsGeometry)}`,
  ).toBeLessThanOrEqual(metricsGeometry.closeLeft!)
  await page.keyboard.press('Escape')
  await expect(metrics).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open alpha metrics dashboard' })).toBeFocused()
  await page.getByRole('button', { name: 'Open alpha metrics dashboard' }).click()
  await expect(metrics).toBeVisible()
  await screenshot(page, testInfo, 'alpha-metrics.png', false)
  await metrics.getByRole('button', { name: 'Close alpha metrics' }).click()
  await expect(metrics).toBeHidden()

  await expectContainedInArena(page, '.hero-panel', 'home hero')
  if (testInfo.project.name === 'mobile-375') {
    const undersizedButtons = await page.locator('button:visible').evaluateAll((buttons) => (
      buttons
        .map((button) => ({
          label: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? 'button',
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
        }))
        .filter(({ width, height }) => width < 40 || height < 40)
    ))
    expect(undersizedButtons, 'visible mobile button targets must be at least 40×40 px').toEqual([])
  }
  if (testInfo.project.name === 'desktop-1280') {
    const pageHeight = await page.evaluate(() => ({
      document: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
    }))
    expect.soft(
      pageHeight.document,
      `desktop lobby panels should scroll internally, not create ${pageHeight.document - pageHeight.viewport}px of empty document`,
    ).toBeLessThanOrEqual(pageHeight.viewport + 8)
  }
  await screenshot(page, testInfo, 'home.png')
  await screenshot(page, testInfo, 'home-viewport.png', false)
  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})

test('minimum-width mobile lobby preserves its core touch controls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-375', 'The minimum-width regression runs once in the mobile project.')
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/')

  await assertNoHorizontalOverflow(page)
  await expect(page.getByRole('button', { name: 'Open alpha metrics dashboard' })).toBeHidden()

  for (const accessibleName of [
    'Open lobby and strike feed',
    'Mute sound',
    'How to play',
    'Player and privacy settings',
  ]) {
    const control = page.getByRole('button', { name: accessibleName })
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box, `${accessibleName} must have a rendered touch target`).not.toBeNull()
    expect(box!.width, `${accessibleName} width`).toBeGreaterThanOrEqual(40)
    expect(box!.height, `${accessibleName} height`).toBeGreaterThanOrEqual(40)
    expect(box!.x, `${accessibleName} clipped on the left`).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width, `${accessibleName} clipped on the right`).toBeLessThanOrEqual(320)
  }

  const briefing = page.locator('.onboarding-prompt')
  await briefing.scrollIntoViewIfNeeded()
  await briefing.click()
  const rules = page.getByRole('dialog', { name: 'How to survive' })
  await expect(rules).toBeVisible()
  await expect(rules).toContainText('One touch destroys it')
  await assertNoHorizontalOverflow(page)
  await page.keyboard.press('Escape')
  await expect(rules).toBeHidden()
  await expect(briefing).toBeFocused()
})

test('minimum-width share and replay dialogs remain operable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-375', 'The minimum-width regression runs once in the mobile project.')
  await page.setViewportSize({ width: 320, height: 568 })
  await page.addInitScript(() => {
    localStorage.setItem('strikefall.preferences.v1', JSON.stringify({
      version: 1,
      motion: 'reduced',
      mutedFlash: true,
      telemetry: 'local',
      breakReminderRounds: 0,
      onboardingComplete: true,
    }))
  })
  await page.goto('/')
  await page.getByRole('button', { name: /9 bots, Fast cast/i }).click()
  await page.getByRole('button', { name: 'Quick run' }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await advance(
    page,
    PHASE_MS.deck + PHASE_MS.approach + PHASE_MS.placement + PHASE_MS.lock + PHASE_MS.battle + 100,
  )
  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete')

  const shareTrigger = page.getByRole('button', { name: 'Share result' })
  await shareTrigger.click()
  const share = page.getByRole('dialog', { name: 'Frame the strike' })
  await expect(share).toBeVisible()
  await expectInsideViewport(share, 320, 568, 'share dialog')
  await assertNoHorizontalOverflow(page)
  await expectMinimumTouchTargets(
    share,
    'button:visible, label:has(input[type="radio"]):visible',
    'minimum-width share dialog',
  )
  await page.keyboard.press('Escape')
  await expect(share).toBeHidden()
  await expect(shareTrigger).toBeFocused()

  const replayTrigger = page.getByRole('button', { name: 'Watch replay' })
  await replayTrigger.click()
  const replay = page.getByRole('dialog', { name: 'Local round replay' })
  await expect(replay).toBeVisible()
  await expectInsideViewport(replay.locator('.local-replay'), 320, 568, 'local replay dialog')
  await assertNoHorizontalOverflow(page)
  await expectMinimumTouchTargets(
    replay,
    'button:visible, input[type="range"]:visible',
    'minimum-width local replay',
  )
  await page.keyboard.press('Escape')
  await expect(replay).toBeHidden()
  await expect(replayTrigger).toBeFocused()
})

test('Daily Deck launches its featured fresh-path deck and exposes mastery', async ({ page }) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.addInitScript(() => {
    const now = '2026-07-14T12:00:00.000Z'
    const deckRecords = ['balanced-tape', 'compression-break', 'opening-rush', 'pulse']
      .map((deckId) => ({
        deckId,
        rounds: 50,
        survived: 20,
        escaped: 10,
        bestScore: 900,
        bestMultiplier: 8,
      }))
    localStorage.setItem('strikefall.profile.v1', JSON.stringify({
      version: 1,
      id: 'anon_001122334455',
      handle: 'Storm Tester',
      createdAt: now,
      updatedAt: now,
      rounds: 200,
      survived: 80,
      escaped: 40,
      eliminated: 80,
      currentStreak: 0,
      bestStreak: 8,
      totalScore: 50_000,
      bestScore: 900,
      bestMultiplier: 8,
      deckRecords,
      rivals: [],
    }))
  })
  await page.goto('/')

  const daily = page.locator('.daily-launch')
  await expect(daily).toBeVisible()
  await expect(daily).toContainText('Today’s Daily Deck')
  await expect(daily).toContainText('fresh unseen path')
  const featuredDeck = (await daily.locator('.daily-launch__copy strong').textContent())?.trim()
  expect(featuredDeck).toBeTruthy()

  await page.getByRole('button', { name: 'Player and privacy settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Player & privacy' })
  await expect(settings.getByRole('heading', { name: 'Make every storm yours' })).toBeVisible()
  await expect(settings.getByText('Points-only cosmetic unlocks.')).toBeVisible()
  await expect(settings.getByRole('progressbar')).toHaveCount(4)
  await expect(settings.getByText('Stormbound frame').first()).toBeVisible()
  await page.getByRole('button', { name: 'Close settings' }).click()

  await daily.click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await expect(page.locator('.deck-reveal h1')).toHaveText(featuredDeck!)
  await expect(page.locator('.arena-canvas')).toHaveAttribute('data-mastery-level', '4')
  await expect(page.getByText(/Proof [0-9a-f]{12}/)).toBeVisible()
  await assertNoHorizontalOverflow(page)
  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})

test('Weekly named-rival challenge records an ordinary fresh round and preserves its rematch deck', async ({ page }) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.goto('/')

  const weekly = page.locator('.weekly-launch')
  await expect(weekly).toBeVisible()
  await expect(weekly).toContainText('Weekly bot rivalry')
  const featuredDeck = (
    (await weekly.locator('.weekly-launch__copy > span').textContent()) ?? ''
  ).split(' · ')[0]?.trim()
  expect(featuredDeck).toBeTruthy()
  await expect(weekly).toHaveAttribute('data-path-policy', 'fresh-per-attempt')
  await expect(weekly).toHaveAttribute('data-launch-policy', 'ordinary-round')

  await weekly.click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await expect(page.locator('.deck-reveal h1')).toHaveText(featuredDeck!)
  await advance(
    page,
    PHASE_MS.deck + PHASE_MS.approach + PHASE_MS.placement + PHASE_MS.lock + PHASE_MS.battle + 100,
  )
  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete')

  const progress = await page.evaluate(() => {
    const raw = localStorage.getItem('strikefall.weekly-progress.v1')
    return raw ? JSON.parse(raw) as { entries?: { challengeId?: string; attempts?: number }[] } : null
  })
  expect(progress?.entries?.[0]?.challengeId).toMatch(/^strikefall-weekly:\d{4}-\d{2}-\d{2}$/)
  expect(progress?.entries?.[0]?.attempts).toBe(1)
  expect(await page.evaluate(() => localStorage.getItem('strikefall.daily-progress.v1'))).toBeNull()

  await page.getByRole('button', { name: 'Run it back' }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await expect(page.locator('.deck-reveal h1')).toHaveText(featuredDeck!)
  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})

test('public Quick Run can launch every deck without manufacturing a deck experiment cohort', async ({ page }) => {
  const runtimeFailures = captureRuntimeFailures(page)
  const expectedDecks = ['Balanced Tape', 'Compression Break', 'Opening Rush', 'Pulse']

  for (let entropy = 0; entropy < expectedDecks.length; entropy += 1) {
    await page.goto('/')
    await page.evaluate((deckByte) => {
      Object.defineProperty(Crypto.prototype, 'getRandomValues', {
        configurable: true,
        value<T extends ArrayBufferView | null>(array: T): T {
          if (array && 'length' in array) {
            const writable = array as unknown as { length: number; [index: number]: number }
            for (let index = 0; index < writable.length; index += 1) {
              writable[index] = writable.length === 1 ? deckByte : (index % 251) + 1
            }
          }
          return array
        },
      })
    }, entropy)

    const assignments = await page.evaluate(() => {
      const raw = localStorage.getItem('strikefall.experiments.v1')
      if (!raw) return []
      return (JSON.parse(raw) as {
        assignments?: { experimentId?: string }[]
      }).assignments?.map((assignment) => assignment.experimentId) ?? []
    })
    expect(assignments).toEqual(['escape', 'risk-display'])

    await page.getByRole('button', { name: 'Quick run' }).click()
    await expect(page.locator('.deck-reveal h1')).toHaveText(expectedDecks[entropy]!)
  }

  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})

test('compact practice lobby pauses exactly and replays its verified result', async ({ page }, testInfo) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.goto('/')

  const compactLobby = page.getByRole('button', { name: /9 bots, Fast cast/i })
  await compactLobby.click()
  await expect(compactLobby).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('9 bots', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Quick run' }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await expect(page.locator('.side-panel .feed-list')).toContainText('9 disclosed bots online')

  await page.getByRole('button', { name: 'Pause practice round' }).click()
  const frozenPhase = await page.locator('.phase-readout strong').textContent()
  const frozenClock = await page.locator('.phase-clock').textContent()
  expect(frozenClock).toBe('PAUSED')
  await advance(page, 10_000)
  await expect(page.locator('.phase-readout strong')).toHaveText(frozenPhase!)
  await expect(page.locator('.phase-clock')).toHaveText('PAUSED')
  await expect(page.getByText('The storm is frozen.')).toBeVisible()

  await page.getByRole('button', { name: 'Resume practice round' }).click()
  await advance(page, PHASE_MS.deck + 20)
  await expect(page.locator('.phase-readout strong')).toHaveText('Read the tape')
  await advance(
    page,
    PHASE_MS.approach + PHASE_MS.placement + PHASE_MS.lock + PHASE_MS.battle + 100,
  )
  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete')
  await expect(page.locator('.result-panel .eyebrow')).toContainText(/Rank #\d+ of 10/)

  const replayTrigger = page.getByRole('button', { name: 'Watch replay' })
  await expect(replayTrigger).toBeVisible()
  await replayTrigger.click()
  const replay = page.getByRole('dialog', { name: 'Local round replay' })
  await expect(replay).toBeVisible()
  await expect(replay.getByRole('heading', { name: 'Replay the strike' })).toBeVisible()
  await expect(replay.getByText(/9 bots · proof/)).toBeVisible()
  await expect(replay.getByRole('button', { name: 'Play replay' })).toBeVisible()
  if (testInfo.project.name === 'mobile-375') {
    await expectMinimumTouchTargets(
      replay,
      'button:visible, input[type="range"]:visible',
      'local replay',
    )
  }
  await screenshot(page, testInfo, 'local-replay.png', false)
  const scrubber = replay.getByLabel('Replay timeline')
  await scrubber.fill('500')
  await expect(replay.locator('.local-replay__scoreboard > div').first().locator('strong')).toHaveText('0:30')
  await replay.getByRole('button', { name: 'Play replay' }).click()
  await advance(page, 1_000)
  await replay.getByRole('button', { name: 'Pause replay' }).click()
  const playedValue = Number(await scrubber.inputValue())
  expect(playedValue).toBeGreaterThan(500)
  const eventJumps = replay.locator('.local-replay__timeline button')
  expect(await eventJumps.count()).toBeGreaterThan(0)
  await eventJumps.last().click()
  await expect(replay.locator('.local-replay__scoreboard > div').first().locator('strong')).toHaveText('1:00')
  await assertNoHorizontalOverflow(page)
  await replay.getByRole('button', { name: 'Close local replay' }).click()
  await expect(replay).toBeHidden()
  await expect(replayTrigger).toBeFocused()

  await page.getByRole('button', { name: 'Run it back' }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await expect(page.locator('.side-panel .feed-list')).toContainText('9 disclosed bots online')
  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})

test('quick run supports placement, elimination, result, and rematch', async ({ page }, testInfo) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: undefined })
    Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, value: undefined })
    localStorage.setItem('strikefall.preferences.v1', JSON.stringify({
      version: 1,
      motion: 'reduced',
      mutedFlash: false,
      telemetry: 'local',
      breakReminderRounds: 0,
      onboardingComplete: true,
    }))
  })
  await page.goto('/')
  await expect(page.getByText('Strikefall', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mute sound' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'How to play' })).toBeVisible()
  await page.getByRole('button', { name: 'Quick run' }).click()

  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await expect(page.getByText(/Deck locked ·/)).toBeVisible()
  await reachPlacement(page)

  const distance = page.getByLabel('Flag distance')
  const minimum = await distance.getAttribute('min')
  expect(minimum).not.toBeNull()
  await distance.fill(minimum!)
  await page.getByRole('button', { name: /Below/ }).click()
  await expect(page.getByRole('button', { name: /Below/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel(/Strikefall arena\. Drag vertically/)).toHaveAttribute(
    'aria-valuetext',
    /lower, distance .* times risk reward/,
  )
  await expect(page.locator('.risk-slider__header output')).toContainText('×')
  const survivalDetail = page.locator('.risk-detail')
  await expect(survivalDetail.locator('.risk-detail__body')).toBeHidden()
  await expect(survivalDetail.locator('summary')).toHaveText('Show model survival')
  await survivalDetail.locator('summary').click()
  await expect(survivalDetail.locator('.risk-detail__body')).toBeVisible()
  await expect(survivalDetail.locator('.risk-detail__body strong')).toHaveText(/\d+\.\d{2}% no-touch/)
  const survivalPercent = Number.parseFloat(
    (await survivalDetail.locator('.risk-detail__body strong').textContent()) ?? '',
  )
  expect(survivalPercent).toBeGreaterThanOrEqual(12)
  expect(survivalPercent).toBeLessThanOrEqual(90)
  await expect(survivalDetail.locator('.risk-detail__body')).toContainText('exact SolMath WASM')
  await assertNoHorizontalOverflow(page)
  await screenshot(page, testInfo, 'placement.png')

  // The derived deterministic fixture breaks lower. Re-read the side-specific
  // SolMath bound and plant at its edge to exercise the elimination branch.
  const lowerMinimum = await distance.getAttribute('min')
  expect(lowerMinimum).not.toBeNull()
  await distance.fill(lowerMinimum!)
  await expect(page.locator('.risk-slider__header output')).toContainText('7.50×')

  await reachBattle(page)
  await expect(page.locator('.last-human-beat')).toContainText('Last human standing')
  await screenshot(page, testInfo, 'battle-opening.png')

  let eliminated = false
  for (let second = 0; second < 60; second += 1) {
    await advance(page, 1_000)
    const killcam = page.locator('.killcam-callout')
    if (await killcam.isVisible()) {
      await expect(killcam).toContainText('Impact camera')
      await expect(page.getByRole('heading', { name: 'The line found you.' })).toBeHidden()
      // The polling tick may discover the two-second camera partway through;
      // advancing its full duration must reveal the post-impact choice.
      await advance(page, 2_000)
    }
    if (await page.getByRole('heading', { name: 'The line found you.' }).isVisible()) {
      eliminated = true
      break
    }
  }
  expect(eliminated, 'closest legal deterministic flag should exercise elimination UX').toBe(true)
  if (testInfo.project.name === 'mobile-375') {
    const openLobby = page.getByRole('button', { name: 'Open lobby and strike feed' })
    await expect(openLobby, 'mobile must expose its hidden contender/feed panel').toBeVisible()
    await openLobby.click()
    const lobby = page.getByRole('dialog', { name: 'Live lobby' })
    await expect(lobby).toBeVisible()
    await expect(lobby.getByRole('heading', { name: 'Contenders' })).toBeVisible()
    await expect(lobby.getByRole('heading', { name: 'Strike feed' })).toBeVisible()
    await expect(lobby.getByText('YOUR FLAG EXPLODED')).toBeVisible()
    await screenshot(page, testInfo, 'mobile-live-lobby.png', false)
    await page.getByRole('button', { name: 'Close lobby' }).click()
    await expect(lobby).toBeHidden()
  } else {
    await expect(page.locator('.side-panel').getByText('YOUR FLAG EXPLODED')).toBeVisible()
  }
  await expect(page.getByRole('button', { name: 'Instant rematch' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Watch bots' })).toBeVisible()
  await screenshot(page, testInfo, 'eliminated.png')

  await page.getByRole('button', { name: 'Watch bots' }).click()
  await expect(page.getByRole('heading', { name: 'The line found you.' })).toBeHidden()
  await advance(page, PHASE_MS.battle + 1_000)

  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete')
  await expect(page.locator('.phase-clock')).toHaveText('FINAL')
  await expect(page.getByText(/Rank #\d+ of 20/)).toBeVisible()
  const resultStories = page.getByRole('region', { name: 'Round stories' })
  await expect(resultStories).toBeVisible()
  await expect(resultStories.locator('.result-story')).toHaveCount(3)
  await expect(resultStories).toContainText('Rival')
  await expect(resultStories).toContainText('Lobby')
  await expect(page.locator('.proof-copy')).toContainText(/internally consistent|verified locally/)
  const runItBack = page.getByRole('button', { name: 'Run it back' })
  await expect(runItBack).toBeVisible()
  await expectContainedInArena(page, '.result-panel', 'result panel')
  await screenshot(page, testInfo, 'result.png')
  await screenshot(page, testInfo, 'result-viewport.png', false)
  await assertNoHorizontalOverflow(page)

  await page.getByRole('button', { name: 'Share result' }).click()
  const shareDialog = page.getByRole('dialog', { name: 'Frame the strike' })
  await expect(shareDialog).toBeVisible()
  await expect(shareDialog).toContainText('Reduced motion is on')
  await expect(shareDialog.locator('.share-public-facts')).toContainText('Deck')
  await expect(shareDialog.locator('.share-public-facts')).toContainText('19 bots')
  if (testInfo.project.name === 'mobile-375') {
    await expectMinimumTouchTargets(
      shareDialog,
      'button:visible, label:has(input[type="radio"]):visible',
      'share dialog',
    )
  }
  await screenshot(page, testInfo, 'share-dialog.png', false)
  await shareDialog.getByRole('radio', { name: /Square/ }).check()
  await expect(shareDialog.getByRole('radio', { name: /Square/ })).toBeChecked()
  const downloadPromise = page.waitForEvent('download')
  await shareDialog.getByRole('button', { name: 'Share Square card' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^strikefall-[a-z0-9-]+\.png$/)
  const shareCardPath = artifactPath(testInfo, 'share-card-square.png')
  await download.saveAs(shareCardPath)
  expect(pngDimensions(shareCardPath)).toEqual([1080, 1080])
  await expect(shareDialog.getByRole('button', { name: 'Saved to device' })).toBeVisible()
  await expect(shareDialog).toContainText('No private proof data was included')
  await shareDialog.getByRole('button', { name: 'Back to result' }).click()
  await expect(shareDialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Saved to device' })).toBeFocused()

  await runItBack.click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await expect(page.getByText(/Deck locked ·/)).toBeVisible()
  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})

test('midpoint Escape banks live value and settles the counterfactual', async ({ page }, testInfo) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Quick run' }).click()
  // Round setup crosses the asynchronous WASM boundary. Anchor the fake
  // clock to the first timed phase before fast-forwarding through it.
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')
  await reachPlacement(page)

  const distance = page.getByLabel('Flag distance')
  const maximum = await distance.getAttribute('max')
  expect(maximum).not.toBeNull()
  await distance.evaluate((input, value) => {
    const range = input as HTMLInputElement
    range.value = value
    range.dispatchEvent(new Event('input', { bubbles: true }))
    range.dispatchEvent(new Event('change', { bubbles: true }))
  }, maximum!)
  // The frozen v3 Compression fixture crosses the upper maximum at 20s.
  // Use the opposite maximum so this journey reaches the Escape decision
  // instead of incorrectly expecting an eliminated contender to escape.
  const below = page.getByRole('button', { name: 'Below · Put', exact: true })
  await below.click()
  await expect(below).toHaveAttribute('aria-pressed', 'true')
  await reachBattle(page)

  const lockedEscape = page.getByRole('button', { name: /Escape opens in/i })
  await expect(lockedEscape).toBeVisible()
  await expect(lockedEscape).toBeDisabled()
  await screenshot(page, testInfo, 'escape-locked.png', false)

  await advance(page, 30_100)
  const escape = page.getByRole('button', { name: /Escape · sell @/i })
  await expect(escape).toBeVisible()
  await expect(escape).toBeEnabled()
  await expect(page.locator('.escape-button small')).toContainText(/of .* max payout/)
  await escape.click()

  await expect(page.getByText(/banked/i).first()).toBeVisible()
  await expect(page.getByText(/Airlock sealed/i)).toBeVisible()
  await expect(page.locator('.side-panel .contender-row--player')).toHaveClass(/contender-row--escaped/)
  await screenshot(page, testInfo, 'escape-banked.png', false)
  await assertNoHorizontalOverflow(page)

  await advance(page, PHASE_MS.battle)
  await expect(page.locator('.phase-readout strong')).toHaveText('Round complete')
  await expect(page.locator('.result-panel--escaped')).toBeVisible()
  await expect(page.locator('.escape-result-story')).toContainText(/Holding would have|clean exit, real regret/)
  await expect(page.locator('.proof-copy')).toContainText(/internally consistent|verified locally/)
  await screenshot(page, testInfo, 'escape-result.png', false)
  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})
