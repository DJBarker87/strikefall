import type {
  AlphaApiErrorPayload,
  AlphaSessionView,
  AlphaTelemetryBatchResponse,
  AlphaTelemetryEvent,
  IssuedAlphaSession,
  IssueAlphaSessionRequest,
  LeaderboardEntry,
  LeaderboardQuery,
  LeaderboardResponse,
  LeaderboardWindow,
} from './types'

export class AlphaApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly retryAfterMs: number | null

  constructor(status: number, payload: AlphaApiErrorPayload) {
    super(payload.message)
    this.name = 'AlphaApiError'
    this.status = status
    this.code = payload.code
    this.retryAfterMs = payload.retryAfterMs
  }
}

export interface AlphaApiClientOptions {
  baseUrl: string
  token: () => string | null
  fetch?: typeof globalThis.fetch
}

export interface AlphaApiClient {
  readonly baseUrl: string
  issueSession(request: IssueAlphaSessionRequest): Promise<IssuedAlphaSession>
  session(): Promise<AlphaSessionView>
  rename(handle: string): Promise<AlphaSessionView>
  rotate(): Promise<IssuedAlphaSession>
  setTelemetryConsent(consent: boolean): Promise<AlphaSessionView>
  leaderboard(deckId: string, query?: LeaderboardQuery): Promise<LeaderboardResponse>
  sendTelemetry(events: readonly AlphaTelemetryEvent[]): Promise<AlphaTelemetryBatchResponse>
}

type JsonObject = Record<string, unknown>

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  return value as JsonObject
}

function text(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${field} must be non-empty text`)
  }
  return value
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw new TypeError(`${field} must be a safe unsigned integer`)
  }
  return value
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`)
  return value
}

function nullable<T>(value: unknown, field: string, parser: (value: unknown, field: string) => T): T | null {
  return value === null ? null : parser(value, field)
}

function sessionView(value: unknown, field = 'session'): AlphaSessionView {
  const source = object(value, field)
  const experimentsSource = object(source.experiments, `${field}.experiments`)
  const experiments: Record<string, string> = {}
  for (const [key, variant] of Object.entries(experimentsSource)) {
    experiments[text(key, `${field}.experiments.key`, 64)] = text(
      variant,
      `${field}.experiments.${key}`,
      64,
    )
  }
  return {
    handle: text(source.handle, `${field}.handle`, 24),
    expiresAtMs: integer(source.expiresAtMs, `${field}.expiresAtMs`),
    telemetryConsent: boolean(source.telemetryConsent, `${field}.telemetryConsent`),
    experiments,
  }
}

function issuedSession(value: unknown): IssuedAlphaSession {
  const source = object(value, 'issuedSession')
  return {
    token: text(source.token, 'issuedSession.token', 256),
    session: sessionView(source.session),
  }
}

function windowValue(value: unknown, field: string): LeaderboardWindow {
  if (value !== 'daily' && value !== 'weekly') throw new TypeError(`${field} is invalid`)
  return value
}

function outcome(value: unknown, field: string): LeaderboardEntry['outcome'] {
  if (value !== 'survived' && value !== 'eliminated' && value !== 'escaped') {
    throw new TypeError(`${field} is invalid`)
  }
  return value
}

function canonicalScore(value: unknown, field: string): string {
  const score = text(value, field, 48)
  if (!/^(?:0|[1-9][0-9]*)$/.test(score)) throw new TypeError(`${field} is not canonical`)
  return score
}

function leaderboardEntry(value: unknown, field: string): LeaderboardEntry {
  const source = object(value, field)
  return {
    rank: integer(source.rank, `${field}.rank`),
    handle: text(source.handle, `${field}.handle`, 24),
    score: canonicalScore(source.score, `${field}.score`),
    outcome: outcome(source.outcome, `${field}.outcome`),
    roundId: text(source.roundId, `${field}.roundId`, 64),
    resolvedAtMs: integer(source.resolvedAtMs, `${field}.resolvedAtMs`),
    isSelf: boolean(source.isSelf, `${field}.isSelf`),
  }
}

function leaderboardResponse(value: unknown): LeaderboardResponse {
  const source = object(value, 'leaderboard')
  if (!Array.isArray(source.entries)) throw new TypeError('leaderboard.entries must be an array')
  return {
    deckId: text(source.deckId, 'leaderboard.deckId', 64),
    deckVersion: integer(source.deckVersion, 'leaderboard.deckVersion'),
    window: windowValue(source.window, 'leaderboard.window'),
    generatedAtMs: integer(source.generatedAtMs, 'leaderboard.generatedAtMs'),
    entries: source.entries.map((entry, index) => leaderboardEntry(entry, `leaderboard.entries[${index}]`)),
    selfEntry: nullable(source.selfEntry, 'leaderboard.selfEntry', leaderboardEntry),
    nextCursor: nullable(source.nextCursor, 'leaderboard.nextCursor', text),
  }
}

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new TypeError('Alpha API base URL is required')
  return baseUrl
}

