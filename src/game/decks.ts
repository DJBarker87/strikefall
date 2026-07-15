import type { DeckDefinition } from './types'
import { hashSeed } from './rng'

export const DECKS: readonly DeckDefinition[] = [
  {
    id: 'balanced-tape',
    version: 3,
    monitoringConvention: 'strikefall/brownian-bridge-extrema/v1',
    name: 'Balanced Tape',
    kicker: 'No quiet quarter',
    description: 'Pressure stays even from the opening strike to the final second.',
    tacticalHint: 'Trust your spacing. The danger never fully leaves.',
    variance: [1, 1, 1, 1],
    openingRunway: { steps: 40, varianceShareBps: 340 },
    hue: 158,
    tempo: 1,
  },
  {
    id: 'compression-break',
    version: 3,
    monitoringConvention: 'strikefall/brownian-bridge-extrema/v1',
    name: 'Compression Break',
    kicker: 'Calm is a trap',
    description: 'The line coils early, then unloads most of its force near the finish.',
    tacticalHint: 'A close flag looks clever until the last quarter arrives.',
    variance: [0.2, 0.4, 1, 2.4],
    openingRunway: { steps: 40, varianceShareBps: 1600 },
    hue: 42,
    tempo: 0.88,
  },
  {
    id: 'opening-rush',
    version: 3,
    monitoringConvention: 'strikefall/brownian-bridge-extrema/v1',
    name: 'Opening Rush',
    kicker: 'Brace on lock',
    description: 'The first seconds hit hardest before the tape begins to cool.',
    tacticalHint: 'Give the opening room. Greed works better after the first wave.',
    variance: [2.2, 1, 0.6, 0.2],
    openingRunway: { steps: 40, varianceShareBps: 125 },
    hue: 12,
    tempo: 1.16,
  },
  {
    id: 'pulse',
    version: 3,
    monitoringConvention: 'strikefall/brownian-bridge-extrema/v1',
    name: 'Pulse',
    kicker: 'Two storms, one line',
    description: 'Alternating bursts create two distinct windows for cluster wipes.',
    tacticalHint: 'If the first burst misses, the second may finish the job.',
    variance: [0.6, 1.4, 0.6, 1.4],
    openingRunway: { steps: 40, varianceShareBps: 450 },
    hue: 282,
    tempo: 1.08,
  },
] as const

export function selectDeck(index: number): DeckDefinition {
  return DECKS[((index % DECKS.length) + DECKS.length) % DECKS.length] as DeckDefinition
}

export function selectDeckForSeed(seed: string): DeckDefinition {
  return selectDeck(hashSeed(`strikefall/deck:${seed}`))
}

export function getDeck(id: string): DeckDefinition | undefined {
  return DECKS.find((deck) => deck.id === id)
}

export function deckVarianceQuarter(deck: DeckDefinition, progress: number): number {
  const quarter = Math.min(3, Math.max(0, Math.floor(Math.min(progress, 0.999999) * 4)))
  return deck.variance[quarter]
}

export function validateDeck(deck: DeckDefinition): boolean {
  return (
    deck.id.length > 0 &&
    Number.isInteger(deck.version) &&
    deck.version > 0 &&
    deck.monitoringConvention === 'strikefall/brownian-bridge-extrema/v1' &&
    deck.name.length > 0 &&
    deck.variance.length === 4 &&
    deck.variance.every((weight) => Number.isFinite(weight) && weight > 0) &&
    Number.isInteger(deck.openingRunway?.steps) &&
    (deck.openingRunway?.steps ?? 0) > 0 &&
    (deck.openingRunway?.steps ?? 0) < 60 &&
    Number.isInteger(deck.openingRunway?.varianceShareBps) &&
    (deck.openingRunway?.varianceShareBps ?? 0) > 0 &&
    (deck.openingRunway?.varianceShareBps ?? 0) < 10_000 &&
    (deck.openingRunway?.varianceShareBps ?? 0) * 60
      < 10_000 * (deck.openingRunway?.steps ?? 0) &&
    Number.isFinite(deck.tempo) &&
    deck.tempo > 0
  )
}
