import { describe, expect, it } from 'vitest'
import type { Contender, FeedEvent, RoundSummary } from '../game/types'
import { createShareArtifact, shareCaption, shareFilename } from './artifact'
import { detectDramaticMoments, selectPrimaryDramaticMoment } from './moments'
import type { ShareRoundInput } from './types'

function contender(overrides: Partial<Contender> = {}): Contender {
  return {
    id: 'player',
    name: 'YOU',
    persona: 'Player',
    isPlayer: true,
    side: 'upper',
    distance: 2,
    barrier: 102,
    risk: 2,
    crowd: 1,
    potential: 400,
    color: '#fff',
    outcome: 'survived',
    hitAt: null,
    closestApproach: 0.08,
    closestApproachStep: 2,
    escape: null,
    moves: [],
    ...overrides,
  }
}

function summary(overrides: Partial<RoundSummary> = {}): RoundSummary {
  return {
    outcome: 'survived',
    score: 400,
    rank: 1,
    survived: 2,
    escaped: 0,
    closestApproach: 0.08,
    multiplier: 2,
    crowd: 1,
    headline: 'LAST FLAGS STANDING.',
    escape: null,
    ...overrides,
  }
}

function round(overrides: Partial<ShareRoundInput> = {}): ShareRoundInput {
  return {
    deck: {
      id: 'pulse',
      version: 2,
      monitoringConvention: 'strikefall/brownian-bridge-extrema/v1',
      name: 'Pulse',
      kicker: 'Double pressure',
      description: 'Alternating bursts.',
      tacticalHint: 'Pick the quiet lane.',
      variance: [15, 35, 15, 35],
      hue: 315,
      tempo: 1,
    },
    phase: 'result',
    lineValue: 100,
    battlePath: [100, 101.4, 99.2, 101.8, 100.2],
    contenders: [contender()],
    feed: [],
    summary: summary(),
    ...overrides,
  }
}

function cluster(sequence: number, ids: string[], at = 0.6): FeedEvent {
  return {
    id: `internal-round-cluster-${sequence}`,
    sequence,
    type: 'cluster',
    title: 'DEBUG TITLE MUST NOT SHIP',
    detail: 'DEBUG raw replay internals',
    contenderIds: ids,
    at,
  }
}

