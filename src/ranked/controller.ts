import type { RankedApiClient } from './client'
import { replayAnchorFromCreate } from './client'
import {
  RankedClientError,
  RankedHttpError,
  RankedReplayVerificationError,
  RankedSubmissionDisabledError,
  errorMessage,
} from './errors'
import {
  connectRankedEventStream,
  type EventSourceFactory,
  type RankedEventStream,
  type RankedStreamSnapshot,
} from './stream'
import type {
  CreateRoundRequest,
  CreateRoundResponse,
  EscapeRequest,
  EscapeResponse,
  FlagUpdateRequest,
  FlagUpdateResponse,
  LocalPracticeResult,
  ReplayBundle,
  RequestOptions,
  RoundResultResponse,
  SignedRoundEvent,
} from './types'
import type { RankedClock } from './client'
import {
  verifyRankedReplay,
  type RankedReplayRegenerationAdapter,
} from './verifier'

export type RankedAttemptMode = 'ranked' | 'local_practice' | 'invalid'
export type RankedAttemptPhase = 'idle' | 'starting' | 'active' | 'completed' | 'closed'
export type RankedConnectionState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'invalid'
  | 'resolved'
  | 'closed'
export type ReplayValidity = 'unchecked' | 'valid' | 'invalid'

export interface RankedAttemptState {
  readonly mode: RankedAttemptMode
  readonly phase: RankedAttemptPhase
  readonly connection: RankedConnectionState
  readonly rankedSubmissionAllowed: boolean
  readonly round: CreateRoundResponse | null
  readonly lastEvent: SignedRoundEvent | null
  readonly replayValidity: ReplayValidity
  readonly localResult: LocalPracticeResult | null
  readonly reason: string | null
}

export interface RankedControllerOptions {
  client: RankedApiClient
  eventSource?: EventSourceFactory
  clock?: RankedClock
  streamOfflineAfterMs?: number
  streamGapAfterMs?: number
  /** Full external verifier override. Omit to use the fail-closed browser + Rust/WASM path. */
  verifyReplay?: (bundle: ReplayBundle) => boolean | Promise<boolean>
  replayRegenerator?: RankedReplayRegenerationAdapter | null
  subtleCrypto?: SubtleCrypto | null
}

export interface RankedRoundController {
  state(): RankedAttemptState
  subscribe(listener: (state: RankedAttemptState) => void): () => void
  start(request?: CreateRoundRequest, options?: RequestOptions): Promise<CreateRoundResponse | null>
  updateFlag(request: FlagUpdateRequest, options?: RequestOptions): Promise<FlagUpdateResponse>
  escape(request?: EscapeRequest, options?: RequestOptions): Promise<EscapeResponse>
  result(options?: RequestOptions): Promise<RoundResultResponse>
  finalize(options?: RequestOptions): Promise<ReplayBundle | null>
  degradeToPractice(reason: string): void
  completeLocalPractice(result: LocalPracticeResult): void
  close(): void
}

const INITIAL_STATE: RankedAttemptState = Object.freeze({
  mode: 'ranked',
  phase: 'idle',
  connection: 'idle',
  rankedSubmissionAllowed: false,
  round: null,
  lastEvent: null,
  replayValidity: 'unchecked',
  localResult: null,
  reason: null,
})

function streamConnection(snapshot: RankedStreamSnapshot): RankedConnectionState {
  switch (snapshot.state) {
    case 'connecting': return 'connecting'
    case 'open': return 'live'
    case 'reconnecting': return 'reconnecting'
    case 'offline': return 'offline'
    case 'invalid': return 'invalid'
    case 'closed': return 'closed'
  }
}

