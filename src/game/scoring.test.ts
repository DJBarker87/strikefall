import { describe, expect, it } from 'vitest'
import type { Contender } from './types'
import {
  MAX_CROWD_FACTOR,
  MAX_RISK_MULTIPLIER,
  MIN_CROWD_FACTOR,
  barrierForPlacement,
  crowdFactorFromDensity,
  distanceForSurvivalProbability,
  estimateSurvivalProbability,
  fixedBarrierForPlacement,
  placementScore,
  projectedCrowdFactor,
  riskMultiplier,
} from './scoring'

function contender(id: string, side: 'upper' | 'lower', distance: number): Contender {
  return {
    id,
    name: id,
    persona: 'Chaos',
    isPlayer: false,
    side,
    distance,
    barrier: barrierForPlacement(50, side, distance),
    risk: 1,
    crowd: 1,
    potential: 100,
    color: '#fff',
    outcome: 'active',
    hitAt: null,
    closestApproach: distance,
    escape: null,
    moves: [],
  }
}

describe('risk and crowd scoring', () => {
  it('derives placement barriers with exact fixed-point addition and subtraction', () => {
    expect(fixedBarrierForPlacement('50000000000000', 'upper', 1.25)).toBe(
      '51250000000000',
    )
    expect(fixedBarrierForPlacement('50000000000000', 'lower', 1.25)).toBe(
      '48750000000000',
    )
  })

  it('makes survival monotone in distance and inverts target bands', () => {
    expect(estimateSurvivalProbability(3, 50)).toBeLessThan(
      estimateSurvivalProbability(12, 50),
    )
    for (const target of [0.12, 0.25, 0.45, 0.7, 0.9]) {
      const distance = distanceForSurvivalProbability(target, 50)
      expect(estimateSurvivalProbability(distance, 50)).toBeCloseTo(target, 3)
    }
  })

  it('implements the 0.90 / p risk ladder with caps', () => {
    expect(riskMultiplier(0.9)).toBe(1)
    expect(riskMultiplier(0.45)).toBe(2)
    expect(riskMultiplier(0.18)).toBe(5)
    expect(riskMultiplier(0)).toBe(MAX_RISK_MULTIPLIER)
  })

  it('rewards clean air and dilutes same-side clusters only', () => {
    const alone = contender('alone', 'upper', 8)
    const opposite = contender('opposite', 'lower', 8)
    expect(projectedCrowdFactor('upper', 8, [alone, opposite], 50, 'alone')).toBe(
      MAX_CROWD_FACTOR - 0.117,
    )

    const packed = Array.from({ length: 7 }, (_, index) => contender(`packed-${index}`, 'upper', 8))
    expect(projectedCrowdFactor('upper', 8, packed, 50, 'packed-0')).toBe(MIN_CROWD_FACTOR)
    expect(projectedCrowdFactor('lower', 8, packed, 50)).toBeGreaterThan(1)
  })

  it('never emits a crowd factor outside the published bounds', () => {
    expect(crowdFactorFromDensity(0)).toBeGreaterThanOrEqual(MIN_CROWD_FACTOR)
    expect(crowdFactorFromDensity(0)).toBeLessThanOrEqual(MAX_CROWD_FACTOR)
    expect(crowdFactorFromDensity(10_000)).toBe(MIN_CROWD_FACTOR)
  })

  it('fixes terminal potential from risk and crowd', () => {
    const flag = contender('flag', 'upper', distanceForSurvivalProbability(0.45, 50))
    const score = placementScore(flag, [flag], 50)
    expect(score.risk).toBeCloseTo(2, 2)
    expect(score.potential).toBe(Math.round(100 * score.risk * score.crowd))
  })
})
