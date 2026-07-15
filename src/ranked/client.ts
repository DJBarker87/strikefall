import {
  RankedClientError,
  RankedHttpError,
  RankedPayloadError,
  errorMessage,
} from './errors'
import { parseVersionedCreate, parseVersionedReplay } from './protocol'
import type {
  CreateRoundRequest,
  CreateRoundResponse,
  Deck,
  EscapeRequest,
  EscapeResponse,
  FlagUpdateRequest,
  FlagUpdateResponse,
  RankedProtocolVersion,
  ReplayAnchor,
  ReplayBundle,
  ReplayVerifiedRequest,
  ReplayVerifiedResponse,
  RequestOptions,
  RoundResultResponse,
} from './types'
import {
  parseApiErrorPayload,
  parseDeck,
  parseEscapeResponse,
  parseFlagUpdateResponse,
  parseRoundResultResponse,
  parseReplayVerifiedResponse,
  parseUnsignedDecimalString,
} from './validation'
import { resolveBearerToken, type BearerTokenSource } from './auth'

export type TimerHandle = ReturnType<typeof globalThis.setTimeout>

export interface RankedClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export const systemRankedClock: RankedClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
}

export interface RankedClientOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
  clock?: RankedClock
  timeoutMs?: number
  /** Resolved for every request so rotated alpha-session tokens take effect immediately. */
  bearerToken?: BearerTokenSource
}

export interface ReplayRequestOptions extends RequestOptions {
  anchor?: ReplayAnchor
}

export interface RankedApiClient {
  readonly baseUrl: string
  getDeck(deckId: string, version: number, options?: RequestOptions): Promise<Deck>
  createRound(request?: CreateRoundRequest, options?: RequestOptions): Promise<CreateRoundResponse>
  updateFlag(
    roundId: string,
    request: FlagUpdateRequest,
    options?: RequestOptions,
  ): Promise<FlagUpdateResponse>
  escape(
    roundId: string,
    request?: EscapeRequest,
    options?: RequestOptions,
  ): Promise<EscapeResponse>
  getResult(roundId: string, options?: RequestOptions): Promise<RoundResultResponse>
  getReplay(roundId: string, options?: ReplayRequestOptions): Promise<ReplayBundle>
  acknowledgeReplay(
    roundId: string,
    request: ReplayVerifiedRequest,
    options?: RequestOptions,
  ): Promise<ReplayVerifiedResponse>
  streamUrl(roundId: string): string
  protocolForRound(roundId: string): RankedProtocolVersion | null
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (normalized.length === 0) throw new TypeError('Ranked API baseUrl must not be empty')
  return normalized
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.replace(/^\/+/, '')}`
}

function segment(value: string, label: string): string {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`)
  return encodeURIComponent(value)
}

