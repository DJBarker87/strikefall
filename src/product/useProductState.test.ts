import { describe, expect, it, vi } from 'vitest'
import { dailyChallengeFor } from './progression'
import {
  millisecondsUntilNextUtcDay,
  subscribeUtcChallengeClock,
} from './useProductState'
import { weeklyChallengeFor } from './weeklyChallenge'

describe('UTC challenge clock', () => {
  it('calculates the exact next UTC boundary independently of local time', () => {
    expect(millisecondsUntilNextUtcDay(Date.parse('2026-07-15T23:59:59.250Z'))).toBe(750)
    expect(millisecondsUntilNextUtcDay(Date.parse('2026-07-15T00:00:00.000Z'))).toBe(86_400_000)
    expect(() => millisecondsUntilNextUtcDay(Number.NaN)).toThrow(RangeError)
  })

  it('refreshes Daily and Weekly at Monday UTC and recovers missed ticks on visibility/focus', () => {
    let nowMs = Date.parse('2026-07-19T23:59:59.500Z')
    let visible = true
    let nextTimer = 0
    const timers = new Map<number, { callback: () => void; delayMs: number }>()
    const focusTarget = new EventTarget()
    const visibilityTarget = new EventTarget()
    const schedule = vi.fn((callback: () => void, delayMs: number) => {
      const timer = ++nextTimer
      timers.set(timer, { callback, delayMs })
      return timer
    })
    const cancel = vi.fn((timer: number) => {
      timers.delete(timer)
    })
    const refreshes: number[] = []
    const previousDaily = dailyChallengeFor(new Date(nowMs)).id
    const previousWeekly = weeklyChallengeFor(new Date(nowMs)).id

    const unsubscribe = subscribeUtcChallengeClock(
      (refreshedAt) => refreshes.push(refreshedAt),
      {
        now: () => nowMs,
        schedule,
        cancel,
        focusTarget,
        visibilityTarget,
        isVisible: () => visible,
      },
    )

    const midnightTimer = timers.get(1)
    expect(midnightTimer?.delayMs).toBe(500)
    nowMs = Date.parse('2026-07-20T00:00:00.000Z')
    timers.delete(1)
    midnightTimer?.callback()
    expect(refreshes).toEqual([nowMs])
    expect(dailyChallengeFor(new Date(refreshes[0] as number)).id).not.toBe(previousDaily)
    expect(weeklyChallengeFor(new Date(refreshes[0] as number)).id).not.toBe(previousWeekly)
    expect(timers.get(2)?.delayMs).toBe(86_400_000)

    visible = false
    nowMs = Date.parse('2026-07-21T08:00:00.000Z')
    visibilityTarget.dispatchEvent(new Event('visibilitychange'))
    expect(refreshes).toHaveLength(1)

    visible = true
    visibilityTarget.dispatchEvent(new Event('visibilitychange'))
    expect(refreshes.at(-1)).toBe(nowMs)
    expect(timers.get(3)?.delayMs).toBe(57_600_000)

    nowMs = Date.parse('2026-07-22T09:00:00.000Z')
    focusTarget.dispatchEvent(new Event('focus'))
    expect(refreshes.at(-1)).toBe(nowMs)
    expect(timers.get(4)?.delayMs).toBe(54_000_000)

    unsubscribe()
    const refreshCount = refreshes.length
    focusTarget.dispatchEvent(new Event('focus'))
    visibilityTarget.dispatchEvent(new Event('visibilitychange'))
    expect(refreshes).toHaveLength(refreshCount)
    expect(timers.size).toBe(0)
  })
})
