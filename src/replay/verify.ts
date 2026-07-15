import {
  RankedClientError,
  RankedPayloadError,
  RankedReplayVerificationError,
} from '../ranked/errors'
import type { HexString, ReplayAnchor, ReplayBundle } from '../ranked/types'
import {
  parseExperimentAssignments,
  parseProtocolVersion,
  parseReplayBundle,
} from '../ranked/validation'
import {
  verifyRankedReplay,
  type RankedReplayVerificationReport,
} from '../ranked/verifier'
import { createWasmRankedRegenerationAdapter } from '../ranked/wasmRegenerator'
import { loadStrikefallWasm } from '../wasm'
import { deriveRankedReplayView, type RankedReplayViewModel } from './derive'
import { parseRankedReplayId, type RankedReplayId } from './id'

export interface RankedReplayLoadContext {
  readonly signal: AbortSignal
}

/** The anchor must come from trusted pre-round state, not from the replay body. */
export interface RankedReplayLoadPayload {
  readonly replay: unknown
  readonly anchor: unknown
}

export type RankedReplayLoader = (
  replayId: RankedReplayId,
  context: RankedReplayLoadContext,
) => Promise<RankedReplayLoadPayload>

export type RankedReplayVerificationRunner = (
  replay: ReplayBundle,
  anchor: ReplayAnchor,
) => Promise<RankedReplayVerificationReport>

export interface VerifiedRankedReplay {
  readonly replay: ReplayBundle
  readonly anchor: ReplayAnchor
  readonly verification: RankedReplayVerificationReport
  readonly view: RankedReplayViewModel
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RankedPayloadError(field, 'an object')
  }
  return value as Record<string, unknown>
}

function trustedHex(value: unknown, field: string): HexString {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RankedPayloadError(field, '32 lowercase hexadecimal bytes')
  }
  return value as HexString
}

export function parseTrustedReplayAnchor(value: unknown): ReplayAnchor {
  const source = object(value, '$.anchor')
  return {
    roundId: parseRankedReplayId(source.roundId),
    protocolVersion: parseProtocolVersion(source.protocolVersion, '$.anchor.protocolVersion'),
    commitment: trustedHex(source.commitment, '$.anchor.commitment'),
    serverVerifyingKey: trustedHex(
      source.serverVerifyingKey,
      '$.anchor.serverVerifyingKey',
    ),
    experimentAssignments: parseExperimentAssignments(
      source.experimentAssignments,
      '$.anchor.experimentAssignments',
    ),
  }
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RankedClientError('aborted', 'Replay loading was cancelled.')
  }
}

export async function verifyRankedReplayWithWasm(
  replay: ReplayBundle,
  anchor: ReplayAnchor,
): Promise<RankedReplayVerificationReport> {
  const wasm = await loadStrikefallWasm({ retry: true })
  if (wasm.status !== 'ready') {
    const detail = wasm.status === 'unsupported'
      ? 'WebAssembly is unavailable in this browser.'
      : 'The deterministic verifier could not be initialized.'
    throw new RankedReplayVerificationError(
      'verification_unavailable',
      'rust_wasm_regeneration',
      detail,
    )
  }
  return verifyRankedReplay(replay, {
    anchor,
    regenerator: createWasmRankedRegenerationAdapter(wasm.client),
  })
}

export async function loadVerifiedRankedReplay(options: {
  readonly replayId: string
  readonly loader: RankedReplayLoader
  readonly signal: AbortSignal
  readonly verify?: RankedReplayVerificationRunner
}): Promise<VerifiedRankedReplay> {
  const replayId = parseRankedReplayId(options.replayId)
  abortIfNeeded(options.signal)
  const loaded = await options.loader(replayId, { signal: options.signal })
  abortIfNeeded(options.signal)
  const replay = parseReplayBundle(loaded.replay)
  const anchor = parseTrustedReplayAnchor(loaded.anchor)
  if (replay.roundId !== replayId || anchor.roundId !== replayId) {
    throw new RankedClientError(
      'protocol_mismatch',
      'The replay response does not match the requested replay ID.',
    )
  }
  const verification = await (options.verify ?? verifyRankedReplayWithWasm)(replay, anchor)
  abortIfNeeded(options.signal)
  const view = deriveRankedReplayView(replay, verification)
  return { replay, anchor, verification, view }
}
