import { describe, expect, it } from 'vitest'
import { DECKS } from './decks'
import { estimateSurvivalProbability } from './scoring'
import {
  createRound,
  lockPlacements,
  playBattleToEnd,
  roundPacing,
  startPlacement,
  updateBotsForPlacement,
} from './round'

describe('fun-pacing simulation', () => {
  it('keeps the shipped decks in the intended dramatic survivor range', async () => {
    const requestedSamples = Number(import.meta.env.VITE_BALANCE_SAMPLES ?? 24)
    const samplesPerDeck = Number.isInteger(requestedSamples) && requestedSamples >= 24
      ? requestedSamples
      : 24
    const requestedDeck = import.meta.env.VITE_BALANCE_DECK
    const selectedDecks = requestedDeck
      ? DECKS.filter((deck) => deck.id === requestedDeck)
      : DECKS
    expect(selectedDecks.length).toBeGreaterThan(0)
    const simulate = (deck: typeof DECKS[number], index: number) => {
      const placement = startPlacement(createRound(`balance-${deck.id}-${index}`, deck), 0)
      const jockeyed = updateBotsForPlacement(placement, 5_250)
      const result = playBattleToEnd(lockPlacements(jockeyed, 6_000))
      const riskBands = new Set(
        jockeyed.contenders.map((contender) =>
          Math.floor(estimateSurvivalProbability(
            contender.distance,
            jockeyed.lineValue,
            contender.side,
          ) * 10),
        ),
      )
      return {
        deck: deck.id,
        expected: jockeyed.contenders.reduce(
          (sum, contender) =>
            sum + estimateSurvivalProbability(contender.distance, jockeyed.lineValue),
          0,
        ),
        firstTenSecondHits: result.feed.filter(
          (event) => event.type === 'hit' && event.at <= 10 / 60,
        ).length,
        firstTenSecondMassCluster: result.feed.some(
          (event) => (
            event.type === 'cluster'
            && event.contenderIds.length >= 3
            && event.at <= 10 / 60
          ),
        ),
        tenToFifteenSecondHits: result.feed.filter(
          (event) => event.type === 'hit' && event.at > 10 / 60 && event.at <= 15 / 60,
        ).length,
        tenToFifteenSecondMassCluster: result.feed.some(
          (event) => (
            event.type === 'cluster'
            && event.contenderIds.length >= 3
            && event.at > 10 / 60
            && event.at <= 15 / 60
          ),
        ),
        riskBands: riskBands.size,
        sides: new Set(jockeyed.contenders.map((contender) => contender.side)).size,
        ...roundPacing(result),
      }
    }
    const samples: Array<ReturnType<typeof simulate>> = []
    for (const deck of selectedDecks) {
      for (let start = 0; start < samplesPerDeck; start += 64) {
        const count = Math.min(64, samplesPerDeck - start)
        samples.push(...Array.from({ length: count }, (_, offset) => simulate(deck, start + offset)))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    }
    const survivors = samples.map((sample) => sample.survivors).sort((left, right) => left - right)
    const median = survivors[Math.floor(survivors.length / 2)] as number
    const noEliminationRate = samples.filter((sample) => sample.survivors === 20).length / samples.length
    const clusterRate = samples.filter((sample) => sample.largestCluster >= 3).length / samples.length
    const earlyHitStressRate =
      samples.filter((sample) => sample.firstTenSecondHits >= 8).length / samples.length
    const earlyMassClusterRate =
      samples.filter((sample) => sample.firstTenSecondMassCluster).length / samples.length
    const averageSurvivors = survivors.reduce((sum, value) => sum + value, 0) / survivors.length
    const modelExpected = samples.reduce((sum, sample) => sum + sample.expected, 0) / samples.length
    const bandCounts = samples.map((sample) => sample.riskBands).sort((left, right) => left - right)
    const medianRiskBands = bandCounts[Math.floor(bandCounts.length / 2)] as number
    const twoSidedLobbyRate = samples.filter((sample) => sample.sides === 2).length / samples.length

    if (import.meta.env.VITE_BALANCE_REPORT === '1') {
      console.table([...selectedDecks.map((deck) => {
        const rows = samples.filter((sample) => sample.deck === deck.id)
        const ordered = rows.map((row) => row.survivors).sort((left, right) => left - right)
        return {
          deck: deck.id,
          medianSurvivors: ordered[Math.floor(ordered.length / 2)],
          averageSurvivors: rows.reduce((sum, row) => sum + row.survivors, 0) / rows.length,
          noEliminationRate: rows.filter((row) => row.survivors === 20).length / rows.length,
          first10sNoEliminationRate: rows.filter((row) => row.firstTenSecondHits === 0).length / rows.length,
          first10sMassClusterRate: rows.filter((row) => row.firstTenSecondMassCluster).length / rows.length,
          first10sEightHitStressRate: rows.filter((row) => row.firstTenSecondHits >= 8).length / rows.length,
          seconds10to15AverageHits: rows.reduce((sum, row) => sum + row.tenToFifteenSecondHits, 0) / rows.length,
          seconds10to15MassClusterRate: rows.filter((row) => row.tenToFifteenSecondMassCluster).length / rows.length,
          anyBattleClusterRate: rows.filter((row) => row.largestCluster >= 3).length / rows.length,
        }
      }), {
        deck: 'ALL',
        medianSurvivors: median,
        averageSurvivors,
        noEliminationRate,
        first10sNoEliminationRate: samples.filter((row) => row.firstTenSecondHits === 0).length / samples.length,
        first10sMassClusterRate: earlyMassClusterRate,
        first10sEightHitStressRate: earlyHitStressRate,
        seconds10to15AverageHits: samples.reduce((sum, row) => sum + row.tenToFifteenSecondHits, 0) / samples.length,
        seconds10to15MassClusterRate: samples.filter((row) => row.tenToFifteenSecondMassCluster).length / samples.length,
        anyBattleClusterRate: clusterRate,
      }])
    }

    expect(median).toBeGreaterThanOrEqual(2)
    expect(median).toBeLessThanOrEqual(6)
    expect(noEliminationRate).toBeLessThan(0.1)
    expect(clusterRate).toBeGreaterThan(0.25)
    expect(earlyMassClusterRate).toBeLessThan(0.1)
    expect(earlyHitStressRate).toBeLessThan(0.1)
    expect(medianRiskBands).toBeGreaterThanOrEqual(6)
    expect(twoSidedLobbyRate).toBe(1)
    expect(Math.abs(averageSurvivors - modelExpected)).toBeLessThan(1.5)
    for (const deck of selectedDecks) {
      const deckSamples = samples.filter((sample) => sample.deck === deck.id)
      const earlyClusterRate = deckSamples.filter(
        (sample) => sample.firstTenSecondMassCluster,
      ).length / deckSamples.length
      expect(earlyClusterRate).toBeLessThan(0.1)
      expect(deckSamples.some((sample) => sample.survivors > 0)).toBe(true)
      expect(deckSamples.some((sample) => sample.survivors < 12)).toBe(true)
    }
  }, 1_200_000)
})
