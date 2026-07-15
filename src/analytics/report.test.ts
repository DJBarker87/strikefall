import { describe, expect, it } from 'vitest'
import type { ExperimentEnvelope } from '../product/experiments'
import { createAnonymousProfile, recordProfileRound } from '../product/profile'
import type { StrikefallEventName, StrikefallTelemetryEvent } from '../telemetry'
import {
  MAX_ALPHA_EVENTS_PER_SOURCE,
  calculateAlphaDashboardReport,
  type AlphaAnalyticsSource,
} from './report'

function event(
  id: string,
  name: StrikefallEventName,
  sessionId = 'session',
  roundId: string | undefined = 'round',
  seconds = 0,
  payload: StrikefallTelemetryEvent['payload'] = {},
): StrikefallTelemetryEvent {
  return {
    id,
    name,
    at: new Date(Date.UTC(2026, 6, 15, 10, 0, seconds)).toISOString(),
    sessionId,
    roundId,
    payload,
  }
}

function envelope(
  subjectId: string,
  experimentId: string,
  variant: string,
): ExperimentEnvelope {
  return {
    version: 1,
    subjectId,
    assignments: [{
      experimentId,
      experimentVersion: 1,
      variant,
      assignedAt: '2026-07-15T10:00:00.000Z',
    }],
  }
}

