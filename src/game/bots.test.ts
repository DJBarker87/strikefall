import { describe, expect, it } from 'vitest'
import type { Contender, Persona } from './types'
import {
  advanceBotPlacements,
  BOT_PROFILES,
  botProfilesForPractice,
  createBotContenders,
  isCanonicalPracticeBotRoster,
} from './bots'
import { getDeck } from './decks'
import { generateApproach } from './path'
import { barrierForPlacement, distanceForSurvivalProbability } from './scoring'
import { estimateSurvivalProbability } from './scoring'

const deck = getDeck('pulse')!
const approach = generateApproach('bot-approach', deck)
const lineValue = approach.at(-1)!.close

function player(): Contender {
  const distance = distanceForSurvivalProbability(0.45, lineValue)
  return {
    id: 'player',
    name: 'YOU',
    persona: 'Player',
    isPlayer: true,
    side: 'upper',
    distance,
    barrier: barrierForPlacement(lineValue, 'upper', distance),
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

describe('transparent bot lobby', () => {
  it('ships 19 stable rivals covering all eight personas', () => {
    expect(BOT_PROFILES).toHaveLength(19)
    expect(new Set(BOT_PROFILES.map((profile) => profile.id)).size).toBe(19)
    expect(new Set(BOT_PROFILES.map((profile) => profile.name)).size).toBe(19)
    expect(new Set(BOT_PROFILES.map((profile) => profile.persona))).toEqual(
      new Set<Persona>([
        'Turtle',
        'Sniper',
        'Greedlord',
        'Contrarian',
        'Momentum',
        'Late Bidder',
        'Mimic',
        'Chaos',
      ]),
    )
  })

  it('creates a deterministic, clearly labelled two-sided lobby', () => {
    const first = createBotContenders('bot-seed', deck, approach, lineValue, 'normal', [player()])
    const second = createBotContenders('bot-seed', deck, approach, lineValue, 'normal', [player()])
    expect(first).toEqual(second)
    expect(first).toHaveLength(19)
    expect(first.every((bot) => !bot.isPlayer && bot.persona !== 'Player')).toBe(true)
    expect(new Set(first.map((bot) => bot.side))).toEqual(new Set(['upper', 'lower']))
  })

  it('offers a stable nine-bot cast with every persona represented', () => {
    const compact = botProfilesForPractice(9)
    expect(compact).toHaveLength(9)
    expect(new Set(compact.map((profile) => profile.persona))).toEqual(
      new Set<Persona>([
        'Turtle',
        'Sniper',
        'Greedlord',
        'Contrarian',
        'Momentum',
        'Late Bidder',
        'Mimic',
        'Chaos',
      ]),
    )
    expect(isCanonicalPracticeBotRoster(compact)).toBe(true)
    expect(isCanonicalPracticeBotRoster([...compact].reverse())).toBe(false)
    const bots = createBotContenders(
      'compact-seed',
      deck,
      approach,
      lineValue,
      'normal',
      [player()],
      compact,
    )
    expect(bots.map((bot) => bot.id)).toEqual(compact.map((profile) => profile.id))
  })

  it('schedules at most three human-readable moves before input freeze', () => {
    const bots = createBotContenders('move-schedule', deck, approach, lineValue)
    for (const bot of bots) {
      expect(bot.moves.length).toBeGreaterThanOrEqual(1)
      expect(bot.moves.length).toBeLessThanOrEqual(3)
      expect(bot.moves.every((move) => move.at >= 250 && move.at <= 5_250)).toBe(true)
      expect([...bot.moves].sort((left, right) => left.at - right.at)).toEqual(bot.moves)
    }
  })

  it('replays decisions exactly and leaves an audit trace', () => {
    const initial = [
      player(),
      ...createBotContenders('decision-seed', deck, approach, lineValue, 'normal', [player()]),
    ]
    const options = { seed: 'decision-seed', deck, approach, lineValue, difficulty: 'normal' as const }
    const first = advanceBotPlacements(initial, 5_250, options)
    const second = advanceBotPlacements(initial, 5_250, options)
    expect(first).toEqual(second)
    expect(first.traces.length).toBeGreaterThan(10)
    expect(first.traces.every((trace) => trace.candidateCount >= 12)).toBe(true)
    expect(first.contenders.every((contender) => contender.moves.length <= 3)).toBe(true)
    expect(first.contenders.flatMap((contender) => contender.moves).every((move) => move.completed)).toBe(true)
    const riskBands = new Set(
      first.contenders.map((contender) =>
        Math.round(estimateSurvivalProbability(contender.distance, lineValue) * 10),
      ),
    )
    expect(riskBands.size).toBeGreaterThanOrEqual(6)
  })

  it('reacts to visible player movement without accepting any future path input', () => {
    const nearPlayer = player()
    const bots = createBotContenders('mimic-seed', deck, approach, lineValue, 'normal', [nearPlayer])
    const movedPlayer = {
      ...nearPlayer,
      side: 'lower' as const,
      distance: distanceForSurvivalProbability(0.2, lineValue),
    }
    movedPlayer.barrier = barrierForPlacement(lineValue, movedPlayer.side, movedPlayer.distance)
    const result = advanceBotPlacements([movedPlayer, ...bots], 5_250, {
      seed: 'mimic-seed',
      deck,
      approach,
      lineValue,
    })
    const mimics = result.contenders.filter((contender) => contender.persona === 'Mimic')
    expect(mimics.filter((bot) => bot.side === movedPlayer.side).length).toBeGreaterThanOrEqual(2)
  })

  it('produces distinguishable easy, normal, and hard public-information distributions', () => {
    const result = (['easy', 'normal', 'hard'] as const).map((difficulty) => {
      const potentials: number[] = []
      let moves = 0
      for (let index = 0; index < 8; index += 1) {
        const seed = `difficulty-${index}`
        const human = player()
        const initial = [
          human,
          ...createBotContenders(seed, deck, approach, lineValue, difficulty, [human]),
        ]
        const advanced = advanceBotPlacements(initial, 5_250, {
          seed,
          deck,
          approach,
          lineValue,
          difficulty,
        })
        potentials.push(...advanced.contenders.filter((entry) => !entry.isPlayer).map((entry) => entry.potential))
        moves += advanced.movedIds.length
      }
      const mean = potentials.reduce((sum, value) => sum + value, 0) / potentials.length
      const deviation = Math.sqrt(potentials.reduce((sum, value) => sum + (value - mean) ** 2, 0) / potentials.length)
      return { difficulty, mean, deviation, moves }
    })
    const [easy, normal, hard] = result
    expect(easy?.moves).toBeLessThan(normal?.moves ?? 0)
    expect(normal?.moves).toBeLessThan(hard?.moves ?? 0)
    // Harder bots spend more decisions on public crowd/forecast information;
    // that changes the distribution but does not imply a monotone raw score.
    // Each tier must stay distinguishable from the others in location or
    // spread, though which axis separates a given pair depends on pacing.
    const pairs = [[easy, normal], [easy, hard], [normal, hard]] as const
    for (const [left, right] of pairs) {
      const meanGap = Math.abs((left?.mean ?? 0) - (right?.mean ?? 0))
      const deviationGap = Math.abs((left?.deviation ?? 0) - (right?.deviation ?? 0))
      expect(
        meanGap > 5 || deviationGap > 10,
        `${left?.difficulty} vs ${right?.difficulty} means ${meanGap.toFixed(2)} apart, deviations ${deviationGap.toFixed(2)} apart`,
      ).toBe(true)
    }
  }, 120_000)
})
