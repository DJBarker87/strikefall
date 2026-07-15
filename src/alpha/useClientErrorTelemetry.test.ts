import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportClientRuntimeError } from '../runtimeErrors'
import type { AlphaTelemetryEvent } from './types'
import { bindClientErrorTelemetry } from './useClientErrorTelemetry'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shared client error telemetry', () => {
  it('requires explicit consent and sends only bounded code and surface properties', () => {
    let nextId = 0
    vi.stubGlobal('crypto', { randomUUID: () => `event-${nextId += 1}` })
    const sendTelemetry = vi.fn(async (_events: readonly AlphaTelemetryEvent[]) => ({
      accepted: 1,
      duplicates: 0,
    }))
    const api = { sendTelemetry }

    const disabledCleanup = bindClientErrorTelemetry({ enabled: false, api })
    reportClientRuntimeError({
      cause: new Error('private disabled diagnostic'),
      code: 'uncaught_exception',
      surface: 'session',
    })
    expect(sendTelemetry).not.toHaveBeenCalled()
    disabledCleanup()

    const stopSharing = bindClientErrorTelemetry({ enabled: true, api })
    reportClientRuntimeError({
      cause: new Error('private shared diagnostic'),
      code: 'unhandled_rejection',
      surface: 'arena',
    })

    expect(sendTelemetry).toHaveBeenCalledTimes(1)
    const event = sendTelemetry.mock.calls[0]?.[0][0]
    expect(event).toMatchObject({
      eventId: expect.any(String),
      name: 'client_error',
      properties: { code: 'unhandled_rejection', surface: 'arena' },
    })
    expect(Object.keys(event?.properties ?? {})).toEqual(['code', 'surface'])
    expect(JSON.stringify(event)).not.toContain('private shared diagnostic')

    stopSharing()
    reportClientRuntimeError({
      cause: new Error('private after consent'),
      code: 'render_failure',
      surface: 'arena',
    })
    expect(sendTelemetry).toHaveBeenCalledTimes(1)
  })
})