function safeUint(value: number | undefined, label: string): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a safe unsigned integer`)
  }
}

function retryAfterHeaderMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return null
  return Math.max(0, dateMs - nowMs)
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch (error) {
    throw new RankedPayloadError('$', 'valid JSON', { cause: error })
  }
}

function assertReplayAnchor(bundle: ReplayBundle, anchor: ReplayAnchor): void {
  const mismatches: string[] = []
  if (bundle.roundId !== anchor.roundId) mismatches.push('roundId')
  if (bundle.protocolVersion !== anchor.protocolVersion) mismatches.push('protocolVersion')
  if (bundle.commitment !== anchor.commitment) mismatches.push('commitment')
  if (bundle.serverVerifyingKey !== anchor.serverVerifyingKey) {
    mismatches.push('serverVerifyingKey')
  }
  if (JSON.stringify(bundle.experimentAssignments) !== JSON.stringify(anchor.experimentAssignments)) {
    mismatches.push('experimentAssignments')
  }
  if (mismatches.length > 0) {
    throw new RankedClientError(
      'protocol_mismatch',
      `Replay does not match its pre-round anchor: ${mismatches.join(', ')}`,
    )
  }
}

export function replayAnchorFromCreate(created: CreateRoundResponse): ReplayAnchor {
  return {
    roundId: created.roundId,
    protocolVersion: created.protocolVersion,
    commitment: created.commitment,
    serverVerifyingKey: created.serverVerifyingKey,
    experimentAssignments: created.experimentAssignments,
  }
}

export function createRankedClient(options: RankedClientOptions): RankedApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch implementation is required')
  const clock = options.clock ?? systemRankedClock
  const defaultTimeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw new TypeError('timeoutMs must be positive')
  }
  const roundProtocols = new Map<string, RankedProtocolVersion>()

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<unknown> {
    const timeoutMs = requestOptions.timeoutMs ?? defaultTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be positive')
    }
    if (requestOptions.signal?.aborted) {
      throw new RankedClientError('aborted', 'Ranked request was aborted before it started.')
    }

    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = () => controller.abort(requestOptions.signal?.reason)
    requestOptions.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeoutHandle = clock.setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`Ranked request timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    try {
      let response: Response
      try {
        const bearerToken = options.bearerToken === undefined
          ? null
          : await resolveBearerToken(options.bearerToken)
        const headers: Record<string, string> = {}
        if (body !== undefined) headers['content-type'] = 'application/json'
        if (bearerToken !== null) headers.authorization = `Bearer ${bearerToken}`
        response = await fetchImpl(endpoint(baseUrl, path), {
          method,
          headers: Object.keys(headers).length === 0 ? undefined : headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (error instanceof RankedClientError) throw error
        if (timedOut) {
          throw new RankedClientError(
            'timeout',
            `Ranked request timed out after ${timeoutMs} ms.`,
            { cause: error },
          )
        }
        if (requestOptions.signal?.aborted || controller.signal.aborted) {
          throw new RankedClientError('aborted', 'Ranked request was aborted.', { cause: error })
        }
        throw new RankedClientError(
          'network_error',
          `Ranked service could not be reached: ${errorMessage(error)}`,
          { cause: error },
        )
      }

      if (!response.ok) {
        let apiCode: string | null = null
        let message = `Ranked service returned HTTP ${response.status}`
        let bodyRetryAfterMs: number | null = null
        let cause: unknown
        try {
          const payload = parseApiErrorPayload(await readJson(response))
          apiCode = payload.code
          message = payload.message
          bodyRetryAfterMs = payload.retryAfterMs
        } catch (error) {
          cause = error
        }
        throw new RankedHttpError({
          status: response.status,
          apiCode,
          message,
          retryAfterMs: bodyRetryAfterMs
            ?? retryAfterHeaderMs(response.headers.get('retry-after'), clock.now()),
          cause,
        })
      }
      return readJson(response)
    } finally {
      clock.clearTimeout(timeoutHandle)
      requestOptions.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  return {
    baseUrl,
    async getDeck(deckId, version, requestOptions) {
      safeUint(version, 'deck version')
      const deck = parseDeck(await request(
        'GET',
        `/v1/decks/${segment(deckId, 'deck id')}/${version}`,
        undefined,
        requestOptions,
      ))
      if (deck.id !== deckId || deck.version !== version) {
        throw new RankedClientError(
          'protocol_mismatch',
          'Deck response does not match the requested deck identity.',
        )
      }
      return deck
    },
    async createRound(input = {}, requestOptions) {
      safeUint(input.deckVersion, 'deck version')
      if (input.deckId !== undefined) segment(input.deckId, 'deck id')
      const created = parseVersionedCreate(await request(
        'POST',
        '/v1/solo-rounds',
        input,
        requestOptions,
      ))
      if (input.deckId !== undefined && created.deck.id !== input.deckId) {
        throw new RankedClientError('protocol_mismatch', 'Created round used a different deck id.')
      }
      if (input.deckVersion !== undefined && created.deck.version !== input.deckVersion) {
        throw new RankedClientError(
          'protocol_mismatch',
          'Created round used a different deck version.',
        )
      }
      roundProtocols.set(created.roundId, created.protocolVersion)
      return created
    },
    async updateFlag(roundId, input, requestOptions) {
      parseUnsignedDecimalString(input.barrier, 'flag.barrier')
      safeUint(input.clientSequence, 'clientSequence')
      return parseFlagUpdateResponse(await request(
        'POST',
        `/v1/solo-rounds/${segment(roundId, 'round id')}/flag`,
        input,
        requestOptions,
      ))
    },
    async escape(roundId, input = {}, requestOptions) {
      safeUint(input.clientSequence, 'clientSequence')
      return parseEscapeResponse(await request(
        'POST',
        `/v1/solo-rounds/${segment(roundId, 'round id')}/escape`,
        input,
        requestOptions,
      ))
    },
    async getResult(roundId, requestOptions) {
      const result = parseRoundResultResponse(await request(
        'GET',
        `/v1/solo-rounds/${segment(roundId, 'round id')}/result`,
        undefined,
        requestOptions,
      ))
      if (result.roundId !== roundId) {
        throw new RankedClientError('protocol_mismatch', 'Result belongs to a different round.')
      }
      if (result.status === 'resolved' && (result.result === null || result.reveal === null)) {
        throw new RankedPayloadError('$', 'a resolved result and reveal')
      }
      if (result.status !== 'resolved' && result.reveal !== null) {
        throw new RankedPayloadError('$.reveal', 'null before round resolution')
      }
      return result
    },
    async getReplay(roundId, requestOptions = {}) {
      const { anchor, ...networkOptions } = requestOptions
      const bundle = parseVersionedReplay(await request(
        'GET',
        `/v1/solo-rounds/${segment(roundId, 'round id')}/replay`,
        undefined,
        networkOptions,
      ))
      if (bundle.roundId !== roundId) {
        throw new RankedClientError('protocol_mismatch', 'Replay belongs to a different round.')
      }
      const knownProtocol = roundProtocols.get(roundId)
      if (knownProtocol !== undefined && bundle.protocolVersion !== knownProtocol) {
        throw new RankedClientError(
          'protocol_mismatch',
          'Replay protocol differs from the round creation anchor.',
        )
      }
      if (anchor !== undefined) assertReplayAnchor(bundle, anchor)
      return bundle
    },
    async acknowledgeReplay(roundId, input, requestOptions) {
      if (input.verifierVersion.trim().length === 0) {
        throw new TypeError('verifierVersion must not be empty')
      }
      if (!/^[0-9a-f]{64}$/.test(input.proofDigest)) {
        throw new TypeError('proofDigest must be 32 lowercase hexadecimal bytes')
      }
      return parseReplayVerifiedResponse(await request(
        'POST',
        `/v1/solo-rounds/${segment(roundId, 'round id')}/replay-verified`,
        input,
        requestOptions,
      ))
    },
    streamUrl(roundId) {
      return endpoint(baseUrl, `/v1/solo-rounds/${segment(roundId, 'round id')}/stream`)
    },
    protocolForRound(roundId) {
      return roundProtocols.get(roundId) ?? null
    },
  }
}
