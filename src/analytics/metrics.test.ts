import { describe, expect, it } from 'vitest'
import type { StrikefallEventName, StrikefallTelemetryEvent } from '../telemetry'
import { calculateAlphaMetrics } from './metrics'

let sequence = 0

function event(
  name: StrikefallEventName,
  sessionId: string,
  roundId: string,
  seconds: number,
  payload: StrikefallTelemetryEvent['payload'] = {},
): StrikefallTelemetryEvent {
  sequence += 1
  return {
    id: `event-${sequence}`,
    name,
    sessionId,
    roundId,
    at: new Date(Date.UTC(2026, 6, 14, 12, 0, seconds)).toISOString(),
    payload,
  }
}

describe('closed-alpha product metrics', () => {
  it('calculates rematch, agency, pacing, proof, and share gates', () => {
    const events: StrikefallTelemetryEvent[] = []
    for (let session = 0; session < 10; session += 1) {
      const rounds = session < 4 ? 3 : session < 7 ? 2 : 1
      for (let round = 0; round < rounds; round += 1) {
        const roundId = `${session}-${round}`
        events.push(event('flag_move', `${session}`, roundId, round * 10 + 1))
        events.push(event('flag_move', `${session}`, roundId, round * 10 + 2))
        events.push(event('round_completed', `${session}`, roundId, round * 10 + 6, {
          survivors: 4,
          outcome: session === 0 && round === 0 ? 'escaped' : 'survived',
        }))
        events.push(event('replay_verified', `${session}`, roundId, round * 10 + 7, { success: true }))
      }
    }
    for (let session = 0; session < 2; session += 1) {
      events.push(event('share_opened', `${session}`, `${session}-0`, 59))
    }
    const report = calculateAlphaMetrics(events, new Date('2026-07-14T13:00:00.000Z'))
    const byId = new Map(report.metrics.map((metric) => [metric.id, metric]))
    expect(byId.get('second-round')).toMatchObject({ value: 0.7, status: 'pass' })
    expect(byId.get('third-round')).toMatchObject({ value: 0.4, status: 'pass' })
    expect(byId.get('flag-revisions')).toMatchObject({ value: 2, status: 'pass' })
    expect(byId.get('median-survivors')).toMatchObject({ value: 4, status: 'insufficient' })
    expect(byId.get('replay-verification')).toMatchObject({ value: 1, status: 'pass' })
    expect(byId.get('escape-uptake')).toMatchObject({ numerator: 1, status: 'descriptive' })
    expect(report).toMatchObject({ sessions: 10, completedRounds: 21 })
  })

  it('matches spectate or rematch within five seconds of elimination', () => {
    const events = [
      event('player_eliminated', 'a', 'a-1', 1),
      event('spectate_started', 'a', 'a-1', 5),
      event('player_eliminated', 'b', 'b-1', 10),
      event('rematch_started', 'b', 'b-2', 16),
    ]
    const report = calculateAlphaMetrics(events)
    expect(report.metrics.find((metric) => metric.id === 'dead-player-retention'))
      .toMatchObject({ numerator: 1, denominator: 2, value: 0.5, status: 'insufficient' })
  })

  it('reports insufficient samples without fabricating zero rates', () => {
    const report = calculateAlphaMetrics([])
    expect(report.completedRounds).toBe(0)
    expect(report.metrics.every((metric) => metric.value === null)).toBe(true)
    expect(report.metrics.every((metric) => metric.status === 'insufficient')).toBe(true)
  })

  it('deduplicates round terminals and keeps share and clip observations session-scoped', () => {
    const events = [
      event('round_completed', 'a', 'same-round', 1, { outcome: 'survived', survivors: 3 }),
      event('round_completed', 'a', 'same-round', 2, { outcome: 'survived', survivors: 4 }),
      event('share_opened', 'a', 'same-round', 3),
      event('clip_exported', 'a', 'same-round', 4),
      event('round_completed', 'b', 'same-round', 5, { outcome: 'survived', survivors: 5 }),
      event('share_opened', 'b', 'same-round', 6),
    ]
    const report = calculateAlphaMetrics(events)
    expect(report.completedRounds).toBe(2)
    expect(report.metrics.find((metric) => metric.id === 'share-intent'))
      .toMatchObject({ numerator: 2, denominator: 2, value: 1 })
    expect(report.metrics.find((metric) => metric.id === 'clip-export'))
      .toMatchObject({ numerator: 1, denominator: 2, value: 0.5, status: 'descriptive' })
  })

  it('calculates the full G2 placement and elimination pacing gate from aggregate facts', () => {
    const events: StrikefallTelemetryEvent[] = []
    for (let round = 0; round < 25; round += 1) {
      const roundId = `balance-${round}`
      events.push(event('placement_locked', 'balance', roundId, round * 3, {
        lobbyUpper: 10,
        lobbyLower: 10,
        lobbyRiskBands: round === 24 ? 5 : 6,
        contenders: 20,
      }))
      if (round < 2) {
        events.push(event('cluster_wipe', 'balance', roundId, round * 3 + 1, {
          size: 4,
          progress: 0.1,
        }))
      }
      events.push(event('round_completed', 'balance', roundId, round * 3 + 2, {
        outcome: 'survived',
        survivors: 4,
        eliminated: round < 2 ? 0 : 16,
        contenders: 20,
      }))
    }

    const metrics = new Map(calculateAlphaMetrics(events).metrics.map((metric) => [metric.id, metric]))
    expect(metrics.get('placement-spread')).toMatchObject({
      numerator: 24,
      denominator: 25,
      value: 0.96,
      status: 'pass',
    })
    expect(metrics.get('no-elimination-rate')).toMatchObject({
      numerator: 2,
      denominator: 25,
      value: 0.08,
      status: 'pass',
    })
    expect(metrics.get('early-mass-wipe-rate')).toMatchObject({
      numerator: 2,
      denominator: 25,
      value: 0.08,
      status: 'pass',
    })
  })

  it('fails unhealthy G2 pacing only after a sufficient aggregate sample', () => {
    const events: StrikefallTelemetryEvent[] = []
    for (let round = 0; round < 24; round += 1) {
      const roundId = `unhealthy-${round}`
      events.push(event('placement_locked', 'unhealthy', roundId, round * 3, {
        lobbyUpper: 20,
        lobbyLower: 0,
        lobbyRiskBands: 3,
        contenders: 20,
      }))
      if (round < 3) {
        events.push(event('cluster_wipe', 'unhealthy', roundId, round * 3 + 1, {
          size: 5,
          progress: 0.05,
        }))
      }
      events.push(event('round_completed', 'unhealthy', roundId, round * 3 + 2, {
        outcome: 'survived',
        survivors: 20,
        eliminated: round < 3 ? 0 : 15,
        contenders: 20,
      }))
    }

    const metrics = new Map(calculateAlphaMetrics(events).metrics.map((metric) => [metric.id, metric]))
    expect(metrics.get('placement-spread')).toMatchObject({ status: 'fail', value: 0 })
    expect(metrics.get('no-elimination-rate')).toMatchObject({ status: 'fail', value: 0.125 })
    expect(metrics.get('early-mass-wipe-rate')).toMatchObject({ status: 'fail', value: 0.125 })
  })

  it('assesses the G4 client-error session gate only after 50 distinct sessions', () => {
    const clean = Array.from({ length: 50 }, (_, index) =>
      event('session_started', `g4-${index}`, `g4-${index}`, index))
    const insufficient = calculateAlphaMetrics(clean.slice(0, 49))
    const passing = calculateAlphaMetrics(clean)
    const failing = calculateAlphaMetrics([
      ...clean,
      event('client_error', 'g4-0', 'g4-0', 51, {
        code: 'verification_failed',
        surface: 'replay',
      }),
    ])

    expect(insufficient.metrics.find((metric) => metric.id === 'client-error-session-rate'))
      .toMatchObject({ numerator: 0, denominator: 49, value: 0, status: 'insufficient' })
    expect(passing.metrics.find((metric) => metric.id === 'client-error-session-rate'))
      .toMatchObject({ numerator: 0, denominator: 50, value: 0, status: 'pass', target: '< 1%' })
    expect(failing.metrics.find((metric) => metric.id === 'client-error-session-rate'))
      .toMatchObject({ numerator: 1, denominator: 50, value: 0.02, status: 'fail' })
  })

  it('retains only aggregate player outcome counts', () => {
    const report = calculateAlphaMetrics([
      event('round_completed', 'a', 'one', 1, { outcome: 'survived' }),
      event('round_completed', 'b', 'two', 2, { outcome: 'eliminated' }),
      event('round_completed', 'c', 'three', 3, { outcome: 'escaped' }),
      event('round_completed', 'd', 'four', 4, { outcome: 'unexpected' }),
    ])

    expect(report.outcomes).toEqual({ survived: 1, eliminated: 1, escaped: 1, unknown: 1 })
  })
})
