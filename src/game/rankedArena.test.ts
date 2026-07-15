import { describe, expect, it } from 'vitest'
import type {
  CreateRoundResponse,
  LockedScore,
  ReplayBundle,
  RoundEventKind,
  SignedRoundEvent,
} from '../ranked'
import { createResponse, point, replayBundle } from '../ranked/_fixtures'
import {
  applyRankedArenaEvent,
  createRankedArenaRound,
  finalizeRankedArenaRound,
  rankedDeckToGame,
  rankedFixedToNumber,
  rankedFixedToPoints,
} from './rankedArena'

const H = 'ab'.repeat(32)
const S = 'cd'.repeat(64)

function event(sequence: number, kind: unknown): SignedRoundEvent {
  return {
    sequence,
    serverTimeMs: 1_700_000_000_000 + sequence,
    previousDigest: H,
    kind: kind as RoundEventKind,
    digest: H,
    signature: S,
  } as SignedRoundEvent
}

function locked(contenderId: number, terminal = '400000000000000'): LockedScore {
  return {
    contenderId,
    side: 'upper',
    barrier: '110000000000000',
    normalizedDistance: '500000000000',
    initialSurvival: '450000000000',
    riskMultiplier: '2000000000000',
    crowdFactor: '875000000000',
    terminalScore: terminal,
  } as LockedScore
}

function created(): CreateRoundResponse {
  const value = createResponse()
  value.createdAtMs = Date.now()
  value.placementDeadlineMs = value.createdAtMs + 12_000
  value.inputFreezeAtMs = value.placementDeadlineMs - 750
  return value as unknown as CreateRoundResponse
}

