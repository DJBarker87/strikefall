import { describe, expect, it, vi } from 'vitest'
import { createAnonymousProfile } from '../product/profile'
import type { StrikefallTelemetryEvent } from '../telemetry'
import {
  createAlphaMetricsExport,
  downloadAlphaMetricsExport,
  type AlphaDownloadAdapter,
} from './export'
import { calculateAlphaDashboardReport } from './report'

const privateEvent: StrikefallTelemetryEvent = {
  id: 'private-event-id',
  name: 'deck_revealed',
  at: '2026-07-15T10:00:00.000Z',
  sessionId: 'session-private-needle',
  roundId: 'round-private-needle',
  payload: {
    seed: 'secret-seed-needle',
    path: '/secret/path/needle',
    commitment: 'private-commitment-needle',
  },
}

function report() {
  const profile = {
    ...createAnonymousProfile({
      now: new Date('2026-07-15T10:00:00Z'),
      entropy: Uint8Array.from({ length: 12 }, (_, index) => index + 21),
    }),
    handle: 'Private Handle Needle',
  }
  return calculateAlphaDashboardReport([{
    events: [
      privateEvent,
      {
        ...privateEvent,
        id: 'complete',
        name: 'round_completed',
        payload: { outcome: 'survived', survivors: 4 },
      },
    ],
    profile,
    experiments: {
      version: 1,
      subjectId: profile.id,
      assignments: [{
        experimentId: 'escape',
        experimentVersion: 1,
        variant: 'midpoint',
        assignedAt: '2026-07-15T10:00:00.000Z',
      }],
    },
  }], new Date('2026-07-15T11:00:00Z'))
}

describe('aggregate metrics export', () => {
  it.each(['json', 'csv'] as const)('omits raw payloads and private identifiers from %s', (format) => {
    const artifact = createAlphaMetricsExport(report(), format)
    expect(artifact.filename).toMatch(new RegExp(`strikefall-alpha-metrics-.*\\.${format}$`))
    for (const privateValue of [
      'private-event-id',
      'session-private-needle',
      'round-private-needle',
      'secret-seed-needle',
      '/secret/path/needle',
      'private-commitment-needle',
      'Private Handle Needle',
      'anon_',
    ]) {
      expect(artifact.contents).not.toContain(privateValue)
    }
  })

  it('downloads through an injectable adapter and always releases the object URL', () => {
    const adapter: AlphaDownloadAdapter = {
      createObjectURL: vi.fn(() => 'blob:metrics'),
      revokeObjectURL: vi.fn(),
      click: vi.fn(),
    }
    const artifact = createAlphaMetricsExport(report(), 'json')
    expect(downloadAlphaMetricsExport(artifact, adapter)).toBe(true)
    expect(adapter.click).toHaveBeenCalledWith('blob:metrics', artifact.filename)
    expect(adapter.revokeObjectURL).toHaveBeenCalledWith('blob:metrics')
  })

  it('exports only aggregate session and player-outcome observations', () => {
    const artifact = createAlphaMetricsExport(report(), 'json')
    const parsed = JSON.parse(artifact.contents) as {
      observations: {
        sessions: number
        completedRounds: number
        outcomes: Record<string, number>
      }
    }

    expect(parsed.observations).toEqual({
      events: 2,
      sessions: 1,
      completingSessions: 1,
      completedRounds: 1,
      outcomes: { survived: 1, eliminated: 0, escaped: 0, unknown: 0 },
    })
  })
})
