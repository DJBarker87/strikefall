export type StrikefallEventName =
  | 'session_started'
  | 'tutorial_completed'
  | 'deck_revealed'
  | 'approach_viewed'
  | 'flag_move'
  | 'flag_side_changed'
  | 'placement_locked'
  | 'bot_move_seen'
  | 'flag_hit'
  | 'cluster_wipe'
  | 'escape_unlocked'
  | 'escape_pressed'
  | 'player_eliminated'
  | 'spectate_started'
  | 'rematch_started'
  | 'round_completed'
  | 'replay_verified'
  | 'share_opened'
  | 'clip_exported'
  | 'break_reminder_shown'
  | 'ranked_degraded_to_practice'
  | 'practice_paused'
  | 'practice_resumed'
  | 'client_error'

export const CLIENT_ERROR_SURFACES = [
  'session',
  'arena',
  'replay',
  'leaderboard',
] as const

export const CLIENT_RUNTIME_ERROR_CODES = [
  'uncaught_exception',
  'unhandled_rejection',
  'render_failure',
] as const

export const CLIENT_ERROR_CODES = [
  'request_failed',
  'session_expired',
  'stream_disconnected',
  'unsupported_protocol',
  'verification_failed',
  ...CLIENT_RUNTIME_ERROR_CODES,
] as const

export type ClientErrorSurface = typeof CLIENT_ERROR_SURFACES[number]
export type ClientErrorCode = typeof CLIENT_ERROR_CODES[number]
export type ClientRuntimeErrorCode = typeof CLIENT_RUNTIME_ERROR_CODES[number]

export type ClientErrorProperties = Readonly<{
  code: ClientErrorCode
  surface: ClientErrorSurface
}>

export interface StrikefallTelemetryEvent {
  id: string
  name: StrikefallEventName
  at: string
  sessionId: string
  roundId?: string
  payload: Record<string, string | number | boolean | null>
}

export const TELEMETRY_STORAGE_KEY = 'strikefall.prototype.telemetry.v1'
const SESSION_KEY = 'strikefall.prototype.session.v1'
const MAX_LOCAL_EVENTS = 500

export interface TelemetryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function localTelemetryStorage(): TelemetryStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function telemetryPreference(storage: TelemetryStorage | null) {
  if (!storage) return 'local'
  try {
    const value = storage.getItem('strikefall.preferences.v1')
    if (!value) return 'local'
    const parsed = JSON.parse(value) as { telemetry?: unknown }
    return parsed.telemetry === 'off' || parsed.telemetry === 'shared' ? parsed.telemetry : 'local'
  } catch {
    return 'local'
  }
}

function createId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function getSessionId() {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY)
    if (existing) return existing
    const next = createId()
    sessionStorage.setItem(SESSION_KEY, next)
    return next
  } catch {
    return 'local-session'
  }
}

export function readLocalTelemetry(
  storage: TelemetryStorage | null = localTelemetryStorage(),
): StrikefallTelemetryEvent[] {
  try {
    const value = storage?.getItem(TELEMETRY_STORAGE_KEY)
    if (!value) return []
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function track(
  name: StrikefallEventName,
  payload: StrikefallTelemetryEvent['payload'] = {},
  roundId?: string,
) {
  const storage = localTelemetryStorage()
  if (telemetryPreference(storage) === 'off') return null
  const event: StrikefallTelemetryEvent = {
    id: createId(),
    name,
    at: new Date().toISOString(),
    sessionId: getSessionId(),
    roundId,
    payload,
  }

  try {
    const events = [...readLocalTelemetry(storage), event].slice(-MAX_LOCAL_EVENTS)
    storage?.setItem(TELEMETRY_STORAGE_KEY, JSON.stringify(events))
  } catch {
    // The game remains completely playable when storage is unavailable.
  }

  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('strikefall:telemetry', { detail: event }))
  }
  return event
}

export function clearLocalTelemetry(storage: TelemetryStorage | null = localTelemetryStorage()) {
  try {
    storage?.removeItem(TELEMETRY_STORAGE_KEY)
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
