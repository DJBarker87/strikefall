import type { Contender, FlagSide, PlacementScore } from './types'
import {
  addUnsignedFixed,
  DEFAULT_BROWSER_PRICING_VARIANCE,
  barrierFixedWithActiveEngine,
  canonicalUnsignedFixed,
  displayNumberToFixed,
  fixedToDisplayNumber,
  lockLobbyWithActiveEngine,
  quoteWithActiveEngine,
  subtractUnsignedFixed,
} from '../engine'
import { clamp, inverseNormalCdf, roundTo } from './math'
import { battleStandardDeviation } from './path'

export const MIN_SURVIVAL = 0.12
// Farthest legal flag: 97% full-round no-touch, wide enough that a cautious
// wrong-side pick usually lives to see the Escape window open.
export const MAX_SURVIVAL = 0.97
export const MIN_RISK_MULTIPLIER = 1
export const MAX_RISK_MULTIPLIER = 8
export const MIN_CROWD_FACTOR = 0.75
export const MAX_CROWD_FACTOR = 1.6
// Bot search uses a deliberately local 0..1 arena heuristic; authoritative
// lock scoring still comes from the exact log-distance kernel in Rust.
export const CROWD_BANDWIDTH = 0.115
export const CROWD_TARGET_DENSITY = 1.2

export interface DistanceBounds {
  minimum: number
  maximum: number
}

function canonicalLineValue(lineValue: number, lineValueFixed?: string): string {
  return lineValueFixed !== undefined
    ? canonicalUnsignedFixed(lineValueFixed, 'lineValueFixed')
    : displayNumberToFixed(lineValue, 'lineValue')
}

function fixedDistance(left: string, right: string): string {
  canonicalUnsignedFixed(left, 'distance.left')
  canonicalUnsignedFixed(right, 'distance.right')
  const difference = BigInt(left) - BigInt(right)
  return (difference < 0n ? -difference : difference).toString()
}

/**
 * Spatial normalization for bot crowd-search heuristics, never final scoring.
 * The frame is pinned to the original 12%-90% survival span on purpose: it is
 * a stable coordinate system for judging crowding, deliberately decoupled from
 * the legal placement band so widening that band does not re-tune every bot.
 */
const HEURISTIC_FRAME_MIN_SURVIVAL = 0.12
const HEURISTIC_FRAME_MAX_SURVIVAL = 0.9

function heuristicDistanceBounds(lineValue: number): DistanceBounds {
  const standardDeviation = battleStandardDeviation(lineValue)
  return {
    minimum: roundTo(
      inverseNormalCdf((HEURISTIC_FRAME_MIN_SURVIVAL + 1) / 2) * standardDeviation,
      4,
    ),
    maximum: roundTo(
      inverseNormalCdf((HEURISTIC_FRAME_MAX_SURVIVAL + 1) / 2) * standardDeviation,
      4,
    ),
  }
}

export function legalDistanceBounds(
  lineValue: number,
  side: FlagSide = 'upper',
  lineValueFixed?: string,
): DistanceBounds {
  if (!(lineValue > 0)) return { minimum: 0, maximum: 0 }
  const spotFixed = canonicalLineValue(lineValue, lineValueFixed)
  const minimumBarrier = barrierFixedWithActiveEngine(
    lineValue,
    MIN_SURVIVAL,
    side,
    spotFixed,
  )
  const maximumBarrier = barrierFixedWithActiveEngine(
    lineValue,
    MAX_SURVIVAL,
    side,
    spotFixed,
  )
  return {
    minimum: roundTo(fixedToDisplayNumber(fixedDistance(minimumBarrier, spotFixed)), 4),
    maximum: roundTo(fixedToDisplayNumber(fixedDistance(maximumBarrier, spotFixed)), 4),
  }
}

export function clampDistance(
  distance: number,
  lineValue: number,
  side: FlagSide = 'upper',
  lineValueFixed?: string,
): number {
  const bounds = legalDistanceBounds(lineValue, side, lineValueFixed)
  return clamp(distance, bounds.minimum, bounds.maximum)
}

/**
 * Uses the synchronous SolMath client after the fail-closed startup gate.
 */
export function estimateSurvivalProbability(
  distance: number,
  lineValue: number,
  side: FlagSide = 'upper',
  lineValueFixed?: string,
): number {
  if (distance <= 0 || lineValue <= 0) return 0
  const spotFixed = canonicalLineValue(lineValue, lineValueFixed)
  const barrierFixed = fixedBarrierForPlacement(spotFixed, side, distance)
  const barrier = fixedToDisplayNumber(barrierFixed, 'barrier')
  if (barrier <= 0) return 0
  const quote = quoteWithActiveEngine({
    spot: lineValue,
    spotFixed,
    barrier,
    barrierFixed,
    remainingVariance: DEFAULT_BROWSER_PRICING_VARIANCE,
    remainingVarianceFixed: displayNumberToFixed(
      DEFAULT_BROWSER_PRICING_VARIANCE,
      'remainingVariance',
    ),
    side,
  })
  return quote.survivalProbability
}

export function distanceForSurvivalProbability(
  probability: number,
  lineValue: number,
  side: FlagSide = 'upper',
  lineValueFixed?: string,
): number {
  const boundedProbability = clamp(probability, MIN_SURVIVAL, MAX_SURVIVAL)
  const spotFixed = canonicalLineValue(lineValue, lineValueFixed)
  const solvedBarrier = barrierFixedWithActiveEngine(
    lineValue,
    boundedProbability,
    side,
    spotFixed,
  )
  const bounds = legalDistanceBounds(lineValue, side, spotFixed)
  return roundTo(
    clamp(
      fixedToDisplayNumber(fixedDistance(solvedBarrier, spotFixed), 'distance'),
      bounds.minimum,
      bounds.maximum,
    ),
    4,
  )
}

