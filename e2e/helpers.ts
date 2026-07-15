import { expect, type Page, type TestInfo } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const PHASE_MS = {
  deck: 5_000,
  approach: 15_000,
  placement: 6_000,
  lock: 2_000,
  battle: 60_000,
} as const

export function artifactPath(testInfo: TestInfo, name: string): string {
  const directory = join(process.cwd(), 'e2e', 'artifacts', testInfo.project.name)
  mkdirSync(directory, { recursive: true })
  return join(directory, name)
}

export async function screenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  fullPage = true,
) {
  await page.screenshot({
    path: artifactPath(testInfo, name),
    fullPage,
    animations: 'disabled',
  })
}

export async function expectContainedInArena(page: Page, selector: string, label: string) {
  const boxes = await page.evaluate((panelSelector) => {
    const arena = document.querySelector<HTMLElement>('.arena-frame')?.getBoundingClientRect()
    const panel = document.querySelector<HTMLElement>(panelSelector)?.getBoundingClientRect()
    return {
      arena: arena?.toJSON() ?? null,
      panel: panel?.toJSON() ?? null,
    }
  }, selector)
  expect(boxes.arena, `${label}: arena must exist`).not.toBeNull()
  expect(boxes.panel, `${label}: panel must exist`).not.toBeNull()
  expect.soft(
    boxes.panel!.top,
    `${label} is clipped above its arena: ${JSON.stringify(boxes)}`,
  ).toBeGreaterThanOrEqual(boxes.arena!.top)
  expect.soft(
    boxes.panel!.bottom,
    `${label} is clipped below its arena: ${JSON.stringify(boxes)}`,
  ).toBeLessThanOrEqual(boxes.arena!.bottom)
}

export async function installDeterministicBrowser(page: Page) {
  await page.clock.install({ time: new Date('2026-07-14T12:00:00Z') })
  await page.addInitScript(() => {
    let call = 0
    Object.defineProperty(Crypto.prototype, 'getRandomValues', {
      configurable: true,
      value<T extends ArrayBufferView | null>(array: T): T {
        if (array && 'length' in array) {
          const values = [1, 2, 3]
          const writable = array as unknown as { length: number; [index: number]: number }
          // Public deck rotation consumes one entropy byte. Pin it to the
          // Compression deck without advancing the round-seed fixture so the
          // scenario tests retain their original deterministic path. The
          // dedicated rotation journey exercises all four byte buckets.
          if (writable.length === 1) {
            writable[0] = 1
            return array
          }
          for (let index = 0; index < writable.length; index += 1) {
            writable[index] = values[(index + call) % values.length] as number
          }
          call += 1
        }
        return array
      },
    })
  })
}

export function captureRuntimeFailures(page: Page): string[] {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text()}`)
  })
  return failures
}

export async function assertNoHorizontalOverflow(page: Page) {
  const result = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const scrollWidth = document.documentElement.scrollWidth
    const offenders = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((element) => {
        const style = getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        const box = element.getBoundingClientRect()
        return box.width > 1 && (box.left < -1 || box.right > width + 1)
      })
      .slice(0, 8)
      .map((element) => ({
        className: element.className,
        tag: element.tagName,
        box: element.getBoundingClientRect().toJSON(),
      }))
    return { width, scrollWidth, offenders }
  })

  expect(
    result.scrollWidth,
    `horizontal overflow; visible offenders: ${JSON.stringify(result.offenders)}`,
  ).toBeLessThanOrEqual(result.width + 1)
}

export async function advance(page: Page, milliseconds: number) {
  await page.clock.fastForward(milliseconds)
  await page.evaluate(() => Promise.resolve())
}

export async function reachPlacement(page: Page) {
  await advance(page, PHASE_MS.deck + 20)
  await expect(page.locator('.phase-readout strong')).toHaveText('Read the tape')
  await advance(page, PHASE_MS.approach + 20)
  await expect(page.getByLabel('Flag distance')).toBeVisible()
  await expect(page.locator('.phase-readout strong')).toHaveText('Plant your flag')
}

export async function reachBattle(page: Page) {
  await advance(page, PHASE_MS.placement + 20)
  const phase = page.locator('.phase-readout strong')
  await expect(phase).toHaveText(/Positions locked|Line is live/)
  if (await phase.textContent() === 'Positions locked') {
    await advance(page, PHASE_MS.lock + 20)
  }
  await expect(phase).toHaveText('Line is live')
}
