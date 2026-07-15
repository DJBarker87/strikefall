import type { Contender, DeckDefinition, EscapeRecord, RoundState } from './types'
import {
  canonicalUnsignedFixed,
  displayNumberToFixed,
  fixedToDisplayNumber,
  fixedToRoundedPoints,
  multiplyUnsignedFixed,
  quoteWithActiveEngine,
  remainingVarianceFixedWithActiveEngine,
} from '../engine'
import { clamp, roundTo } from './math'
import { NEUTRAL_DRIFT_PER_VARIANCE } from './path'

export const ESCAPE_UNLOCK_MS = 10_000
export const ESCAPE_CLOSE_BEFORE_END_MS = 3_000
export const ESCAPE_UNLOCK_PROGRESS = ESCAPE_UNLOCK_MS / 60_000
export const ESCAPE_CLOSE_PROGRESS = 1 - ESCAPE_CLOSE_BEFORE_END_MS / 60_000

export interface EscapeQuote {
  contenderId: string
  frame: number
  at: number
  remainingVariance: number
  /** Canonical SCALE=1e12 remaining variance used by the quote. */
  remainingVarianceFixed: string
  survivalProbability: number
  terminalScore: number
  bankedScore: number
  /** Canonical values used for the calculation; Number fields are display-only. */
  survivalProbabilityFixed: string
  terminalScoreFixed: string
  bankedScoreFixed: string
  percentOfMaximum: number
}

export function battleFrameProgress(frame: number, battleSteps: number): number {
  if (!Number.isInteger(battleSteps) || battleSteps < 2) return 0
  return clamp(Math.floor(frame) / (battleSteps - 1), 0, 1)
}

/** Remaining integrated variance is derived only from public deck/time state. */
export function remainingBattleVariance(
  deck: DeckDefinition,
  completedFrame: number,
  battleSteps: number,
): number {
  return fixedToDisplayNumber(
    remainingBattleVarianceFixed(deck, completedFrame, battleSteps),
    'remainingVariance',
  )
}

export function remainingBattleVarianceFixed(
  deck: DeckDefinition,
  completedFrame: number,
  battleSteps: number,
): string {
  return remainingVarianceFixedWithActiveEngine(
    {
      id: deck.id,
      name: deck.name,
      version: deck.version,
      monitoringConvention: deck.monitoringConvention,
      variance: deck.variance,
      openingRunway: deck.openingRunway,
    },
    completedFrame,
    battleSteps,
  )
}

/**
 * Continuous one-sided first-passage quote in variance time. Public-alpha
 * gameplay always resolves this synchronously through SolMath WASM.
 */
export function oneSidedNoTouchProbability(
  spot: number,
  barrier: number,
  side: Contender['side'],
  remainingVariance: number,
  driftPerVariance = NEUTRAL_DRIFT_PER_VARIANCE,
): number {
  if (
    !Number.isFinite(spot) ||
    !Number.isFinite(barrier) ||
    !Number.isFinite(remainingVariance) ||
    !Number.isFinite(driftPerVariance) ||
    spot <= 0 ||
    barrier <= 0 ||
    remainingVariance < 0
  ) {
    throw new RangeError('No-touch quote inputs must be finite and inside their domains')
  }

  const spotFixed = displayNumberToFixed(spot, 'spot')
  const barrierFixed = displayNumberToFixed(barrier, 'barrier')
  const remainingVarianceFixed = displayNumberToFixed(
    remainingVariance,
    'remainingVariance',
  )
  const breached = side === 'upper'
    ? BigInt(spotFixed) >= BigInt(barrierFixed)
    : BigInt(spotFixed) <= BigInt(barrierFixed)
  if (driftPerVariance !== NEUTRAL_DRIFT_PER_VARIANCE) {
    throw new RangeError('Custom browser drift quotes are disabled; use the committed SolMath deck')
  }
  return quoteWithActiveEngine({
    spot,
    spotFixed,
    barrier,
    barrierFixed,
    remainingVariance,
    remainingVarianceFixed,
    side,
    alreadyBreached: breached,
  }).survivalProbability
}

