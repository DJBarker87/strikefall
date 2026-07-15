import { describe, expect, it } from 'vitest'
import { DECKS } from './decks'
import {
  createRound,
  lockPlacements,
  playBattleToEnd,
  startPlacement,
  updateBotsForPlacement,
} from './round'

describe('Escape-on fun pacing', () => {
  it('keeps exits meaningful without emptying the arena', () => {
    const samples = DECKS.flatMap((deck) =>
      Array.from({ length: 16 }, (_, index) => {
        const seed = `escape-balance:${deck.id}:${index}`
        const placement = startPlacement(
          createRound(seed, deck, { escapeEnabled: true }),
          0,
        )
        const jockeyed = updateBotsForPlacement(placement, 5_250)
        const result = playBattleToEnd(lockPlacements(jockeyed, 6_000))
        return {
          deck: deck.id,
          escaped: result.contenders.filter((contender) => contender.outcome === 'escaped').length,
          survived: result.contenders.filter((contender) => contender.outcome === 'survived').length,
          hit: result.contenders.filter((contender) => contender.outcome === 'hit').length,
        }
      }),
    )
    const escapes = samples.map((sample) => sample.escaped).sort((left, right) => left - right)
    const mean = (key: 'escaped' | 'survived' | 'hit') =>
      samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length

    expect(escapes[Math.floor(escapes.length / 2)]).toBeGreaterThanOrEqual(3)
    expect(escapes[Math.floor(escapes.length / 2)]).toBeLessThanOrEqual(8)
    expect(mean('escaped')).toBeGreaterThanOrEqual(4)
    expect(mean('escaped')).toBeLessThanOrEqual(8)
    expect(mean('survived')).toBeGreaterThanOrEqual(1)
    expect(mean('survived')).toBeLessThanOrEqual(4)
    expect(mean('hit')).toBeGreaterThan(9)
    for (const deck of DECKS) {
      const deckSamples = samples.filter((sample) => sample.deck === deck.id)
      const deckEscapeMean = deckSamples.reduce((sum, sample) => sum + sample.escaped, 0) /
        deckSamples.length
      expect(deckEscapeMean).toBeGreaterThanOrEqual(2)
      expect(deckEscapeMean).toBeLessThanOrEqual(10)
    }
  }, 120_000)
})
