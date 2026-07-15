import { RankedPayloadError, UnsupportedRankedProtocolError } from './errors'
import type {
  CreateRoundResponse,
  RankedProtocolVersion,
  ReplayBundle,
  SignedRoundEvent,
} from './types'
import {
  parseCreateRoundResponse,
  parseProtocolVersion,
  parseReplayBundle,
  parseSignedRoundEvent,
} from './validation'

/** Canonical signed pause between placement lock and battle frame zero. */
export const RANKED_LOCK_PHASE_MS = 2_000 as const

export interface RankedProtocolAdapter {
  readonly version: RankedProtocolVersion
  parseCreate(value: unknown): CreateRoundResponse
  parseReplay(value: unknown): ReplayBundle
  parseEvent(value: unknown): SignedRoundEvent
}

function requireVersion<T extends { protocolVersion: RankedProtocolVersion }>(
  value: T,
  expected: RankedProtocolVersion,
  path: string,
): T {
  if (value.protocolVersion !== expected) {
    throw new RankedPayloadError(path, expected)
  }
  return value
}

function adapter(version: RankedProtocolVersion): RankedProtocolAdapter {
  return {
    version,
    parseCreate(value) {
      return requireVersion(parseCreateRoundResponse(value), version, '$.protocolVersion')
    },
    parseReplay(value) {
      return requireVersion(parseReplayBundle(value), version, '$.protocolVersion')
    },
    parseEvent(value) {
      return parseSignedRoundEvent(value, version)
    },
  }
}

const ADAPTERS: ReadonlyMap<RankedProtocolVersion, RankedProtocolAdapter> = new Map([
  ['strikefall/ranked-replay/v3', adapter('strikefall/ranked-replay/v3')],
])

export const SUPPORTED_RANKED_PROTOCOLS = Object.freeze([...ADAPTERS.keys()])

export function protocolAdapter(version: RankedProtocolVersion): RankedProtocolAdapter {
  const selected = ADAPTERS.get(version)
  if (!selected) throw new UnsupportedRankedProtocolError(version)
  return selected
}

export function protocolVersionFromEnvelope(value: unknown): RankedProtocolVersion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RankedPayloadError('$', 'a protocol-versioned object')
  }
  return parseProtocolVersion((value as Record<string, unknown>).protocolVersion)
}

export function parseVersionedCreate(value: unknown): CreateRoundResponse {
  return protocolAdapter(protocolVersionFromEnvelope(value)).parseCreate(value)
}

export function parseVersionedReplay(value: unknown): ReplayBundle {
  return protocolAdapter(protocolVersionFromEnvelope(value)).parseReplay(value)
}
