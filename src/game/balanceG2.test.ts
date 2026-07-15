import { describe, expect, it } from 'vitest'
import { DECKS } from './decks'
import {
  createRound,
  getPlayer,
  lockPlacements,
  startPlacement,
  updateBotsForPlacement,
} from './round'
import { generateCanonicalBattlePaths } from './path'
import {
  barrierForPlacement,
  distanceForSurvivalProbability,
} from './scoring'

const SCALE = 1_000_000_000_000n
const LOBBIES_PER_DECK = 4
const CONTINUATIONS_PER_LOBBY = 320
const TWO_SIDED_LOBBY_TARGET = 0.99
const TYPICAL_RISK_BANDS = 6

/**
 * The eight public placement bands are probability deciles 10% through 89%.
 * Mid-decile targets avoid classifying a value on a floating/fixed boundary.
 */
const TARGET_BANDS = [0.14, 0.24, 0.34, 0.44, 0.54, 0.64, 0.74, 0.84] as const

interface PairedBandSample {
  expected: number
  realized: number
  realizedDelta: number
}

interface LockedCandidate {
  side: 'upper' | 'lower'
  barrier: number
  terminalScore: number
  expectedScore: number
}

interface CampaignRow {
  deck: string
  band: number
  samples: number
  expectedMean: number
  realizedMean: number
  realizedAdvantageUcb99: number
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function standardError(values: readonly number[]): number {
  if (values.length < 2) return Number.POSITIVE_INFINITY
  const average = mean(values)
  const variance = values.reduce(
    (sum, value) => sum + (value - average) ** 2,
    0,
  ) / (values.length - 1)
  return Math.sqrt(variance / values.length)
}

function fixedToNumber(value: string): number {
  return Number(BigInt(value)) / Number(SCALE)
}

function riskDecile(probabilityFixed: string): number {
  return Number((BigInt(probabilityFixed) * 10n) / SCALE)
}

function percentile(values: readonly number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(probability * sorted.length)),
  )
  return sorted[index] as number
}

/** Exact production touch boundary over the committed interval extrema. */
function survivesCommittedPath(
  side: 'upper' | 'lower',
  barrier: number,
  extrema: readonly { high: number; low: number }[],
): boolean {
  for (let index = 1; index < extrema.length; index += 1) {
    const interval = extrema[index]
    if (!interval) throw new Error(`Missing interval extrema ${index}`)
    if (side === 'upper' ? interval.high >= barrier : interval.low <= barrier) {
      return false
    }
  }
  return true
}