describe('authoritative ranked arena adapter', () => {
  it('converts fixed values only at the presentation edge', () => {
    expect(rankedFixedToNumber('100125000000000')).toBe(100.125)
    expect(rankedFixedToPoints('1995000000000')).toBe(2)
    expect(() => rankedFixedToNumber('01')).toThrow(/canonical/)
  })

  it('maps the signed deck and initial lobby into the canvas model', () => {
    const response = created()
    const round = createRankedArenaRound(response, 50)
    expect(rankedDeckToGame(response.deck)).toMatchObject({
      id: 'balanced-tape',
      name: 'Balanced Tape',
    })
    expect(round.phase).toBe('placement')
    expect(round.contenders).toHaveLength(2)
    expect(round.contenders.find((entry) => entry.isPlayer)?.barrier).toBe(110)
    expect(round.engine.pathSource).toBe('rust-server-bridge-extrema/v3')
    expect(round.battlePath).toHaveLength(240)
  })

  it('derives Escape availability from the signed ranked treatment', () => {
    const absent = created()
    absent.experimentAssignments = {
      ...absent.experimentAssignments,
      'escape:v2': 'absent',
    }
    expect(createRankedArenaRound(absent, 0).escapeEnabled).toBe(false)

    const midpoint = created()
    midpoint.experimentAssignments = {
      ...midpoint.experimentAssignments,
      'escape:v2': 'midpoint',
    }
    expect(createRankedArenaRound(midpoint, 0).escapeEnabled).toBe(true)
  })

  it('renders each timed ranked BOT decision as visible jockeying', () => {
    let round = createRankedArenaRound(created(), 0)
    round = applyRankedArenaEvent(round, event(4, {
      type: 'bot_placement_decision',
      data: {
        decision: {
          contenderId: 1,
          persona: 'late_bidder',
          policyVersion: 'strikefall/ranked-bot-placement/v3',
          decisionNumber: 2,
          decisionTimeMs: 8_250,
          observationTimeMs: 7_375,
          reactionLatencyMs: 875,
          publicInputsDigest: H,
          entropyDigest: H,
          candidatesDigest: H,
          candidateCount: 12,
          selectedCandidate: 7,
          selectedUtility: '84500000000000',
          reasonCode: 'late_bidder_room_read',
          candidates: [],
          placement: {
            contenderId: 1,
            name: 'Turtle.exe',
            isBot: true,
            persona: 'late_bidder',
            side: 'lower',
            barrier: '90000000000000',
          },
        },
      },
    }))
    const bot = round.contenders.find((contender) => contender.id === 'bot-1')
    expect(bot).toMatchObject({ side: 'lower', barrier: 90 })
    expect(bot?.moves.at(-1)).toMatchObject({
      at: 8_250,
      completed: true,
      reason: 'late bidder room read',
    })
    expect(round.feed.at(-1)).toMatchObject({
      title: 'Turtle.exe · BOT jockeyed',
      detail: expect.stringMatching(/observed at 7\.4s, acted at 8\.3s.*12 candidates/),
    })
  })

  it('applies authoritative lock, battle, cluster, hit, and Escape events', () => {
    let round = createRankedArenaRound(created(), 0)
    round = applyRankedArenaEvent(round, event(100, {
      type: 'placement_locked',
      data: {
        lockedScoresDigest: H,
        lockedScores: [locked(0), locked(1, '225000000000000')],
        battleStartsAtMs: 1_700_000_002_100,
      },
    }), 100)
    expect(round.phase).toBe('lock')
    expect(round.phaseDuration).toBe(2_000)
    expect(round.timeRemaining).toBe(2_000)
    expect(round.contenders[0]).toMatchObject({ risk: 2, crowd: 0.875, potential: 400 })

    round = applyRankedArenaEvent(round, event(101, {
      type: 'battle_frame',
      data: { point: { ...point(120), price: '101000000000000' } },
    }), 200)
    expect(round.phase).toBe('battle')
    expect(round.battleIndex).toBe(120)
    expect(round.lineValue).toBe(101)

    round = applyRankedArenaEvent(round, event(102, {
      type: 'flag_cluster',
      data: { cluster: { step: 120, contenderIds: [1, 2, 3] } },
    }))
    round = applyRankedArenaEvent(round, event(103, {
      type: 'flag_hit',
      data: {
        touch: {
          contenderId: 1,
          step: 120,
          side: 'upper',
          barrier: '110000000000000',
          lineValue: '110000000000000',
        },
      },
    }))
    round = applyRankedArenaEvent(round, event(104, {
      type: 'escape_accepted',
      data: {
        contenderId: 0,
        actor: 'player',
        escape: { step: 130, bankedScore: '200000000000000', lineValue: '101000000000000' },
      },
    }))
    expect(round.feed.some((entry) => entry.type === 'cluster')).toBe(true)
    expect(round.contenders.find((entry) => entry.id === 'bot-1')?.outcome).toBe('hit')
    expect(round.contenders.find((entry) => entry.isPlayer)).toMatchObject({
      outcome: 'escaped',
      escape: { bankedScore: 200 },
    })
  })

  it('fails closed when the signed lock beat is not exactly two seconds', () => {
    const round = createRankedArenaRound(created(), 0)
    expect(() => applyRankedArenaEvent(round, event(100, {
      type: 'placement_locked',
      data: {
        lockedScoresDigest: H,
        lockedScores: [locked(0), locked(1)],
        battleStartsAtMs: 1_700_000_002_101,
      },
    }), 100)).toThrow(/non-canonical battle start/)
  })

  it('uses replay results—not local ranking—to settle the final screen', () => {
    const response = created()
    let round = createRankedArenaRound(response, 0)
    const raw: any = replayBundle()
    raw.lockedScores = [locked(0), locked(1, '225000000000000')]
    raw.path.battle = [
      point(0),
      { ...point(1), price: '101000000000000' },
      { ...point(2), price: '102000000000000' },
    ]
    raw.escape = { step: 1, bankedScore: '200000000000000', lineValue: '101000000000000' }
    raw.result = {
      ...raw.result,
      outcome: 'escaped',
      score: '200000000000000',
      rank: 7,
      survivors: 2,
      closestApproach: '9000000000000',
      contenders: [
        {
          contenderId: 0,
          name: 'PLAYER',
          outcome: 'escaped',
          score: '200000000000000',
          rank: 7,
          touchStep: null,
          closestApproach: '9000000000000',
        },
        {
          contenderId: 1,
          name: 'BOT 1',
          outcome: 'survived',
          score: '225000000000000',
          rank: 4,
          touchStep: null,
          closestApproach: '8000000000000',
        },
      ],
    }
    const settled = finalizeRankedArenaRound(round, raw as unknown as ReplayBundle, 1_000)
    expect(settled.phase).toBe('result')
    expect(settled.summary).toMatchObject({
      outcome: 'escaped',
      score: 200,
      rank: 7,
      survived: 2,
      escaped: 1,
    })
    expect(settled.seed).toBe(raw.reveal.pathSeed)
    expect(settled.feed.at(-1)?.detail).toMatch(/Rust replay regenerated/)
  })
})
