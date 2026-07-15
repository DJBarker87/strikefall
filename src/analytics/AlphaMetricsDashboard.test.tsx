import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { StrikefallTelemetryEvent } from '../telemetry'
import { AlphaMetricsDashboard } from './AlphaMetricsDashboard'

function populatedEvents(): StrikefallTelemetryEvent[] {
  return [
    {
      id: 'move',
      name: 'flag_move',
      at: '2026-07-15T10:00:00.000Z',
      sessionId: 'private-session',
      roundId: 'private-round',
      payload: { seed: 'private-seed' },
    },
    {
      id: 'complete',
      name: 'round_completed',
      at: '2026-07-15T10:01:00.000Z',
      sessionId: 'private-session',
      roundId: 'private-round',
      payload: { outcome: 'escaped', survivors: 4 },
    },
    {
      id: 'share',
      name: 'share_opened',
      at: '2026-07-15T10:01:01.000Z',
      sessionId: 'private-session',
      roundId: 'private-round',
      payload: {},
    },
    {
      id: 'runtime',
      name: 'client_error',
      at: '2026-07-15T10:01:02.000Z',
      sessionId: 'private-session',
      payload: { code: 'render_failure', surface: 'arena' },
    },
  ]
}

describe('AlphaMetricsDashboard', () => {
  it('renders honest evidence labels, operations, exports, and variant cuts', () => {
    const html = renderToStaticMarkup(<AlphaMetricsDashboard
      generatedAt={new Date('2026-07-15T12:00:00Z')}
      sources={[{
        events: populatedEvents(),
        experiments: {
          version: 1,
          subjectId: 'private-subject',
          assignments: [{
            experimentId: 'escape',
            experimentVersion: 1,
            variant: 'midpoint',
            assignedAt: '2026-07-15T09:00:00Z',
          }],
        },
      }]}
    />)

    expect(html).toContain('Alpha signal room')
    expect(html).toContain('Observed')
    expect(html).toContain('Inferred')
    expect(html).toContain('Client errors')
    expect(html).toContain('1/1 observed telemetry sessions')
    expect(html).toContain('Client-error sessions')
    expect(html).toContain('&lt;1%')
    expect(html).toContain('Player outcomes')
    expect(html).toContain('0 held · 0 eliminated · 1 escaped')
    expect(html).toContain('Balance &amp; pacing')
    expect(html).toContain('Placement')
    expect(html).toContain('No elim.')
    expect(html).toContain('Early wipe')
    expect(html).toContain('Errors')
    expect(html).toContain('Export JSON')
    expect(html).toContain('escape')
    expect(html).toContain('One variant local')
    expect(html).not.toContain('private-seed')
    expect(html).not.toContain('private-session')
    expect(html).not.toContain('private-subject')
  })

  it('renders stable loading, empty, and recoverable error states', () => {
    const loading = renderToStaticMarkup(<AlphaMetricsDashboard state="loading" sources={[]} />)
    const empty = renderToStaticMarkup(<AlphaMetricsDashboard sources={[]} />)
    const error = renderToStaticMarkup(<AlphaMetricsDashboard state="error" sources={[]} onRetry={() => undefined} />)

    expect(loading).toContain('aria-busy="true"')
    expect(empty).toContain('Complete a round to light up the board')
    expect(error).toContain('Try again')
    expect(error).toContain('role="alert"')
  })
})