export function quoteContenderEscape(
  contender: Contender,
  deck: DeckDefinition,
  lineValue: number,
  battleFrame: number,
  battleSteps: number,
  lineValueFixed?: string,
): EscapeQuote {
  const frame = Math.floor(clamp(battleFrame, 0, Math.max(0, battleSteps - 1)))
  const at = battleFrameProgress(frame, battleSteps)
  const remainingVarianceFixed = remainingBattleVarianceFixed(deck, frame, battleSteps)
  const remainingVariance = fixedToDisplayNumber(remainingVarianceFixed, 'remainingVariance')
  if (lineValueFixed === undefined) {
    throw new Error('Escape quote is missing the exact current line value')
  }
  if (contender.barrierFixed === undefined) {
    throw new Error(`Contender ${contender.id} is missing its exact barrier`)
  }
  const spotFixed = canonicalUnsignedFixed(lineValueFixed, 'lineValueFixed')
  const barrierFixed = canonicalUnsignedFixed(contender.barrierFixed, 'barrierFixed')
  const breached = contender.side === 'upper'
    ? BigInt(spotFixed) >= BigInt(barrierFixed)
    : BigInt(spotFixed) <= BigInt(barrierFixed)
  const survival = quoteWithActiveEngine({
    spot: lineValue,
    spotFixed,
    barrier: contender.barrier,
    barrierFixed,
    remainingVariance,
    remainingVarianceFixed,
    side: contender.side,
    alreadyBreached: breached,
  })
  const terminalScoreFixed = contender.fixedScore?.terminalScore
  if (!terminalScoreFixed) {
    throw new Error(`Contender ${contender.id} has no SolMath lock terms`)
  }
  const bankedScoreFixed = multiplyUnsignedFixed(
    terminalScoreFixed,
    survival.survivalProbabilityFixed,
    'escapeValue',
  )
  return {
    contenderId: contender.id,
    frame,
    at,
    remainingVariance: roundTo(remainingVariance, 12),
    remainingVarianceFixed,
    survivalProbability: survival.survivalProbability,
    terminalScore: fixedToRoundedPoints(terminalScoreFixed, 'terminalScore'),
    bankedScore: fixedToRoundedPoints(bankedScoreFixed, 'bankedScore'),
    survivalProbabilityFixed: survival.survivalProbabilityFixed,
    terminalScoreFixed,
    bankedScoreFixed,
    percentOfMaximum: roundTo(survival.survivalProbability * 100, 2),
  }
}

export function getContenderEscapeQuote(
  state: Pick<
    RoundState,
    | 'phase'
    | 'deck'
    | 'lineValue'
    | 'lineValueFixed'
    | 'battleIndex'
    | 'battlePath'
    | 'contenders'
  >,
  contenderId: string,
): EscapeQuote | null {
  if (state.phase !== 'battle') return null
  const contender = state.contenders.find((entry) => entry.id === contenderId)
  if (!contender || contender.outcome !== 'active') return null
  return quoteContenderEscape(
    contender,
    state.deck,
    state.lineValue,
    state.battleIndex,
    state.battlePath.length,
    state.lineValueFixed,
  )
}

export function canContenderEscape(
  state: Pick<
    RoundState,
    | 'phase'
    | 'escapeEnabled'
    | 'deck'
    | 'lineValue'
    | 'lineValueFixed'
    | 'battleIndex'
    | 'battlePath'
    | 'contenders'
  >,
  contenderId: string,
): boolean {
  if (!state.escapeEnabled || state.phase !== 'battle') return false
  const quote = getContenderEscapeQuote(state, contenderId)
  return Boolean(
    quote &&
    quote.at >= ESCAPE_UNLOCK_PROGRESS &&
    quote.at < ESCAPE_CLOSE_PROGRESS &&
    BigInt(quote.survivalProbabilityFixed) > 0n,
  )
}

export function escapeRecordFromQuote(quote: EscapeQuote): EscapeRecord {
  return {
    frame: quote.frame,
    at: quote.at,
    survivalProbability: quote.survivalProbability,
    survivalProbabilityFixed: quote.survivalProbabilityFixed,
    terminalScore: quote.terminalScore,
    terminalScoreFixed: quote.terminalScoreFixed,
    bankedScore: quote.bankedScore,
    bankedScoreFixed: quote.bankedScoreFixed,
    holdOutcome: 'pending',
    holdHitAt: null,
  }
}
