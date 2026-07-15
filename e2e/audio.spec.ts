import { expect, test } from '@playwright/test'

import { captureRuntimeFailures, installDeterministicBrowser } from './helpers'

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowser(page)
  await page.addInitScript(() => {
    const probe: string[] = []
    Object.defineProperty(window, '__strikefallAudioProbe', {
      configurable: false,
      value: probe,
    })
    const AudioContextClass = window.AudioContext
    if (!AudioContextClass) return
    const oscillator = AudioContextClass.prototype.createOscillator
    const bufferSource = AudioContextClass.prototype.createBufferSource
    AudioContextClass.prototype.createOscillator = function createOscillator() {
      probe.push('oscillator')
      return oscillator.call(this)
    }
    AudioContextClass.prototype.createBufferSource = function createBufferSource() {
      probe.push('noise')
      return bufferSource.call(this)
    }
  })
})

test('StrictMode keeps procedural deck audio alive after effect cleanup rehearsal', async ({ page }) => {
  const runtimeFailures = captureRuntimeFailures(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Quick run' }).click()
  await expect(page.locator('.phase-readout strong')).toHaveText('Deck incoming')

  await expect.poll(() => page.evaluate(() => (
    (window as Window & { __strikefallAudioProbe?: string[] }).__strikefallAudioProbe ?? []
  ))).toEqual(expect.arrayContaining(['oscillator', 'noise']))
  const events = await page.evaluate(() => (
    (window as Window & { __strikefallAudioProbe?: string[] }).__strikefallAudioProbe ?? []
  ))
  expect(events.filter((event) => event === 'oscillator').length).toBeGreaterThanOrEqual(6)
  expect(events.filter((event) => event === 'noise').length).toBeGreaterThanOrEqual(1)
  expect.soft(runtimeFailures, runtimeFailures.join('\n')).toEqual([])
})