describe('alpha dashboard aggregation', () => {
  it('bounds every local source and discards malformed or duplicate events', () => {
    const events = Array.from({ length: MAX_ALPHA_EVENTS_PER_SOURCE + 5 }, (_, index) =>
      event(`event-${index}`, 'session_started', 'queue', undefined, index))
    events.push({ ...events.at(-1) as StrikefallTelemetryEvent })
    events.push({
      ...event('bad', 'session_started'),
      at: 'not-a-date',
    })

    const report = calculateAlphaDashboardReport([{ events }], new Date('2026-07-15T12:00:00Z'))
    expect(report.dataQuality).toEqual({
      sourcesProvided: 1,
      sourcesIncluded: 1,
      eventsReceived: 507,
      eventsIncluded: 498,
      eventsTrimmed: 7,
      eventsDiscarded: 2,
      eventLimitPerSource: 500,
    })
  })

  it('keeps persisted profile totals separate from observed telemetry', () => {
    const profile = recordProfileRound(
      createAnonymousProfile({
        now: new Date('2026-07-15T10:00:00Z'),
        entropy: Uint8Array.from({ length: 12 }, (_, index) => index + 1),
      }),
      { deckId: 'balanced', outcome: 'survived', score: 84, multiplier: 2 },
      new Date('2026-07-15T10:05:00Z'),
    )
    const report = calculateAlphaDashboardReport([
      { events: [], profile },
      { events: [], profile },
    ])

    expect(report.profiles).toMatchObject({
      evidence: 'persisted',
      profiles: 1,
      rounds: 1,
      held: 1,
      bestScore: 84,
    })
    expect(report.combined.completedRounds).toBe(0)
    expect(report.sampleSufficiency.sufficientMetrics).toBe(0)
  })

  it('counts bounded runtime errors and exposes an observed-session rate', () => {
    const report = calculateAlphaDashboardReport([{ events: [
      event('complete', 'round_completed', 'session', 'one', 1, { outcome: 'survived', survivors: 4 }),
      event('replay', 'replay_verified', 'session', 'one', 2, { success: false }),
      event('fallback', 'ranked_degraded_to_practice', 'session', 'one', 3),
      event('runtime', 'client_error', 'session', undefined, 4, {
        code: 'render_failure',
        surface: 'arena',
      }),
      event('other-session', 'round_completed', 'other', 'two', 5, {
        outcome: 'survived',
        survivors: 3,
      }),
    ] }])

    expect(report.operations).toMatchObject({
      degradedToPractice: 1,
      replayFailures: 1,
      clientErrors: 1,
      clientErrorSessions: 1,
      clientErrorRate: 0.5,
    })
    expect(report.operations.clientErrorNote).toContain('1/2')
    expect(report.operations.clientErrorNote).toContain('50.0%')
  })

  it('discards client-error payloads containing raw diagnostics or unbounded enums', () => {
    const report = calculateAlphaDashboardReport([{ events: [
      event('message', 'client_error', 'session', undefined, 1, {
        code: 'render_failure',
        message: 'private diagnostic',
        surface: 'arena',
      }),
      event('surface', 'client_error', 'session', undefined, 2, {
        code: 'uncaught_exception',
        surface: '/replay/private-id',
      }),
    ] }])

    expect(report.dataQuality.eventsDiscarded).toBe(2)
    expect(report.operations.clientErrors).toBe(0)
    expect(report.operations.clientErrorRate).toBeNull()
  })

  it('makes the <1% error-session threshold an explicit G4 pass/fail/insufficient gate', () => {
    const sources = Array.from({ length: 50 }, (_, index): AlphaAnalyticsSource => ({
      events: [
        event(`complete-${index}`, 'round_completed', `g4-${index}`, `round-${index}`, index, {
          outcome: index % 3 === 0 ? 'eliminated' : 'survived',
          survivors: 4,
        }),
        ...(index < 10
          ? [event(`share-${index}`, 'share_opened', `g4-${index}`, `round-${index}`, index)]
          : []),
      ],
    }))
    const passing = calculateAlphaDashboardReport(sources)
    const insufficient = calculateAlphaDashboardReport(sources.slice(0, 49))
    const failing = calculateAlphaDashboardReport([
      ...sources.slice(0, 49),
      {
        events: [
          ...sources[49]!.events,
          event('client-error', 'client_error', 'g4-49', undefined, 50, {
            code: 'verification_failed',
            surface: 'replay',
          }),
        ],
      },
    ])

    expect(passing.combined.metrics.find((metric) => metric.id === 'client-error-session-rate'))
      .toMatchObject({ denominator: 50, status: 'pass' })
    expect(passing.roadmap.find((signal) => signal.gate === 'G4'))
      .toMatchObject({ status: 'passing' })
    expect(insufficient.roadmap.find((signal) => signal.gate === 'G4'))
      .toMatchObject({ status: 'insufficient' })
    expect(failing.combined.metrics.find((metric) => metric.id === 'client-error-session-rate'))
      .toMatchObject({ numerator: 1, denominator: 50, value: 0.02, status: 'fail' })
    expect(failing.roadmap.find((signal) => signal.gate === 'G4'))
      .toMatchObject({ status: 'needs-attention' })
    expect(failing.combined.outcomes).toMatchObject({ eliminated: 17, survived: 33 })
  })

  it('compares adequately represented variants descriptively, never as winners', () => {
    const sources: AlphaAnalyticsSource[] = []
    for (const variant of ['control', 'midpoint']) {
      for (let subject = 0; subject < 10; subject += 1) {
        const subjectId = `${variant}-${subject}`
        const rounds = variant === 'control' ? 2 : 1
        const events: StrikefallTelemetryEvent[] = []
        for (let round = 0; round < rounds; round += 1) {
          events.push(event(
            `${subjectId}-${round}`,
            'round_completed',
            subjectId,
            `round-${round}`,
            round,
            { outcome: variant === 'midpoint' && subject === 0 ? 'escaped' : 'survived', survivors: 4 },
          ))
        }
        sources.push({ events, experiments: envelope(subjectId, 'escape', variant) })
      }
    }

    const report = calculateAlphaDashboardReport(sources)
    const comparison = report.variants.find((candidate) => candidate.experiment === 'escape')
    expect(comparison).toMatchObject({ status: 'descriptive', minimumSubjectsPerVariant: 10 })
    expect(comparison?.note).toContain('no causal winner')
    expect(comparison?.cohorts).toHaveLength(2)
    const control = comparison?.cohorts.find((cohort) => cohort.variant === 'control')
    const midpoint = comparison?.cohorts.find((cohort) => cohort.variant === 'midpoint')
    expect(control?.metrics.find((metric) => metric.id === 'second-round')?.value).toBe(1)
    expect(midpoint?.metrics.find((metric) => metric.id === 'second-round')?.value).toBe(0)
  })

  it('labels a single local assignment as non-comparable', () => {
    const report = calculateAlphaDashboardReport([{
      events: [event('complete', 'round_completed', 'one', 'one', 0, { outcome: 'survived' })],
      experiments: envelope('private-subject', 'risk-display', 'danger-band'),
    }])
    expect(report.variants[0]).toMatchObject({
      experiment: 'risk-display',
      status: 'single-variant',
    })
  })

  it('does not inflate a cohort when the same assigned subject is imported twice', () => {
    const assignment = envelope('same-private-subject', 'escape', 'midpoint')
    const report = calculateAlphaDashboardReport([
      {
        events: [event('older', 'round_completed', 'old', 'old', 0, { outcome: 'survived' })],
        experiments: assignment,
      },
      {
        events: [
          event('newer-one', 'round_completed', 'new', 'one', 1, { outcome: 'survived' }),
          event('newer-two', 'round_completed', 'new', 'two', 2, { outcome: 'survived' }),
        ],
        experiments: assignment,
      },
    ])
    expect(report.variants[0]?.cohorts[0]).toMatchObject({
      sources: 1,
      completedRounds: 2,
    })
  })
})