function safeSegment(value: string, field: string): string {
  if (!value.trim()) throw new TypeError(`${field} is required`)
  return encodeURIComponent(value)
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch (error) {
    throw new TypeError('Alpha service returned malformed JSON', { cause: error })
  }
}

function apiError(value: unknown, status: number): AlphaApiError {
  try {
    const source = object(value, 'error')
    return new AlphaApiError(status, {
      code: typeof source.code === 'string' ? source.code : null,
      message: typeof source.message === 'string'
        ? source.message
        : `Alpha service returned HTTP ${status}`,
      retryAfterMs: typeof source.retryAfterMs === 'number' && Number.isSafeInteger(source.retryAfterMs)
        ? source.retryAfterMs
        : null,
    })
  } catch {
    return new AlphaApiError(status, {
      code: null,
      message: `Alpha service returned HTTP ${status}`,
      retryAfterMs: null,
    })
  }
}

export function createBearerFetch(
  token: () => string | null,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const bearer = token()
    if (!bearer) throw new AlphaApiError(401, {
      code: 'unauthorized',
      message: 'An anonymous alpha session is required.',
      retryAfterMs: null,
    })
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${bearer}`)
    return fetchImpl(input, { ...init, headers })
  }
}

export function createAlphaApiClient(options: AlphaApiClientOptions): AlphaApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const endpoint = (path: string) => `${baseUrl}/${path.replace(/^\/+/, '')}`

  async function request(path: string, init: RequestInit, authenticated: boolean): Promise<unknown> {
    const headers = new Headers(init.headers)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    if (authenticated) {
      const bearer = options.token()
      if (!bearer) throw new AlphaApiError(401, {
        code: 'unauthorized',
        message: 'An anonymous alpha session is required.',
        retryAfterMs: null,
      })
      headers.set('authorization', `Bearer ${bearer}`)
    }
    let response: Response
    try {
      response = await fetchImpl(endpoint(path), { ...init, headers })
    } catch (error) {
      throw new TypeError('Alpha service could not be reached', { cause: error })
    }
    const body = await responseJson(response)
    if (!response.ok) throw apiError(body, response.status)
    return body
  }

  return {
    baseUrl,
    async issueSession(input) {
      return issuedSession(await request('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({
          inviteCode: input.inviteCode?.trim() || null,
          handle: input.handle?.trim() || null,
          telemetryConsent: input.telemetryConsent,
        }),
      }, false))
    },
    async session() {
      return sessionView(await request('/v1/sessions/me', { method: 'GET' }, true))
    },
    async rename(handle) {
      return sessionView(await request('/v1/sessions/rename', {
        method: 'POST',
        body: JSON.stringify({ handle: handle.trim() }),
      }, true))
    },
    async rotate() {
      return issuedSession(await request('/v1/sessions/rotate', { method: 'POST' }, true))
    },
    async setTelemetryConsent(consent) {
      return sessionView(await request('/v1/sessions/telemetry-consent', {
        method: 'POST',
        body: JSON.stringify({ consent }),
      }, true))
    },
    async leaderboard(deckId, query = {}) {
      if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
        throw new RangeError('Leaderboard limit must be between 1 and 100')
      }
      const search = new URLSearchParams()
      if (query.window) search.set('window', query.window)
      if (query.limit) search.set('limit', String(query.limit))
      if (query.cursor) search.set('cursor', query.cursor)
      const suffix = search.size ? `?${search}` : ''
      return leaderboardResponse(await request(
        `/v1/leaderboards/${safeSegment(deckId, 'deck id')}${suffix}`,
        { method: 'GET' },
        true,
      ))
    },
    async sendTelemetry(events) {
      if (events.length < 1 || events.length > 50) {
        throw new RangeError('Telemetry batch must contain 1–50 events')
      }
      const source = object(await request('/v1/telemetry/batch', {
        method: 'POST',
        body: JSON.stringify({ schemaVersion: 'strikefall/telemetry/v2', events }),
      }, true), 'telemetry response')
      return {
        accepted: integer(source.accepted, 'telemetry.accepted'),
        duplicates: integer(source.duplicates, 'telemetry.duplicates'),
      }
    },
  }
}
