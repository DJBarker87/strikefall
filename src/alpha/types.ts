export interface AlphaSessionView {
  handle: string
  expiresAtMs: number
  telemetryConsent: boolean
  experiments: Readonly<Record<string, string>>
}

export interface IssuedAlphaSession {
  token: string
  session: AlphaSessionView
}

export interface IssueAlphaSessionRequest {
  inviteCode?: string | null
  handle?: string | null
  telemetryConsent: boolean
}

export type LeaderboardWindow = 'daily' | 'weekly'

export interface LeaderboardEntry {
  rank: number
  handle: string
  /** Canonical SolMath 1e12 score. */
  score: string
  outcome: 'survived' | 'eliminated' | 'escaped'
  roundId: string
  resolvedAtMs: number
  isSelf: boolean
}

export interface LeaderboardResponse {
  deckId: string
  deckVersion: number
  window: LeaderboardWindow
  generatedAtMs: number
  entries: readonly LeaderboardEntry[]
  selfEntry: LeaderboardEntry | null
  nextCursor: string | null
}

export interface LeaderboardQuery {
  window?: LeaderboardWindow
  limit?: number
  cursor?: string
}

export interface AlphaTelemetryEvent {
  eventId: string
  name: string
  occurredAtMs: number
  properties: Readonly<Record<string, string | number | boolean | null>>
}

export interface AlphaTelemetryBatchResponse {
  accepted: number
  duplicates: number
}

export interface AlphaApiErrorPayload {
  code: string | null
  message: string
  retryAfterMs: number | null
}
