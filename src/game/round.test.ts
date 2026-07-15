import { describe, expect, it } from 'vitest'
import {
  PHASE_DURATIONS,
  beginBattle,
  buildRoundSummary,
  createHomeRound,
  createRound,
  finishRound,
  getPlayer,
  lockPlacements,
  playBattleToEnd,
  resolveBattleStep,
  resumeRoundAfterPause,
  roundPacing,
  startPlacement,
  tickRound,
  updateBotsForPlacement,
  updatePlayerPlacement,
} from './round'
import { botProfilesForPractice } from './bots'
import { getDeck } from './decks'
import { legalDistanceBounds } from './scoring'

const deck = getDeck('balanced-tape')!

describe('round engine', () => {
  it('constructs one player plus 19 bots from a replayable seed', () => {
    const first = createRound('round-fixture', deck, { now: 1_000 })
    const second = createRound('round-fixture', deck, { now: 1_000 })
    expect(first).toEqual(second)
    expect(first.contenders).toHaveLength(20)
    expect(first.contenders.filter((contender) => contender.isPlayer)).toHaveLength(1)
    expect(first.phase).toBe('deck')
    expect(first.timeRemaining).toBe(5_000)
    expect(first.battlePathFixed).toHaveLength(first.battlePath.length)
    expect(first.battleExtremaFixed).toHaveLength(first.battleExtrema.length)
    expect(first.lineValueFixed).toBe(first.battlePathFixed?.[0])
    expect(first.contenders.every((contender) => /^\d+$/.test(contender.barrierFixed ?? '')))
      .toBe(true)
  })

  it('constructs a compact practice lobby without changing the default cast', () => {
    const compact = createRound('compact-round', deck, {
      botProfiles: botProfilesForPractice(9),
    })
    expect(compact.contenders).toHaveLength(10)
    expect(compact.feed[0]?.detail).toContain('9 disclosed bots online')
    expect(createRound('default-round', deck).contenders).toHaveLength(20)
  })

  it('provides a safe home preview state', () => {
    const home = createHomeRound('home', { now: 500 })
    expect(home.phase).toBe('home')
    expect(home.phaseStartedAt).toBe(500)
    expect(home.phaseDuration).toBe(0)
  })

  it('clamps player placement and refreshes score/crowding', () => {
    const placement = startPlacement(createRound('place', deck), 0)
    const bounds = legalDistanceBounds(placement.battlePath[0]!, 'lower')
    const moved = updatePlayerPlacement(placement, 'lower', 1_000_000)
    const player = getPlayer(moved)
    expect(player.side).toBe('lower')
    expect(player.distance).toBe(bounds.maximum)
    expect(player.barrier).toBeCloseTo(moved.battlePath[0]! - bounds.maximum, 4)
    expect(player.potential).toBeGreaterThan(0)
  })

  it('runs deterministic visible bot decisions and locks fixed score terms', () => {
    const placement = startPlacement(createRound('jockey', deck), 0)
    const moved = updateBotsForPlacement(placement, 5_250)
    expect(moved.contenders.flatMap((contender) => contender.moves).every((move) => move.completed)).toBe(true)
    const locked = lockPlacements(moved, 6_000)
    expect(locked.phase).toBe('lock')
    expect(locked.feed.some((event) => event.type === 'lock')).toBe(true)
    expect(locked.contenders.every((contender) => (
      /^\d+$/.test(contender.barrierFixed ?? '')
      && /^\d+$/.test(contender.fixedScore?.terminalScore ?? '')
    ))).toBe(true)
    expect(getPlayer(locked).potential).toBe(
      Math.round(100 * getPlayer(locked).risk * getPlayer(locked).crowd),
    )
  })

  it('resolves hit events incrementally without duplicating them', () => {
    const locked = lockPlacements(startPlacement(createRound('hits', deck), 0), 6_000)
    const battle = beginBattle(locked, 14_000)
    const midpoint = Math.floor(battle.battlePath.length / 2)
    const once = resolveBattleStep(battle, midpoint)
    const again = resolveBattleStep(once, midpoint)
    expect(again).toEqual(once)
    expect(new Set(again.feed.map((event) => event.id)).size).toBe(again.feed.length)
  })

  it('fails closed before an exact Practice battle can lose fixed state', () => {
    const battle = beginBattle(
      lockPlacements(startPlacement(createRound('exact-state-guard', deck), 0), 6_000),
      14_000,
    )
    expect(() => resolveBattleStep({
      ...battle,
      battleExtrema: battle.battleExtrema.slice(0, -1),
      battleExtremaFixed: battle.battleExtremaFixed?.slice(0, -1),
    }, battle.battlePath.length - 1)).toThrow(/missing exact path\/extrema/)
    expect(() => resolveBattleStep({
      ...battle,
      contenders: battle.contenders.map((contender, index) => (
        index === 0 ? { ...contender, barrierFixed: undefined } : contender
      )),
    }, 1)).toThrow(/missing exact lock data/)
  })

  it('fails closed when a new Practice battle loses its exact path projection', () => {
    const battle = beginBattle(
      lockPlacements(startPlacement(createRound('missing-exact-path', deck), 0), 6_000),
      14_000,
    )
    expect(() => resolveBattleStep({ ...battle, battlePathFixed: undefined }, 1))
      .toThrow(/exact path/)
  })

  it('marks survivors, ranks all 20 and writes a result story', () => {
    const round = createRound('result', deck)
    const result = playBattleToEnd(lockPlacements(startPlacement(round, 0), 6_000), 74_000)
    expect(result.phase).toBe('result')
    expect(result.summary).not.toBeNull()
    expect(result.summary?.rank).toBeGreaterThanOrEqual(1)
    expect(result.summary?.rank).toBeLessThanOrEqual(20)
    expect(result.contenders.every((contender) => contender.outcome !== 'active')).toBe(true)
    expect(result.feed.at(-1)?.type).toBe('survivor')
    expect(buildRoundSummary(result.contenders)).toEqual(result.summary)
  })

  it('uses canonical scores and hit frames for exact Practice rank ties', () => {
    const locked = lockPlacements(
      startPlacement(createRound('exact-rank-tie', deck), 0),
      6_000,
    )
    const player = getPlayer(locked)
    const bot = locked.contenders.find((contender) => !contender.isPlayer)!
    const exactTie = [
      {
        ...player,
        outcome: 'hit' as const,
        hitAt: 0.99,
        hitFrameExact: '10',
        potential: 999_999,
      },
      {
        ...bot,
        outcome: 'hit' as const,
        hitAt: 0.01,
        hitFrameExact: '11',
        potential: 1,
      },
    ]
    expect(buildRoundSummary(exactTie).rank).toBe(2)
    expect(() => buildRoundSummary([
      exactTie[0]!,
      { ...exactTie[1]!, fixedScore: undefined },
    ])).toThrow(/canonical score/)
    expect(() => buildRoundSummary([
      exactTie[0]!,
      { ...exactTie[1]!, hitFrameExact: undefined },
    ])).toThrow(/canonical hit frame/)
  })

  it('ranks equal display scores by their exact fixed terminal values', () => {
    const round = createRound('exact-rank', deck)
    const rival = round.contenders.find((contender) => !contender.isPlayer)
    if (!rival) throw new Error('Expected a rival')
    const contenders = round.contenders.map((contender, index) => {
      if (contender.isPlayer) {
        return {
          ...contender,
          outcome: 'survived' as const,
          potential: 100,
          fixedScore: {
            ...contender.fixedScore!,
            terminalScore: '100000000000001',
          },
        }
      }
      if (contender.id === rival.id) {
        return {
          ...contender,
          outcome: 'survived' as const,
          potential: 100,
          fixedScore: {
            ...contender.fixedScore!,
            terminalScore: '100000000000002',
          },
        }
      }
      return {
        ...contender,
        outcome: 'hit' as const,
        hitAt: index / round.contenders.length,
        hitFrameExact: index.toString(),
      }
    })
    expect(buildRoundSummary(contenders).rank).toBe(2)
  })

  it('ticks through the complete declared phase timeline', () => {
    const startedAt = 10_000
    const round = createRound('clock', deck, { now: startedAt, battleSteps: 61 })
    const placementStart = startedAt + PHASE_DURATIONS.deck + PHASE_DURATIONS.approach
    const placement = tickRound(round, placementStart + 3_000)
    expect(placement.phase).toBe('placement')
    expect(placement.phaseProgress).toBeCloseTo(0.5)
    expect(placement.timeRemaining).toBeCloseTo(3_000)

    const resultAt =
      startedAt +
      PHASE_DURATIONS.deck +
      PHASE_DURATIONS.approach +
      PHASE_DURATIONS.placement +
      PHASE_DURATIONS.lock +
      PHASE_DURATIONS.battle
    const result = tickRound(placement, resultAt)
    expect(result.phase).toBe('result')
    expect(result.summary).not.toBeNull()
  })

  it('re-anchors a paused phase without consuming game time', () => {
    const startedAt = 10_000
    const beforePause = tickRound(
      createRound('paused-clock', deck, { now: startedAt }),
      startedAt + 2_400,
    )
    const resumed = resumeRoundAfterPause(beforePause, 45_000)
    const sameGameInstant = tickRound(resumed, startedAt + 2_400 + 45_000)
    expect(sameGameInstant.phase).toBe(beforePause.phase)
    expect(sameGameInstant.phaseProgress).toBeCloseTo(beforePause.phaseProgress, 10)
    expect(sameGameInstant.timeRemaining).toBeCloseTo(beforePause.timeRemaining, 10)
    expect(() => resumeRoundAfterPause(beforePause, -1)).toThrow(RangeError)
  })

  it('reports pacing signals from authoritative events', () => {
    const base = createRound('pacing', deck)
    const result = playBattleToEnd(lockPlacements(startPlacement(base, 0), 6_000))
    const pacing = roundPacing(result)
    expect(pacing.survivors).toBe(result.summary?.survived)
    expect(pacing.firstHitAt === null || pacing.firstHitAt >= 0).toBe(true)
    expect(pacing.largestCluster).toBeGreaterThanOrEqual(0)
  })

  it('can finish an already-resolved battle without changing locked scores', () => {
    const battle = beginBattle(lockPlacements(startPlacement(createRound('fixed', deck), 0), 6_000), 14_000)
    const resolved = resolveBattleStep(battle, battle.battlePath.length - 1)
    const scores = resolved.contenders.map((contender) => contender.potential)
    const result = finishRound(resolved, 74_000)
    expect(result.contenders.map((contender) => contender.potential)).toEqual(scores)
  })
})
