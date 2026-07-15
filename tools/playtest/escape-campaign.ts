import {
  DECKS,
  lockPlacements,
  playBattleToEnd,
  startPlacement,
  updateBotsForPlacement,
  createRound,
} from '../../src/game/index.ts'

const roundsPerDeck = Number(process.argv[2] ?? 24)
if (!Number.isInteger(roundsPerDeck) || roundsPerDeck < 1) {
  throw new RangeError('rounds-per-deck must be a positive integer')
}

const samples = DECKS.flatMap((deck) =>
  Array.from({ length: roundsPerDeck }, (_, index) => {
    const seed = `escape-campaign:${deck.id}:${index}`
    const placement = startPlacement(createRound(seed, deck, { escapeEnabled: true }), 0)
    const jockeyed = updateBotsForPlacement(placement, 11_250)
    const result = playBattleToEnd(lockPlacements(jockeyed, 12_000))
    return {
      deck: deck.id,
      escaped: result.contenders.filter((contender) => contender.outcome === 'escaped').length,
      survived: result.contenders.filter((contender) => contender.outcome === 'survived').length,
      hit: result.contenders.filter((contender) => contender.outcome === 'hit').length,
      escapedAt: result.contenders.flatMap((contender) =>
        contender.escape ? [contender.escape.at] : [],
      ),
    }
  }),
)

const sortedEscapes = samples.map((sample) => sample.escaped).sort((left, right) => left - right)
const total = (key: 'escaped' | 'survived' | 'hit') =>
  samples.reduce((sum, sample) => sum + sample[key], 0)
const allEscapeTimes = samples.flatMap((sample) => sample.escapedAt)

console.log(JSON.stringify({
  rounds: samples.length,
  meanEscaped: total('escaped') / samples.length,
  medianEscaped: sortedEscapes[Math.floor(sortedEscapes.length / 2)],
  meanSurvived: total('survived') / samples.length,
  meanHit: total('hit') / samples.length,
  meanEscapeProgress: allEscapeTimes.reduce((sum, value) => sum + value, 0) /
    Math.max(1, allEscapeTimes.length),
  decks: Object.fromEntries(DECKS.map((deck) => {
    const deckSamples = samples.filter((sample) => sample.deck === deck.id)
    return [deck.id, {
      escaped: deckSamples.reduce((sum, sample) => sum + sample.escaped, 0) / deckSamples.length,
      survived: deckSamples.reduce((sum, sample) => sum + sample.survived, 0) / deckSamples.length,
      hit: deckSamples.reduce((sum, sample) => sum + sample.hit, 0) / deckSamples.length,
    }]
  })),
}, null, 2))