export function replayIsInternallyConsistent(bundle: ReplayBundle): boolean {
  if (bundle.events.length === 0) return false
  for (let index = 0; index < bundle.events.length; index += 1) {
    const event = bundle.events[index]
    if (event === undefined || event.sequence !== index) return false
    if (index > 0 && event.previousDigest !== bundle.events[index - 1]?.digest) return false
  }
  const created = bundle.events[0]
  if (created?.kind.type !== 'round_created' || created.previousDigest !== '0'.repeat(64)) {
    return false
  }
  if (bundle.events.filter(({ kind }) => kind.type === 'round_created').length !== 1) return false
  if (created.kind.data.protocolVersion !== bundle.protocolVersion) return false
  if (created.kind.data.commitment !== bundle.commitment) return false
  let ended: SignedRoundEvent | undefined
  let revealed: SignedRoundEvent | undefined
  for (let index = bundle.events.length - 1; index >= 0; index -= 1) {
    const event = bundle.events[index]
    if (event === undefined) continue
    if (ended === undefined && event.kind.type === 'round_ended') ended = event
    if (revealed === undefined && event.kind.type === 'seed_revealed') revealed = event
    if (ended !== undefined && revealed !== undefined) break
  }
  if (ended?.kind.type !== 'round_ended') return false
  if (ended.kind.data.proofDigest !== bundle.result.proofDigest) return false
  if (revealed?.kind.type !== 'seed_revealed') return false
  if (ended.sequence >= revealed.sequence) return false
  if (bundle.events.filter(({ kind }) => kind.type === 'round_ended').length !== 1) return false
  if (bundle.events.filter(({ kind }) => kind.type === 'seed_revealed').length !== 1) return false
  const revealMatches = revealed.kind.data.reveal.pathDigest === bundle.reveal.pathDigest
    && revealed.kind.data.reveal.deckDigest === bundle.reveal.deckDigest
    && revealed.kind.data.reveal.botSeedRoot === bundle.reveal.botSeedRoot
    && revealed.kind.data.reveal.salt === bundle.reveal.salt
    && revealed.kind.data.reveal.pathSeed === bundle.reveal.pathSeed
  if (!revealMatches) return false
  const verificationEvents = bundle.events.filter(({ kind }) => kind.type === 'replay_verified')
  if (bundle.replayVerification === null) return verificationEvents.length === 0
  if (verificationEvents.length !== 1) return false
  const acknowledged = bundle.events[bundle.replayVerification.eventSequence]
  return acknowledged?.kind.type === 'replay_verified'
    && acknowledged.kind.data.proofDigest === bundle.replayVerification.proofDigest
    && acknowledged.kind.data.verifierVersion === bundle.replayVerification.verifierVersion
}

function shouldDegrade(error: unknown): boolean {
  if (error instanceof RankedHttpError) {
    return error.status === 401 || error.status === 403 || error.status >= 500
  }
  return error instanceof RankedClientError
    && (
      error.code === 'authentication_unavailable'
      || error.code === 'network_error'
      || error.code === 'timeout'
    )
}

function shouldInvalidate(error: unknown): boolean {
  return error instanceof RankedClientError
    && (
      error.code === 'malformed_response'
      || error.code === 'protocol_mismatch'
      || error.code === 'stream_gap'
      || error.code === 'stream_malformed'
      || error.code === 'unsupported_protocol'
      || error.code === 'verification_failed'
      || error.code === 'verification_unavailable'
    )
}

function placementMatches(
  left: CreateRoundResponse['playerPlacement'],
  right: CreateRoundResponse['playerPlacement'],
): boolean {
  return left.contenderId === right.contenderId
    && left.name === right.name
    && left.isBot === right.isBot
    && left.persona === right.persona
    && left.side === right.side
    && left.barrier === right.barrier
}

