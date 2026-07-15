import { describe, expect, it } from 'vitest'
import type { Contender, FeedEvent, RoundSummary } from '../game/types'
import {
  createProfileRoundRival,
  createRivalryShareContext,
  selectRelevantRoundRival,
} from './rivalry'

function contender(update: Partial<Contender> = {}): Contender {
  return {
    id: 'player',
    name: 'YOU',
    persona: 'Player',
    isPlayer: true,
    side: 'upper',
    distance: 8,
    barrier: 108,
    risk: 2,
    crowd: 1,
    potential: 400,
    color: '#fff',
    outcome: 'survived',
    hitAt: null,
    closestApproach: 1,
    escape: null,
    moves: [],
    ...update,
  }
}

function summary(): RoundSummary {
  return {
    outcome: 'survived',
    score: 400,
    rank: 2,
    survived: 2,
    escaped: 0,
    closestApproach: 1,
    multiplier: 2,
    crowd: 1,
    headline: 'HELD.',
    escape: null,
  }
}

function cluster(sequence: number, contenderIds: string[], at = 0.7): FeedEvent {
  return {
    id: `cluster-${sequence}`,
    sequence,
    type: 'cluster',
    title: 'Cluster',
    detail: 'Settled event.',
    contenderIds,
    at,
  }
}

describe('current-round rivalry selection', () => {
  it('prioritizes a shared wipe, then the nearest member, deterministically', () => {
    const player = contender({ outcome: 'hit', hitAt: 0.7 })
    const turtle = contender({
      id: 'turtle-private-id',
      name: 'Turtle.exe',
      persona: 'Turtle',
      isPlayer: false,
      barrier: 108.2,
      outcome: 'hit',
      hitAt: 0.7,
    })
    const mimic = contender({
      id: 'mimic-private-id',
      name: 'Mirror',
      persona: 'Mimic',
      isPlayer: false,
      barrier: 108.7,
      outcome: 'hit',
      hitAt: 0.7,
    })
    const result = selectRelevantRoundRival({
      contenders: [mimic, player, turtle],
      feed: [cluster(2, ['player', 'turtle-private-id', 'mimic-private-id'])],
      summary: { ...summary(), outcome: 'eliminated', score: 0 },
    })

    expect(result).toMatchObject({
      contender: { id: 'turtle-private-id' },
      relation: 'shared-wipe',
      eventAt: 0.7,
      copiedPlayer: false,
    })
  })

  it('chooses copy evidence before rank, then nearest rank before placement', () => {
    const player = contender()
    const mimic = contender({
      id: 'mimic',
      name: 'Mirror',
      persona: 'Mimic',
      isPlayer: false,
      barrier: 125,
      potential: 100,
    })
    const rankNeighbour = contender({
      id: 'rank-neighbour',
      name: 'Needle',
      persona: 'Sniper',
      isPlayer: false,
      barrier: 108.1,
      potential: 390,
    })
    const standings = [player, rankNeighbour, mimic]
    expect(selectRelevantRoundRival({
      contenders: [rankNeighbour, mimic, player],
      feed: [],
      summary: summary(),
    }, standings)).toMatchObject({
      contender: { id: 'mimic' },
      relation: 'copied-player',
      copiedPlayer: true,
    })

    const withoutMimic = contender({ ...mimic, id: 'far-turtle', persona: 'Turtle' })
    expect(selectRelevantRoundRival({
      contenders: [withoutMimic, rankNeighbour, player],
      feed: [],
      summary: summary(),
    }, [withoutMimic, player, rankNeighbour])).toMatchObject({
      contender: { id: 'rank-neighbour' },
      relation: 'rank-neighbour',
      playerWon: true,
    })
  })

  it('falls back to nearest placement before results and emits a share-safe history view', () => {
    const player = contender({ outcome: 'active' })
    const near = contender({
      id: 'raw-bot-id',
      name: 'Turtle.exe',
      persona: 'Turtle',
      isPlayer: false,
      barrier: 108.1,
      outcome: 'active',
    })
    const far = contender({
      id: 'raw-far-id',
      name: 'Far',
      persona: 'Sniper',
      isPlayer: false,
      barrier: 120,
      outcome: 'active',
    })
    const selection = selectRelevantRoundRival({ contenders: [far, player, near], feed: [], summary: null })
    expect(selection).toMatchObject({ contender: { id: 'raw-bot-id' }, relation: 'nearest-placement' })
    expect(createProfileRoundRival(selection)).toEqual({
      botId: 'raw-bot-id',
      botName: 'Turtle.exe',
      playerWon: true,
      copiedPlayer: false,
    })

    const context = createRivalryShareContext([{
      botId: 'raw-bot-id',
      botName: 'tampered stored name',
      wins: 0,
      losses: 3,
      copyEncounters: 2,
      lastMetAt: '2026-07-15T00:00:00.000Z',
    }], selection)
    expect(context).toEqual({
      rivalName: 'Turtle.exe',
      rivalPersona: 'Turtle',
      playerWins: 0,
      playerLosses: 3,
      copyEncounters: 2,
    })
    expect(JSON.stringify(context)).not.toContain('raw-bot-id')
  })
})