describe('G2 production-engine balance campaign', () => {
  it('has no materially dominant probability band across all four decks', () => {
    const report: CampaignRow[] = []

    for (const deck of DECKS) {
      const samplesByBand = new Map<number, PairedBandSample[]>()
      const lobbyBandCounts: number[] = []
      const naturalCrowdFactors: number[] = []
      let twoSidedLobbies = 0

      for (let lobbyIndex = 0; lobbyIndex < LOBBIES_PER_DECK; lobbyIndex += 1) {
        const seed = `g2-${deck.id}-${lobbyIndex}`
        const placed = updateBotsForPlacement(
          startPlacement(createRound(seed, deck), 0),
          5_250,
        )
        const naturalBands = new Set(
          placed.contenders.map((contender) => {
            if (!contender.fixedScore) throw new Error('SolMath lock terms are required')
            naturalCrowdFactors.push(fixedToNumber(contender.fixedScore.crowdFactor))
            return riskDecile(contender.fixedScore.survivalProbability)
          }),
        )
        lobbyBandCounts.push(naturalBands.size)
        if (new Set(placed.contenders.map((contender) => contender.side)).size === 2) {
          twoSidedLobbies += 1
        }

        const candidatesByBand = new Map<number, LockedCandidate[]>()
        for (const targetProbability of TARGET_BANDS) {
          const band = Math.floor(targetProbability * 10)
          const candidates: LockedCandidate[] = []

          for (const side of ['upper', 'lower'] as const) {
            const distance = distanceForSurvivalProbability(
              targetProbability,
              placed.lineValue,
              side,
            )
            const scenario = {
              ...placed,
              contenders: placed.contenders.map((contender) =>
                contender.isPlayer
                  ? {
                      ...contender,
                      side,
                      distance,
                      barrier: barrierForPlacement(placed.lineValue, side, distance),
                      closestApproach: distance,
                    }
                  : contender,
              ),
            }
            const locked = lockPlacements(scenario, 6_000)
            const player = getPlayer(locked)
            if (!player.fixedScore) throw new Error('SolMath lock terms are required')
            expect(riskDecile(player.fixedScore.survivalProbability)).toBe(band)

            const terminalScore = fixedToNumber(player.fixedScore.terminalScore)
            const expectedScore = fixedToNumber(
              ((BigInt(player.fixedScore.survivalProbability)
                * BigInt(player.fixedScore.terminalScore)) / SCALE).toString(),
            )
            candidates.push({ side, barrier: player.barrier, terminalScore, expectedScore })
          }
          candidatesByBand.set(band, candidates)
        }

        // Path seed is independent of the bot seed. Reusing each fresh path
        // across every candidate is a common-random-number experiment, not a
        // future-information input to placement.
        for (
          let continuationIndex = 0;
          continuationIndex < CONTINUATIONS_PER_LOBBY;
          continuationIndex += 1
        ) {
          const continuationSeed = `g2-path-${deck.id}-${lobbyIndex}-${continuationIndex}`
          const { battleExtrema } = generateCanonicalBattlePaths(
            continuationSeed,
            deck,
            placed.lineValue,
          )
          const continuationSamples: Array<{ band: number; sample: PairedBandSample }> = []

          for (const [band, candidates] of candidatesByBand) {
            const realized = mean(candidates.map((candidate) =>
              survivesCommittedPath(candidate.side, candidate.barrier, battleExtrema)
                ? candidate.terminalScore
                : 0,
            ))
            continuationSamples.push({
              band,
              sample: {
                expected: mean(candidates.map((candidate) => candidate.expectedScore)),
                realized,
                realizedDelta: 0,
              },
            })
          }

          const roundBaseline = mean(
            continuationSamples.map(({ sample }) => sample.realized),
          )
          for (const { band, sample } of continuationSamples) {
            // The paired delta removes most round-to-round path noise: every band
            // sees the same committed path and final public bot placements.
            sample.realizedDelta = sample.realized - roundBaseline
            const existing = samplesByBand.get(band) ?? []
            existing.push(sample)
            samplesByBand.set(band, existing)
          }
        }
      }

      const allSamples = [...samplesByBand.values()].flat()
      const deckExpectedMean = mean(allSamples.map((sample) => sample.expected))
      const expectedMeans = [...samplesByBand.values()].map((samples) =>
        mean(samples.map((sample) => sample.expected)),
      )

      expect(samplesByBand.size).toBe(TARGET_BANDS.length)
      expect(percentile(lobbyBandCounts, 0.5)).toBeGreaterThanOrEqual(TYPICAL_RISK_BANDS)
      expect(twoSidedLobbies / LOBBIES_PER_DECK).toBeGreaterThanOrEqual(TWO_SIDED_LOBBY_TARGET)
      const minimumCrowd = Math.min(...naturalCrowdFactors)
      const maximumCrowd = Math.max(...naturalCrowdFactors)
      expect(minimumCrowd).toBeLessThanOrEqual(0.76)
      expect(maximumCrowd).toBeGreaterThanOrEqual(1.05)
      expect(maximumCrowd - minimumCrowd).toBeGreaterThanOrEqual(0.3)
      if (import.meta.env.VITE_BALANCE_REPORT === '1') {
        console.info(deck.id, 'natural crowd range', {
          minimum: minimumCrowd,
          maximum: maximumCrowd,
        })
      }

      // Exact SolMath lock terms keep the ex-ante ladder within a 15% material
      // advantage envelope. Crowd bonuses can reward an empty location, but no
      // probability decile is a generally optimal answer.
      expect(Math.max(...expectedMeans) / deckExpectedMean).toBeLessThan(1.15)

      for (const [band, samples] of [...samplesByBand].sort(([left], [right]) => left - right)) {
        const expectedMean = mean(samples.map((sample) => sample.expected))
        const realizedMean = mean(samples.map((sample) => sample.realized))
        const deltas = samples.map((sample) => sample.realizedDelta)
        const advantageUcb99 = mean(deltas) + 2.576 * standardError(deltas)

        // A one-sided 99% paired upper confidence bound excludes a material
        // (>22% of lobby expected value) realized advantage for every band.
        expect(advantageUcb99 / deckExpectedMean).toBeLessThan(0.22)

        // The realized campaign also has to agree with the production quote.
        // Three standard errors plus 3% accommodates deterministic finite-run
        // noise without allowing a miscalibrated monitoring implementation.
        const realizedError = Math.abs(realizedMean - expectedMean)
        const realizedValues = samples.map((sample) => sample.realized)
        expect(realizedError).toBeLessThanOrEqual(
          3 * standardError(realizedValues) + 0.03 * deckExpectedMean,
        )

        report.push({
          deck: deck.id,
          band,
          samples: samples.length * 2,
          expectedMean,
          realizedMean,
          realizedAdvantageUcb99: advantageUcb99 / deckExpectedMean,
        })
      }
    }

    if (import.meta.env.VITE_BALANCE_REPORT === '1') {
      console.table(report.map((row) => ({
        deck: row.deck,
        band: `${row.band}0–${row.band}9%`,
        samples: row.samples,
        expected: row.expectedMean.toFixed(2),
        realized: row.realizedMean.toFixed(2),
        '99% advantage UCB': `${(row.realizedAdvantageUcb99 * 100).toFixed(1)}%`,
      })))
    }
  }, 120_000)
})
