import { describe, expect, it } from 'vitest'
import {
  ESCAPE_CAPTURE_KEY,
  battleMomentClockTime,
  battleStepClockTime,
  nearMissCaptureKey,
  shareMomentCaptureKey,
  shareMomentSupportsClip,
} from './clipMoments'
import type { DramaticMoment } from './types'

describe('share moment capture identity', () => {
  it('maps final editorial moments back to their live retained candidates', () => {
    const cluster = {
      kind: 'cluster-wipe',
      sequence: 12,
    } as DramaticMoment
    const nearMiss = {
      kind: 'near-miss',
      outcome: 'late-hit',
    } as DramaticMoment
    const heldNearMiss = {
      kind: 'near-miss',
      outcome: 'held',
      at: 0.3,
      closestApproachStep: 72,
    } as DramaticMoment
    const legacyHeldNearMiss = {
      kind: 'near-miss',
      outcome: 'held',
      at: null,
      closestApproachStep: null,
    } as DramaticMoment
    const escape = {
      kind: 'perfect-escape',
    } as DramaticMoment

    expect(shareMomentCaptureKey(cluster)).toBe('cluster-wipe:12')
    expect(shareMomentCaptureKey(nearMiss)).toBe('near-miss:late-hit')
    expect(shareMomentCaptureKey(heldNearMiss)).toBe('near-miss:held:72')
    expect(shareMomentCaptureKey(legacyHeldNearMiss)).toBeNull()
    expect(shareMomentSupportsClip(nearMiss)).toBe(true)
    expect(shareMomentSupportsClip(heldNearMiss)).toBe(true)
    expect(shareMomentSupportsClip(legacyHeldNearMiss)).toBe(false)
    expect(shareMomentCaptureKey(escape)).toBe(ESCAPE_CAPTURE_KEY)
    expect(() => nearMissCaptureKey('held', -1)).toThrow(/authoritative battle step/)
  })

  it('uses the same recorder clock before and after the battle boundary', () => {
    const battle = battleMomentClockTime({
      phase: 'battle',
      phaseStartedAt: 100_000,
      phaseDuration: 60_000,
      at: 0.4,
    })
    const result = battleMomentClockTime({
      phase: 'result',
      phaseStartedAt: 160_000,
      phaseDuration: 10_000,
      at: 0.4,
    })
    expect(battle).toBe(124_000)
    expect(result).toBe(battle)
  })

  it('anchors Escape to the authoritative step rather than response time', () => {
    expect(battleStepClockTime({
      phaseStartedAt: 100_000,
      phaseDuration: 60_000,
      step: 120,
      battleSteps: 240,
    })).toBe(130_000)
  })
})
