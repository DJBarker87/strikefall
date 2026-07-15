import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindClientErrorTelemetry } from '../alpha/useClientErrorTelemetry'
import type { AlphaTelemetryEvent } from '../alpha/types'
import { RankedClientError, RankedReplayVerificationError } from './errors'
import { reportRankedReplayVerificationFailure } from './errorTelemetry'

let releaseTransport: (() => void) | null = null

afterEach(() => {
  releaseTransport?.()
  releaseTransport = null
  vi.unstubAllGlobals()
})

describe('ranked replay failure telemetry', () => {
  it('requires consent, deduplicates by error identity, and sends no diagnostics', () => {
    let nextId = 0
    vi.stubGlobal('crypto', { randomUUID: () => `ranked-error-${nextId += 1}` })
    const sendTelemetry = vi.fn(async (_events: readonly AlphaTelemetryEvent[]) => ({
      accepted: 1,
      duplicates: 0,
    }))
    const api = { sendTelemetry }

    const noConsent = new RankedReplayVerificationError(
      'verification_failed',
      'private-round-id',
      'seed=secret mismatch at contender 17',
    )
    bindClientErrorTelemetry({ enabled: false, api })
    expect(reportRankedReplayVerificationFailure(noConsent)).toBe(true)
    expect(sendTelemetry).not.toHaveBeenCalled()

    releaseTransport = bindClientErrorTelemetry({ enabled: true, api })
    const sharedFailure = new RankedReplayVerificationError(
      'verification_failed',
      'private-proof-check',
      'round=private-round seed=private-seed mismatch detail',
    )
    expect(reportRankedReplayVerificationFailure(sharedFailure)).toBe(true)
    expect(reportRankedReplayVerificationFailure(sharedFailure)).toBe(false)

    expect(sendTelemetry).toHaveBeenCalledTimes(1)
    const serialized = JSON.stringify(sendTelemetry.mock.calls[0]?.[0])
    expect(sendTelemetry.mock.calls[0]?.[0][0]).toMatchObject({
      name: 'client_error',
      properties: { code: 'verification_failed', surface: 'replay' },
    })
    expect(Object.keys(sendTelemetry.mock.calls[0]?.[0][0]?.properties ?? {})).toEqual([
      'code',
      'surface',
    ])
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('seed')
    expect(serialized).not.toContain('stack')
  })

  it('does not mislabel network or unavailable-verifier failures as mismatches', () => {
    const sendTelemetry = vi.fn(async (_events: readonly AlphaTelemetryEvent[]) => ({
      accepted: 1,
      duplicates: 0,
    }))
    releaseTransport = bindClientErrorTelemetry({ enabled: true, api: { sendTelemetry } })

    expect(reportRankedReplayVerificationFailure(
      new RankedClientError('network_error', 'private offline detail'),
    )).toBe(false)
    expect(reportRankedReplayVerificationFailure(
      new RankedReplayVerificationError(
        'verification_unavailable',
        'wasm',
        'private unavailable detail',
      ),
    )).toBe(false)
    expect(sendTelemetry).not.toHaveBeenCalled()
  })
})