describe('dramatic moment detection', () => {
  it('detects held and late-hit near misses', () => {
    expect(selectPrimaryDramaticMoment(round())).toMatchObject({
      kind: 'near-miss',
      outcome: 'held',
      closestApproachStep: 2,
      at: 0.5,
    })

    const latePlayer = contender({ outcome: 'hit', hitAt: 0.96, closestApproach: 0 })
    const late = detectDramaticMoments(
      round({
        contenders: [latePlayer],
        summary: summary({ outcome: 'eliminated', score: 0, closestApproach: 0 }),
      }),
    ).find((moment) => moment.kind === 'near-miss')
    expect(late).toMatchObject({ kind: 'near-miss', outcome: 'late-hit', at: 0.96 })
  })

  it('detects cluster wipes and greed holds with deterministic impact ordering', () => {
    const moments = detectDramaticMoments(
      round({
        contenders: [contender({ risk: 6.2, potential: 1_400 })],
        summary: summary({ multiplier: 6.2, score: 1_400, closestApproach: 1.5 }),
        feed: [cluster(4, ['a', 'b', 'c', 'd', 'e'])],
      }),
    )
    expect(moments.some((moment) => moment.kind === 'greed-hold')).toBe(true)
    expect(moments.find((moment) => moment.kind === 'cluster-wipe')).toMatchObject({ size: 5, sequence: 4 })
    expect(moments[0]?.kind).toBe('cluster-wipe')
  })

  it('uses the authoritative 0/1/>1 second boundary for Perfect Escape', () => {
    const escapeAt = 0.5
    const escape = (delaySeconds: number) => ({
      frame: 100,
      at: escapeAt,
      survivalProbability: 0.48,
      terminalScore: 1_000,
      bankedScore: 480,
      holdOutcome: 'would-hit' as const,
      holdHitAt: escapeAt + delaySeconds / 60,
    })
    const momentAt = (delaySeconds: number) => {
      const record = escape(delaySeconds)
      return selectPrimaryDramaticMoment(round({
        contenders: [contender({ outcome: 'escaped', escape: record })],
        summary: summary({ outcome: 'escaped', score: 480, escape: record }),
      }))
    }
    expect(momentAt(0)).toMatchObject({ kind: 'perfect-escape', strikeDelaySeconds: 0 })
    expect(momentAt(1)).toMatchObject({ kind: 'perfect-escape', strikeDelaySeconds: 1 })
    expect(momentAt(1.0000001)?.kind).toBe('escape-save')
    expect(momentAt(1.001)).toMatchObject({ kind: 'escape-save', strikeDelaySeconds: 1.001 })

    const unauthoritative = { ...escape(0.5), holdHitAt: null }
    expect(selectPrimaryDramaticMoment(round({
      contenders: [contender({ outcome: 'escaped', escape: unauthoritative })],
      summary: summary({ outcome: 'escaped', score: 480, escape: unauthoritative }),
    }))).toBeNull()

    const perfectEscape = escape(0.6)
    const perfect = momentAt(0.6)
    expect(perfect).toMatchObject({
      kind: 'perfect-escape',
      strikeDelayProgress: 0.01,
      strikeDelaySeconds: 0.6,
    })

    const regretEscape = { ...perfectEscape, holdOutcome: 'would-survive' as const, holdHitAt: null }
    const regret = selectPrimaryDramaticMoment(
      round({
        contenders: [contender({ outcome: 'escaped', escape: regretEscape })],
        summary: summary({ outcome: 'escaped', score: 480, escape: regretEscape }),
      }),
    )
    expect(regret).toMatchObject({ kind: 'escape-regret', scoreLeftBehind: 520 })
  })

  it('recognizes a named bot rivalry without exposing contender IDs', () => {
    const rival = contender({
      id: 'echo-internal-id',
      name: 'Echo',
      persona: 'Mimic',
      isPlayer: false,
      barrier: 102.02,
      outcome: 'hit',
      hitAt: 0.62,
    })
    const player = contender({ outcome: 'hit', hitAt: 0.62 })
    const rivalry = detectDramaticMoments(
      round({
        contenders: [player, rival],
        feed: [cluster(2, ['player', 'echo-internal-id', 'third'])],
        summary: summary({ outcome: 'eliminated', score: 0, closestApproach: 0 }),
      }),
    ).find((moment) => moment.kind === 'bot-rivalry')
    expect(rivalry).toMatchObject({ rivalName: 'Echo', rivalPersona: 'Mimic', relation: 'fell-together' })
    expect(JSON.stringify(rivalry)).not.toContain('echo-internal-id')
  })

  it('turns repeated relevant rivalry history into deterministic public copy', () => {
    const rival = contender({
      id: 'raw-turtle-id-and-seed',
      name: 'Turtle.exe',
      persona: 'Turtle',
      isPlayer: false,
      barrier: 103,
      potential: 500,
    })
    const player = contender({ outcome: 'hit', hitAt: 0.5, closestApproach: 0 })
    const rivalry = {
      rivalName: 'Turtle.exe',
      rivalPersona: 'Turtle' as const,
      playerWins: 0,
      playerLosses: 3,
      copyEncounters: 0,
      botId: 'raw-turtle-id-and-seed',
      seed: 'DO-NOT-SHARE',
    }
    const settled = round({
      contenders: [player, rival],
      summary: summary({ outcome: 'eliminated', score: 0, closestApproach: 0, rank: 2 }),
    })
    const artifact = createShareArtifact(settled, { rivalry })

    expect(artifact.moment).toMatchObject({
      kind: 'bot-rivalry',
      rivalName: 'Turtle.exe',
      seriesCopy: 'Turtle.exe owns me 3–0',
    })
    expect(artifact.card.headline).toBe('Turtle.exe owns me 3–0.')
    expect(JSON.stringify(artifact)).not.toMatch(/raw-turtle-id|DO-NOT-SHARE/)
  })

  it('uses stored copy encounters only for the matching current Mimic', () => {
    const mimic = contender({
      id: 'mirror-private',
      name: 'Mirror',
      persona: 'Mimic',
      isPlayer: false,
      barrier: 102.2,
    })
    const moments = detectDramaticMoments(round({ contenders: [contender(), mimic] }), {
      rivalName: 'Mirror',
      rivalPersona: 'Mimic',
      playerWins: 1,
      playerLosses: 1,
      copyEncounters: 2,
    })
    const rivalry = moments.find((moment) => moment.kind === 'bot-rivalry')
    expect(rivalry).toMatchObject({
      relation: 'copied-player',
      seriesCopy: 'Mirror and I are tied 1–1',
      copyEncounters: 2,
    })
    expect(rivalry?.detail).toContain('Copied my flag 2 times.')
  })
})

describe('privacy-safe artifact', () => {
  it('derives public card data without seeds, round IDs, or raw feed copy', () => {
    const privateRound = {
      ...round({ feed: [cluster(7, ['a', 'b', 'c', 'd'])] }),
      seed: 'RAW-SEED-DO-NOT-SHARE',
      pathSeed: 'HIDDEN-PATH-SEED',
      botSeed: 'HIDDEN-BOT-SEED',
      roundId: 'DEBUG-ROUND-ID',
    }
    const artifact = createShareArtifact(privateRound)
    const encoded = JSON.stringify(artifact)

    expect(encoded).not.toMatch(/RAW-SEED|HIDDEN-|DEBUG-/)
    expect(artifact.card).toMatchObject({ botCount: 0, multiplier: 2 })
    expect(artifact.card.chart.points.length).toBeLessThanOrEqual(180)
    expect(artifact.card.chart.points.every((point) => point >= 0 && point <= 1)).toBe(true)
    expect(shareCaption(artifact.card)).not.toMatch(/seed|debug/i)
    expect(shareFilename(artifact.card)).toBe('strikefall-pulse.png')
  })
})
