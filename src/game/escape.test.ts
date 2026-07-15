import { describe, expect, it } from 'vitest'
import {
  displayNumberToFixed,
  fixedToRoundedPoints,
  multiplyUnsignedFixed,
} from '../engine'
import { decideBotEscapes } from './bots'
import { getDeck } from './decks'
import {
  ESCAPE_CLOSE_PROGRESS,
  ESCAPE_UNLOCK_PROGRESS,
  canContenderEscape,
  getContenderEscapeQuote,
  oneSidedNoTouchProbability,
  remainingBattleVariance,
} from './escape'
import {
  beginBattle,
  createRound,
  executeEscapeCommand,
  finishRound,
  getPlayer,
  lockPlacements,
  playBattleToEnd,
  resolveBattleStep,
  roundPacing,
  startPlacement,
  updateBotsForPlacement,
  updatePlayerPlacement,
} from './round'

const deck = getDeck('balanced-tape')!
const compression = getDeck('compression-break')!
const opening = getDeck('opening-rush')!

function fixedExtrema(pathFixed: readonly string[]) {
  return pathFixed.map((value, index) => {
    const previous = pathFixed[index - 1] ?? value
    return {
      high: BigInt(previous) >= BigInt(value) ? previous : value,
      low: BigInt(previous) <= BigInt(value) ? previous : value,
    }
  })
}

function controlledBattle(seed: string, battleSteps = 61) {
  let placement = startPlacement(
    createRound(seed, deck, { battleSteps, escapeEnabled: true }),
    0,
  )
  placement = updatePlayerPlacement(placement, 'upper', 1_000_000)
  const locked = lockPlacements(placement, 6_000)
  const start = locked.battlePath[0]!
  const startFixed = locked.battlePathFixed?.[0] ?? displayNumberToFixed(start)
  const battlePathFixed = Array.from({ length: battleSteps }, () => startFixed)
  return beginBattle(
    {
      ...locked,
      battlePath: Array.from({ length: battleSteps }, () => start),
      battlePathFixed,
      battleExtrema: Array.from({ length: battleSteps }, () => ({ high: start, low: start })),
      battleExtremaFixed: fixedExtrema(battlePathFixed),
    },
    14_000,
  )
}

