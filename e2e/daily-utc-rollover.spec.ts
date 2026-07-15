import { expect, test } from '@playwright/test'

import { dailyChallengeFor } from '../src/product/progression'
import { captureRuntimeFailures } from './helpers'

const BEFORE_MIDNIGHT = new Date('2026-07-15T23:59:50.000Z')
const MIDNIGHT = new Date('2026-07-16T00:00:00.000Z')

function dailyLaunch(page: import('@playwright/test').Page) {
  return page.locator('.daily-launch')
}

async function expectFeaturedDaily(
  page: import('@playwright/test').Page,
  at: Date,
) {
  const expected = dailyChallengeFor(at)
  expect(expected.deck.version).toBe(3)
  expect(expected.deckVersion).toBe(3)

  const launch = dailyLaunch(page)
  await expect(launch).toBeVisible()
  await expect(launch).toContainText('Today’s Daily Deck')
  await expect(launch.locator('.daily-launch__copy strong')).toHaveText(expected.deck.name)
  await expect(launch).toHaveClass(new RegExp(`(?:^|\\s)daily-launch--${expected.deck.id}(?:\\s|$)`))

  return expected
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: BEFORE_MIDNIGHT })
})

test('an open home tab rolls its Daily at UTC midnight and launches the new v3 deck', async ({ page }) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.goto('/')

  await page.clock.pauseAt(new Date('2026-07-15T23:59:59.500Z'))
  const previous = await expectFeaturedDaily(page, new Date('2026-07-15T23:59:59.500Z'))
  const next = dailyChallengeFor(MIDNIGHT)
  expect(next.id).not.toBe(previous.id)
  expect(next.deck.id).not.toBe(previous.deck.id)

  await page.clock.runFor(500)
  await expectFeaturedDaily(page, MIDNIGHT)

  await dailyLaunch(page).click()
  const reveal = page.locator('.deck-reveal')
  await expect(reveal).toBeVisible()
  await expect(reveal.getByRole('heading', { level: 1 })).toHaveText(next.deck.name)
  await expect(reveal.locator('.deck-shape')).toHaveAttribute(
    'aria-label',
    `Volatility shape: ${next.deck.variance.join(', ')}`,
  )
  expect(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})

test('a missed boundary reconciles on focus and visible-tab recovery', async ({ page }) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.goto('/')

  const first = await expectFeaturedDaily(page, BEFORE_MIDNIGHT)

  // setSystemTime deliberately does not fire timers. This models a throttled
  // or suspended tab waking after its scheduled UTC-boundary callback.
  const focusRecovery = new Date('2026-07-16T08:00:00.000Z')
  await page.clock.setSystemTime(focusRecovery)
  await expect(dailyLaunch(page).locator('.daily-launch__copy strong')).toHaveText(first.deck.name)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expectFeaturedDaily(page, focusRecovery)

  const beforeVisibilityRecovery = dailyChallengeFor(focusRecovery)
  const visibilityRecovery = new Date('2026-07-17T09:00:00.000Z')
  await page.clock.setSystemTime(visibilityRecovery)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(dailyLaunch(page).locator('.daily-launch__copy strong')).toHaveText(
    beforeVisibilityRecovery.deck.name,
  )

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expectFeaturedDaily(page, visibilityRecovery)
  expect(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})
