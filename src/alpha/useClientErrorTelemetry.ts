import { useEffect } from 'react'
import {
  setClientErrorTransport,
  type ClientErrorTransport,
} from '../runtimeErrors'
import type { ClientErrorProperties } from '../telemetry'
import type { AlphaApiClient } from './client'
import { createRankedAlphaEvent } from './useRankedAlphaTelemetry'

export interface ClientErrorTelemetryOptions {
  readonly enabled: boolean
  readonly api: Pick<AlphaApiClient, 'sendTelemetry'> | null
}

function sharedTransport(
  api: Pick<AlphaApiClient, 'sendTelemetry'>,
): ClientErrorTransport {
  return (properties: ClientErrorProperties) => {
    const event = createRankedAlphaEvent('client_error', {
      code: properties.code,
      surface: properties.surface,
    })
    if (!event) return
    void api.sendTelemetry([event]).catch(() => {
      // Runtime telemetry never blocks recovery and has no hidden retry queue.
    })
  }
}

/** Registers no transport unless local preference and server session consent agree. */
export function bindClientErrorTelemetry(
  options: ClientErrorTelemetryOptions,
): () => void {
  if (!options.enabled || !options.api) return () => undefined
  return setClientErrorTransport(sharedTransport(options.api))
}

export function useClientErrorTelemetry(options: ClientErrorTelemetryOptions): void {
  useEffect(
    () => bindClientErrorTelemetry(options),
    [options.api, options.enabled],
  )
}