describe('v1.1 Escape value', () => {
  it('uses continuous one-sided no-touch semantics and public remaining variance', () => {
    const startVariance = remainingBattleVariance(deck, 0, 241)
    const midpointVariance = remainingBattleVariance(deck, 120, 241)
    const endVariance = remainingBattleVariance(deck, 240, 241)
    expect(startVariance).toBeCloseTo(0.0064, 12)
    expect(midpointVariance).toBeGreaterThan(0)
    expect(midpointVariance).toBeLessThan(startVariance)
    expect(endVariance).toBe(0)
    expect(remainingBattleVariance(compression, 60, 241)).toBeCloseTo(0.00608, 12)
    expect(remainingBattleVariance(opening, 60, 241)).toBeCloseTo(0.00288, 12)

    const farther = oneSidedNoTouchProbability(50, 60, 'upper', midpointVariance)
    const nearer = oneSidedNoTouchProbability(50, 55, 'upper', midpointVariance)
    expect(farther).toBeGreaterThan(nearer)
    expect(oneSidedNoTouchProbability(55, 55, 'upper', midpointVariance)).toBe(0)
    expect(oneSidedNoTouchProbability(50, 55, 'upper', 0)).toBe(1)
  })

  it('unlocks ten seconds in, closes for the final three seconds, and accepts once', () => {
    const battle = controlledBattle('escape-window')
    const before = resolveBattleStep(battle, 9)
    expect(getContenderEscapeQuote(before, 'player')?.at).toBeLessThan(
      ESCAPE_UNLOCK_PROGRESS,
    )
    expect(canContenderEscape(before, 'player')).toBe(false)
    expect(executeEscapeCommand(before, 'player').rejection).toBe('window-closed')

    const midpoint = resolveBattleStep(battle, 10)
    expect(getContenderEscapeQuote(midpoint, 'player')?.at).toBe(
      ESCAPE_UNLOCK_PROGRESS,
    )
    expect(canContenderEscape(midpoint, 'player')).toBe(true)
    const accepted = executeEscapeCommand(midpoint, 'player')
    expect(accepted.accepted).toBe(true)
    expect(accepted.event?.type).toBe('escape')
    expect(getPlayer(accepted.round).outcome).toBe('escaped')
    expect(getPlayer(accepted.round).escape?.bankedScore).toBe(
      accepted.quote?.bankedScore,
    )
    expect(accepted.quote?.bankedScoreFixed).toBe(
      multiplyUnsignedFixed(
        accepted.quote!.terminalScoreFixed,
        accepted.quote!.survivalProbabilityFixed,
      ),
    )
    expect(accepted.quote?.remainingVarianceFixed).toMatch(/^\d+$/)
    expect(getPlayer(accepted.round).escape?.bankedScoreFixed).toBe(
      accepted.quote?.bankedScoreFixed,
    )
    expect(accepted.quote?.bankedScore).toBe(
      fixedToRoundedPoints(accepted.quote!.bankedScoreFixed),
    )

    const duplicate = executeEscapeCommand(accepted.round, 'player')
    expect(duplicate.accepted).toBe(false)
    expect(duplicate.rejection).toBe('not-active')
    expect(duplicate.round).toBe(accepted.round)

    const closed = resolveBattleStep(controlledBattle('escape-close'), 57)
    expect(getContenderEscapeQuote(closed, 'player')?.at).toBe(
      ESCAPE_CLOSE_PROGRESS,
    )
    expect(canContenderEscape(closed, 'player')).toBe(false)
  })

  it('uses fixed line and barrier values and rejects an exact-state downgrade', () => {
    const midpoint = resolveBattleStep(controlledBattle('escape-exact-inputs'), 30)
    const baseline = getContenderEscapeQuote(midpoint, 'player')!
    const displayDrift = {
      ...midpoint,
      lineValue: 1,
      contenders: midpoint.contenders.map((contender) => (
        contender.isPlayer
          ? { ...contender, barrier: 2, potential: 999_999 }
          : contender
      )),
    }
    expect(getContenderEscapeQuote(displayDrift, 'player')).toMatchObject({
      survivalProbabilityFixed: baseline.survivalProbabilityFixed,
      terminalScoreFixed: baseline.terminalScoreFixed,
      bankedScoreFixed: baseline.bankedScoreFixed,
    })
    expect(() => getContenderEscapeQuote(
      { ...midpoint, lineValueFixed: undefined },
      'player',
    )).toThrow(/exact current line/)
    expect(() => getContenderEscapeQuote({
      ...midpoint,
      contenders: midpoint.contenders.map((contender) => (
        contender.isPlayer ? { ...contender, barrierFixed: undefined } : contender
      )),
    }, 'player')).toThrow(/exact barrier/)
  })

  it('banks a fixed score, removes the flag, and settles hindsight separately', () => {
    const battle = controlledBattle('escape-counterfactual')
    const midpoint = resolveBattleStep(battle, 30)
    const escaped = executeEscapeCommand(midpoint, 'player')
    expect(escaped.accepted).toBe(true)
    const banked = escaped.quote!.bankedScore
    const barrier = getPlayer(escaped.round).barrier
    const counterfactualPath = escaped.round.battlePath.map((value, index) =>
      index >= 40 ? barrier + 0.5 : value,
    )
    const counterfactualExtrema = counterfactualPath.map((value, index) => {
      const previous = counterfactualPath[index - 1] ?? value
      return { high: Math.max(previous, value), low: Math.min(previous, value) }
    })
    const counterfactualPathFixed = counterfactualPath.map((value) =>
      displayNumberToFixed(value),
    )
    const resolved = resolveBattleStep(
      {
        ...escaped.round,
        battlePath: counterfactualPath,
        battlePathFixed: counterfactualPathFixed,
        battleExtrema: counterfactualExtrema,
        battleExtremaFixed: fixedExtrema(counterfactualPathFixed),
      },
      counterfactualPath.length - 1,
    )
    expect(getPlayer(resolved).outcome).toBe('escaped')
    expect(getPlayer(resolved).escape?.bankedScore).toBe(banked)

    const result = finishRound(resolved, 74_000)
    expect(result.summary?.outcome).toBe('escaped')
    expect(result.summary?.score).toBe(banked)
    expect(result.summary?.escape?.holdOutcome).toBe('would-hit')
    expect(result.summary?.headline).toMatch(/ESCAPE|BANKED/)
    expect(result.summary?.survived).toBe(
      result.contenders.filter((contender) => contender.outcome === 'survived').length,
    )
    expect(result.summary?.escaped).toBe(
      result.contenders.filter((contender) => contender.outcome === 'escaped').length,
    )
  })

  it('keeps the original survival-only loop and pacing semantics available', () => {
    const placement = startPlacement(createRound('legacy-survival', deck), 0)
    const result = playBattleToEnd(
      lockPlacements(updateBotsForPlacement(placement, 5_250), 6_000),
    )
    expect(result.escapeEnabled).toBe(false)
    expect(result.contenders.some((contender) => contender.outcome === 'escaped')).toBe(false)
    expect(roundPacing(result).escaped).toBe(0)
    expect(roundPacing(result).survivors).toBe(result.summary?.survived)
  })
})