export function createRankedRoundController(
  options: RankedControllerOptions,
): RankedRoundController {
  let current = INITIAL_STATE
  let eventStream: RankedEventStream | null = null
  let generation = 0
  const listeners = new Set<(state: RankedAttemptState) => void>()

  const publish = (patch: Partial<RankedAttemptState>) => {
    current = Object.freeze({ ...current, ...patch })
    for (const listener of listeners) listener(current)
  }

  const stopStream = () => {
    eventStream?.close()
    eventStream = null
  }

  const invalidate = (reason: string) => {
    stopStream()
    publish({
      mode: 'invalid',
      connection: 'invalid',
      rankedSubmissionAllowed: false,
      replayValidity: 'invalid',
      reason,
    })
  }

  const degrade = (reason: string, connection: 'offline' | 'invalid' = 'offline') => {
    stopStream()
    publish({
      mode: 'local_practice',
      phase: current.phase === 'starting' ? 'active' : current.phase,
      connection,
      rankedSubmissionAllowed: false,
      replayValidity: connection === 'invalid' ? 'invalid' : current.replayValidity,
      reason,
    })
  }

  const transitionForError = (error: unknown) => {
    if (shouldInvalidate(error)) invalidate(errorMessage(error))
    else if (shouldDegrade(error)) degrade(errorMessage(error))
  }

  const assertRankedSubmission = (): CreateRoundResponse => {
    if (
      current.mode !== 'ranked'
      || !current.rankedSubmissionAllowed
      || current.round === null
    ) {
      throw new RankedSubmissionDisabledError()
    }
    return current.round
  }

  const attachStream = (created: CreateRoundResponse, ownGeneration: number) => {
    eventStream = connectRankedEventStream({
      url: options.client.streamUrl(created.roundId),
      protocolVersion: created.protocolVersion,
      eventSource: options.eventSource,
      clock: options.clock,
      offlineAfterMs: options.streamOfflineAfterMs,
      gapAfterMs: options.streamGapAfterMs,
      onEvent(event) {
        if (generation !== ownGeneration || current.mode !== 'ranked') return
        if (
          event.kind.type === 'round_created'
          && (
            event.kind.data.commitment !== created.commitment
            || !placementMatches(event.kind.data.playerPlacement, created.playerPlacement)
          )
        ) {
          invalidate('Signed stream creation state differs from the pre-round anchor.')
          return
        }
        publish({ lastEvent: event })
      },
      onState(snapshot) {
        if (generation !== ownGeneration || current.mode !== 'ranked') return
        const connection = streamConnection(snapshot)
        if (connection === 'offline') {
          degrade(snapshot.reason ?? 'Ranked stream went offline.')
          return
        }
        if (connection === 'invalid') {
          degrade(snapshot.reason ?? 'Ranked stream integrity was lost.', 'invalid')
          return
        }
        publish({ connection, reason: snapshot.reason })
      },
      onError() {
        // The terminal onState callback performs the state transition. Keeping
        // this callback installed makes stream failures observable to debuggers
        // without risking two competing controller transitions.
      },
    })
  }

  async function rankedCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      transitionForError(error)
      throw error
    }
  }

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => listeners.delete(listener)
    },
    async start(request = {}, requestOptions) {
      stopStream()
      generation += 1
      const ownGeneration = generation
      current = INITIAL_STATE
      publish({ phase: 'starting', connection: 'connecting' })
      let created: CreateRoundResponse
      try {
        created = await options.client.createRound(request, requestOptions)
      } catch (error) {
        if (generation !== ownGeneration) return null
        if (shouldInvalidate(error)) invalidate(errorMessage(error))
        else degrade(`Ranked service unavailable; continuing as local practice. ${errorMessage(error)}`)
        return null
      }
      if (generation !== ownGeneration) return null
      publish({
        mode: 'ranked',
        phase: 'active',
        connection: 'connecting',
        rankedSubmissionAllowed: true,
        round: created,
        reason: null,
      })
      try {
        attachStream(created, ownGeneration)
      } catch (error) {
        degrade(`Ranked stream unavailable; continuing as local practice. ${errorMessage(error)}`)
      }
      return created
    },
    async updateFlag(request, requestOptions) {
      const round = assertRankedSubmission()
      return rankedCall(() => options.client.updateFlag(round.roundId, request, requestOptions))
    },
    async escape(request = {}, requestOptions) {
      const round = assertRankedSubmission()
      return rankedCall(() => options.client.escape(round.roundId, request, requestOptions))
    },
    async result(requestOptions) {
      const round = assertRankedSubmission()
      return rankedCall(() => options.client.getResult(round.roundId, requestOptions))
    },
    async finalize(requestOptions) {
      const round = assertRankedSubmission()
      const anchor = replayAnchorFromCreate(round)
      try {
        const result = await options.client.getResult(round.roundId, requestOptions)
        if (result.status !== 'resolved') return null
        const bundle = await options.client.getReplay(round.roundId, {
          ...requestOptions,
          anchor,
        })
        const externalVerification = options.verifyReplay === undefined
          ? (await verifyRankedReplay(bundle, {
              anchor,
              regenerator: options.replayRegenerator,
              subtle: options.subtleCrypto,
            })).valid
          : await options.verifyReplay(bundle)
        const consistent = replayIsInternallyConsistent(bundle) && externalVerification
        if (!consistent) {
          invalidate('Authoritative replay verification failed.')
          throw new RankedReplayVerificationError(
            'verification_failed',
            'replay_consistency',
            'Authoritative replay verification failed.',
          )
        }
        stopStream()
        publish({
          phase: 'completed',
          connection: 'resolved',
          rankedSubmissionAllowed: false,
          replayValidity: 'valid',
          reason: null,
        })
        return bundle
      } catch (error) {
        transitionForError(error)
        throw error
      }
    },
    degradeToPractice(reason) {
      if (current.phase === 'closed') return
      degrade(reason)
    },
    completeLocalPractice(result) {
      if (current.mode !== 'local_practice') {
        throw new RankedSubmissionDisabledError(
          'Local practice can only complete after the ranked attempt has degraded.',
        )
      }
      if (!Number.isFinite(result.score) || result.score < 0) {
        throw new TypeError('Local practice score must be a finite non-negative number')
      }
      publish({
        phase: 'completed',
        rankedSubmissionAllowed: false,
        localResult: Object.freeze({ ...result }),
      })
    },
    close() {
      generation += 1
      stopStream()
      publish({
        phase: 'closed',
        connection: 'closed',
        rankedSubmissionAllowed: false,
      })
      listeners.clear()
    },
  }
}