export function barrierForPlacement(
  lineValue: number,
  side: FlagSide,
  distance: number,
): number {
  return roundTo(side === 'upper' ? lineValue + distance : lineValue - distance)
}

/** Converts the UI distance once, then derives the barrier with integer math. */
export function fixedBarrierForPlacement(
  lineValueFixed: string,
  side: FlagSide,
  distance: number,
): string {
  canonicalUnsignedFixed(lineValueFixed, 'lineValueFixed')
  const distanceFixed = displayNumberToFixed(distance, 'distance')
  return side === 'upper'
    ? addUnsignedFixed(lineValueFixed, distanceFixed, 'barrier')
    : subtractUnsignedFixed(lineValueFixed, distanceFixed, 'barrier')
}

export function riskMultiplier(survivalProbability: number): number {
  if (survivalProbability <= 0) return MAX_RISK_MULTIPLIER
  return roundTo(
    clamp(0.9 / survivalProbability, MIN_RISK_MULTIPLIER, MAX_RISK_MULTIPLIER),
    3,
  )
}

function normalizedDistance(distance: number, lineValue: number): number {
  const bounds = heuristicDistanceBounds(lineValue)
  return (clamp(distance, bounds.minimum, bounds.maximum) - bounds.minimum) /
    (bounds.maximum - bounds.minimum)
}

export function crowdDensityAt(
  side: FlagSide,
  distance: number,
  contenders: readonly Contender[],
  lineValue: number,
  excludeId?: string,
): number {
  const position = normalizedDistance(distance, lineValue)
  return contenders.reduce((density, contender) => {
    if (contender.id === excludeId || contender.side !== side) return density
    const gap = Math.abs(position - normalizedDistance(contender.distance, lineValue))
    return density + Math.max(0, 1 - gap / CROWD_BANDWIDTH)
  }, 0)
}

export function crowdFactorFromDensity(density: number): number {
  return roundTo(
    clamp(
      Math.sqrt((CROWD_TARGET_DENSITY + 1) / (Math.max(0, density) + 1)),
      MIN_CROWD_FACTOR,
      MAX_CROWD_FACTOR,
    ),
    3,
  )
}

export function projectedCrowdFactor(
  side: FlagSide,
  distance: number,
  contenders: readonly Contender[],
  lineValue: number,
  excludeId?: string,
): number {
  return crowdFactorFromDensity(
    crowdDensityAt(side, distance, contenders, lineValue, excludeId),
  )
}

export function placementScore(
  contender: Pick<Contender, 'id' | 'side' | 'distance'>,
  contenders: readonly Contender[],
  lineValue: number,
  lineValueFixed?: string,
): PlacementScore {
  const spotFixed = canonicalLineValue(lineValue, lineValueFixed)
  const normalized = contenders.map((entry) => {
    const distance = clampDistance(entry.distance, lineValue, entry.side, spotFixed)
    const barrierFixed = fixedBarrierForPlacement(spotFixed, entry.side, distance)
    return {
      ...entry,
      distance,
      barrier: fixedToDisplayNumber(barrierFixed, 'barrier'),
      barrierFixed,
    }
  })
  const locked = lockLobbyWithActiveEngine(
    lineValue,
    normalized.map((entry) => ({
      id: entry.id,
      side: entry.side,
      barrier: entry.barrier,
      barrierFixed: entry.barrierFixed,
    })),
    spotFixed,
  )
  const authoritative = locked.find((score) => score.id === contender.id)
  if (!authoritative) throw new Error(`SolMath omitted placement ${contender.id}`)
  return authoritative
}

export function scoreContenders(
  contenders: readonly Contender[],
  lineValue: number,
  lineValueFixed?: string,
): Contender[] {
  const spotFixed = canonicalLineValue(lineValue, lineValueFixed)
  const normalized = contenders.map((contender) => {
    const distance = clampDistance(contender.distance, lineValue, contender.side, spotFixed)
    const barrierFixed = fixedBarrierForPlacement(spotFixed, contender.side, distance)
    return {
      ...contender,
      distance,
      barrier: fixedToDisplayNumber(barrierFixed, 'barrier'),
      barrierFixed,
    }
  })
  const locked = lockLobbyWithActiveEngine(
    lineValue,
    normalized.map((contender) => ({
      id: contender.id,
      side: contender.side,
      barrier: contender.barrier,
      barrierFixed: contender.barrierFixed,
    })),
    spotFixed,
  )
  const scores = new Map(locked.map((score) => [score.id, score]))
  return normalized.map((contender) => {
    const score = scores.get(contender.id)
    if (!score) throw new Error(`SolMath omitted contender ${contender.id}`)
    return {
      ...contender,
      risk: score.risk,
      crowd: score.crowd,
      potential: score.potential,
      fixedScore: {
        survivalProbability: score.survivalFixed,
        riskMultiplier: score.riskFixed,
        crowdFactor: score.crowdFixed,
        terminalScore: score.potentialFixed,
      },
    }
  })
}

export function riskBand(survivalProbability: number): string {
  if (survivalProbability < 0.22) return 'EXTREME'
  if (survivalProbability < 0.4) return 'HOT'
  if (survivalProbability < 0.62) return 'TENSE'
  if (survivalProbability < 0.78) return 'STEADY'
  return 'SHELTERED'
}