describe('public-state bot Escape policy', () => {
  it('is deterministic, persona-specific, and cannot react to an unseen future', () => {
    const base = controlledBattle('bot-escape-public-state', 121)
    const start = base.battlePath[0]!
    const flatPath = base.battlePath.map(() => start)
    const startFixed = base.battlePathFixed?.[0] ?? displayNumberToFixed(start)
    const flatPathFixed = flatPath.map(() => startFixed)
    const flatExtrema = flatPath.map(() => ({ high: start, low: start }))
    const futureA = {
      ...base,
      battlePath: flatPath,
      battlePathFixed: flatPathFixed,
      battleExtrema: flatExtrema,
      battleExtremaFixed: fixedExtrema(flatPathFixed),
    }
    const volatilePath = flatPath.map((value, index) => index > 108 ? value * 1.8 : value)
    const volatilePathFixed = volatilePath.map((value) => displayNumberToFixed(value))
    const futureB = {
      ...base,
      battlePath: volatilePath,
      battlePathFixed: volatilePathFixed,
      battleExtrema: volatilePath.map((value, index) => {
        const previous = volatilePath[index - 1] ?? value
        return { high: Math.max(previous, value), low: Math.min(previous, value) }
      }),
      battleExtremaFixed: fixedExtrema(volatilePathFixed),
    }
    const first = resolveBattleStep(futureA, 108)
    const second = resolveBattleStep(futureB, 108)
    const firstEscapes = first.feed.filter((event) => event.type === 'escape')
    const secondEscapes = second.feed.filter((event) => event.type === 'escape')
    expect(firstEscapes.length).toBeGreaterThan(0)
    expect(firstEscapes).toEqual(secondEscapes)
    expect(first.contenders).toEqual(second.contenders)
    expect(new Set(firstEscapes.map((event) => event.contenderIds[0])).size).toBe(
      firstEscapes.length,
    )
    expect(first.feed.map((event) => event.sequence)).toEqual(
      first.feed.map((_, index) => index),
    )

    const direct = decideBotEscapes({
      seed: first.botSeed,
      deck: first.deck,
      lineValue: first.lineValue,
      lineValueFixed: first.lineValueFixed,
      battleFrame: first.battleIndex,
      battleSteps: first.battlePath.length,
      contenders: first.contenders,
    })
    expect(direct).toEqual(
      decideBotEscapes({
        seed: first.botSeed,
        deck: first.deck,
        lineValue: first.lineValue,
        lineValueFixed: first.lineValueFixed,
        battleFrame: first.battleIndex,
        battleSteps: first.battlePath.length,
        contenders: first.contenders,
      }),
    )
  })
})
