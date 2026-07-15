import { describe, expect, it } from 'vitest'
import type { Contender } from './types'
import { largestHitCluster, markSurvivors, resolveBattlePath, resolveHitsAtValue } from './hits'

function flag(id: string, side: 'upper' | 'lower', barrier: number): Contender {
  const distance = Math.abs(barrier - 50)
  return {
    id,
    name: id,
    persona: 'Chaos',
    isPlayer: id === 'player',
    side,
    distance,
    barrier,
    risk: 2,
    crowd: 1,
    potential: 200,
    color: '#fff',
    outcome: 'active',
    hitAt: null,
    closestApproach: distance,
    escape: null,
    moves: [],
  }
}

describe('authoritative hit resolution', () => {
  it('touches upper and lower flags without killing the opposite side', () => {
    const flags = [flag('upper', 'upper', 55), flag('lower', 'lower', 45)]
    const rise = resolveHitsAtValue(flags, 50, 55, 0.25)
    expect(rise.hits.map((entry) => entry.id)).toEqual(['upper'])
    expect(rise.contenders.find((entry) => entry.id === 'lower')?.outcome).toBe('active')
    const fall = resolveHitsAtValue(rise.contenders, 55, 44, 0.5)
    expect(fall.hits.map((entry) => entry.id)).toEqual(['lower'])
  })

  it('orders a crossed cluster from nearest to furthest', () => {
    const flags = [
      flag('far', 'upper', 57),
      flag('near', 'upper', 53),
      flag('middle', 'upper', 55),
    ]
    const result = resolveHitsAtValue(flags, 50, 58, 0.2)
    expect(result.hits.map((entry) => entry.id)).toEqual(['near', 'middle', 'far'])
    expect(result.hits.every((entry) => entry.closestApproach === 0)).toBe(true)
  })

  it('tracks closest approach for untouched flags', () => {
    const result = resolveHitsAtValue([flag('upper', 'upper', 60)], 50, 57.5, 0.4)
    expect(result.hits).toHaveLength(0)
    expect(result.contenders[0]?.closestApproach).toBe(2.5)
  })

  it('binds an exact closest approach to the first authoritative battle step', () => {
    const exact = {
      ...flag('upper', 'upper', 60),
      barrierFixed: '60000000000000',
      closestApproachFixed: '10000000000000',
      closestApproachStep: 0,
    }
    const closer = resolveHitsAtValue(
      [exact],
      50,
      57.5,
      0.4,
      { high: 57.5, low: 50 },
      { high: '57500000000000', low: '50000000000000' },
      '7',
    ).contenders[0]!
    expect(closer).toMatchObject({
      closestApproach: 2.5,
      closestApproachFixed: '2500000000000',
      closestApproachStep: 7,
    })
    const tied = resolveHitsAtValue(
      [closer],
      57.5,
      57.4,
      0.45,
      { high: 57.5, low: 57.4 },
      { high: '57500000000000', low: '57400000000000' },
      '8',
    ).contenders[0]!
    expect(tied.closestApproachStep).toBe(7)
  })

  it('eliminates on a retained wick even when neither endpoint crosses', () => {
    const result = resolveHitsAtValue(
      [flag('upper', 'upper', 55), flag('lower', 'lower', 45)],
      50,
      51,
      0.25,
      { high: 56, low: 44 },
    )
    expect(result.hits.map((entry) => entry.id)).toEqual(['lower', 'upper'])
    expect(result.contenders.every((entry) => entry.closestApproach === 0)).toBe(true)
  })

  it('uses exact fixed extrema rather than rounded display values for outcomes', () => {
    const roundedFalsePositive = {
      ...flag('upper-safe', 'upper', 55),
      barrierFixed: '55000000000000',
      closestApproachFixed: '5000000000000',
    }
    const safe = resolveHitsAtValue(
      [roundedFalsePositive],
      50,
      54,
      0.25,
      { high: 56, low: 50 },
      { high: '54999999999999', low: '50000000000000' },
      '1',
    )
    expect(safe.hits).toHaveLength(0)

    const roundedFalseNegative = {
      ...flag('upper-hit', 'upper', 55),
      barrierFixed: '55000000000000',
      closestApproachFixed: '5000000000000',
    }
    const hit = resolveHitsAtValue(
      [roundedFalseNegative],
      50,
      54,
      0.25,
      { high: 54.9999, low: 50 },
      { high: '55000000000000', low: '50000000000000' },
      '1',
    )
    expect(hit.hits.map((entry) => entry.id)).toEqual(['upper-hit'])
  })

  it('fails closed when an exact path is paired with a display-only barrier', () => {
    expect(() => resolveHitsAtValue(
      [flag('legacy-only', 'upper', 55)],
      50,
      54,
      0.25,
      { high: 54, low: 50 },
      { high: '54000000000000', low: '50000000000000' },
      '1',
    )).toThrow(/fixed barrier/)
  })

  it('fails closed rather than choosing a Number-only closest frame on an exact path', () => {
    const missingFixedClosest = {
      ...flag('upper', 'upper', 55),
      barrierFixed: '55000000000000',
    }
    expect(() => resolveHitsAtValue(
      [missingFixedClosest],
      50,
      54,
      0.25,
      { high: 54, low: 50 },
      { high: '54000000000000', low: '50000000000000' },
      '1',
    )).toThrow(/fixed closest approach/)
  })

  it('fails closed when an exact interval has no canonical frame index', () => {
    const exact = {
      ...flag('upper', 'upper', 55),
      barrierFixed: '55000000000000',
      closestApproachFixed: '5000000000000',
    }
    expect(() => resolveHitsAtValue(
      [exact],
      50,
      55,
      0.25,
      { high: 55, low: 50 },
      { high: '55000000000000', low: '50000000000000' },
    )).toThrow(/canonical frame/)
  })

  it('replays a whole path and finds half-second wipe windows', () => {
    const resolution = resolveBattlePath(
      [flag('a', 'upper', 53), flag('b', 'upper', 54), flag('c', 'upper', 55)],
      [50, 52, 54, 56],
    )
    expect(resolution.frames.flatMap((frame) => frame.hits)).toHaveLength(3)
    expect(largestHitCluster(resolution.frames, 121, 0.4)).toBe(3)
    expect(markSurvivors(resolution.contenders).every((entry) => entry.outcome === 'hit')).toBe(true)
  })
})
