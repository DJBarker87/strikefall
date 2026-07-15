import type {
  BattleIntervalExtrema,
  Contender,
  FixedBattleIntervalExtrema,
  HitResolution,
} from './types'
import { clamp, roundTo } from './math'

export interface BattleHitFrame {
  index: number
  progress: number
  value: number
  hits: Contender[]
}

export interface BattleResolution {
  contenders: Contender[]
  frames: BattleHitFrame[]
}

export function signedDistanceToFlag(contender: Contender, lineValue: number): number {
  return contender.side === 'upper'
    ? contender.barrier - lineValue
    : lineValue - contender.barrier
}

function crossingFraction(
  contender: Contender,
  previousValue: number,
  currentValue: number,
  extrema: BattleIntervalExtrema,
): number {
  const excursion = contender.side === 'upper' ? extrema.high : extrema.low
  if (excursion === previousValue) {
    if (currentValue === previousValue) return 1
    return clamp((contender.barrier - previousValue) / (currentValue - previousValue), 0, 1)
  }
  return clamp((contender.barrier - previousValue) / (excursion - previousValue), 0, 1)
}

export function resolveHitsAtValue(
  contenders: readonly Contender[],
  previousValue: number,
  currentValue: number,
  progress: number,
  intervalExtrema: BattleIntervalExtrema = {
    high: Math.max(previousValue, currentValue),
    low: Math.min(previousValue, currentValue),
  },
  fixedIntervalExtrema?: FixedBattleIntervalExtrema,
  exactFrame?: string,
): HitResolution {
  if (fixedIntervalExtrema && !/^(0|[1-9][0-9]*)$/.test(exactFrame ?? '')) {
    throw new Error('Exact battle interval is missing its canonical frame index')
  }
  const hits: Array<{ contender: Contender; fraction: number }> = []
  const battleStep = /^(0|[1-9][0-9]*)$/.test(exactFrame ?? '')
    ? Number(exactFrame)
    : undefined
  const next = contenders.map((contender) => {
    if (contender.outcome !== 'active') return contender
    if (fixedIntervalExtrema && !contender.barrierFixed) {
      throw new Error(`Exact battle interval is missing ${contender.id}'s fixed barrier`)
    }
    if (fixedIntervalExtrema && contender.closestApproachFixed === undefined) {
      throw new Error(`Exact battle interval is missing ${contender.id}'s fixed closest approach`)
    }

    const nearestValue =
      contender.side === 'upper'
        ? intervalExtrema.high
        : intervalExtrema.low
    const signedDistance = signedDistanceToFlag(contender, nearestValue)
    const candidateDistance = Math.max(0, signedDistance)
    let candidateDistanceFixed: string | undefined
    if (fixedIntervalExtrema && contender.barrierFixed) {
      const barrier = BigInt(contender.barrierFixed)
      const nearest = BigInt(
        contender.side === 'upper'
          ? fixedIntervalExtrema.high
          : fixedIntervalExtrema.low,
      )
      const exactDistance = contender.side === 'upper'
        ? barrier - nearest
        : nearest - barrier
      candidateDistanceFixed = (exactDistance > 0n ? exactDistance : 0n).toString()
    }
    const improved = candidateDistanceFixed !== undefined
      ? BigInt(candidateDistanceFixed) < BigInt(contender.closestApproachFixed as string)
      : candidateDistance < contender.closestApproach
    const closestApproach = improved ? candidateDistance : contender.closestApproach
    const touched = fixedIntervalExtrema
      ? contender.side === 'upper'
        ? BigInt(fixedIntervalExtrema.high) >= BigInt(contender.barrierFixed as string)
        : BigInt(fixedIntervalExtrema.low) <= BigInt(contender.barrierFixed as string)
      : signedDistance <= 0

    if (!touched) {
      return {
        ...contender,
        closestApproach: roundTo(closestApproach, 4),
        closestApproachFixed: improved
          ? candidateDistanceFixed ?? contender.closestApproachFixed
          : contender.closestApproachFixed,
        closestApproachStep: improved && battleStep !== undefined
          ? battleStep
          : contender.closestApproachStep,
      }
    }

    const eliminated: Contender = {
      ...contender,
      outcome: 'hit',
      hitAt: clamp(progress, 0, 1),
      hitFrameExact: fixedIntervalExtrema ? exactFrame : undefined,
      closestApproach: 0,
      closestApproachFixed: fixedIntervalExtrema ? '0' : contender.closestApproachFixed,
      closestApproachStep: battleStep ?? contender.closestApproachStep,
    }
    hits.push({
      contender: eliminated,
      fraction: crossingFraction(contender, previousValue, currentValue, intervalExtrema),
    })
    return eliminated
  })

  hits.sort(
    (left, right) =>
      left.fraction - right.fraction || left.contender.id.localeCompare(right.contender.id),
  )
  return { contenders: next, hits: hits.map(({ contender }) => contender) }
}

export function resolveBattlePath(
  contenders: readonly Contender[],
  path: readonly number[],
  extrema: readonly BattleIntervalExtrema[] = path.map((value, index) => ({
    high: Math.max(path[index - 1] ?? value, value),
    low: Math.min(path[index - 1] ?? value, value),
  })),
  fixedExtrema?: readonly FixedBattleIntervalExtrema[],
): BattleResolution {
  if (path.length < 2) return { contenders: [...contenders], frames: [] }
  if (fixedExtrema && fixedExtrema.length !== path.length) {
    throw new Error('Exact battle path is missing canonical interval extrema')
  }
  let working = [...contenders]
  const frames: BattleHitFrame[] = []

  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1] as number
    const value = path[index] as number
    const progress = index / (path.length - 1)
    const resolution = resolveHitsAtValue(
      working,
      previous,
      value,
      progress,
      extrema[index],
      fixedExtrema?.[index],
      index.toString(),
    )
    working = resolution.contenders
    if (resolution.hits.length > 0) {
      frames.push({ index, progress, value, hits: resolution.hits })
    }
  }

  return { contenders: working, frames }
}

export function markSurvivors(contenders: readonly Contender[]): Contender[] {
  return contenders.map((contender) =>
    contender.outcome === 'active' ? { ...contender, outcome: 'survived' } : contender,
  )
}

export function largestHitCluster(
  frames: readonly BattleHitFrame[],
  totalSteps: number,
  windowProgress = 0.5 / 60,
): number {
  if (frames.length === 0 || totalSteps < 2) return 0
  let largest = 0
  for (let start = 0; start < frames.length; start += 1) {
    const startProgress = frames[start]?.progress ?? 0
    let count = 0
    for (let end = start; end < frames.length; end += 1) {
      const frame = frames[end]
      if (!frame || frame.progress - startProgress > windowProgress) break
      count += frame.hits.length
    }
    largest = Math.max(largest, count)
  }
  return largest
}
