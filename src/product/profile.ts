export const PROFILE_STORAGE_KEY = 'strikefall.profile.v1'

const PROFILE_VERSION = 1 as const
const MAX_DECK_RECORDS = 24
const MAX_RIVAL_RECORDS = 20

export interface DeckRecord {
  deckId: string
  rounds: number
  survived: number
  escaped: number
  bestScore: number
  bestMultiplier: number
}

export interface RivalRecord {
  botId: string
  botName: string
  wins: number
  losses: number
  /** Settled rounds where this selected rival used the Mimic/copy policy. */
  copyEncounters: number
  lastMetAt: string
}

export interface StrikefallProfile {
  version: typeof PROFILE_VERSION
  id: string
  handle: string
  createdAt: string
  updatedAt: string
  rounds: number
  survived: number
  escaped: number
  eliminated: number
  currentStreak: number
  bestStreak: number
  totalScore: number
  bestScore: number
  bestMultiplier: number
  deckRecords: DeckRecord[]
  rivals: RivalRecord[]
}

export interface ProfileRoundResult {
  deckId: string
  /** Present only when this round was launched from the matching Daily Deck card. */
  dailyChallengeId?: string
  /** Present only when launched from the current weekly rivalry card. */
  weeklyChallengeId?: string
  outcome: 'survived' | 'escaped' | 'eliminated'
  score: number
  multiplier: number
  /** Final one-indexed lobby rank, used only for local mission progress. */
  rank?: number
  /** Seconds between Escape and the counterfactual hit, when the held flag would hit. */
  escapeLeadSeconds?: number
  /** Final public persona/rank facts; future path data is never included. */
  opponents?: readonly {
    botId?: string
    botName?: string
    persona: string
    rank: number
  }[]
  rival?: {
    botId: string
    botName: string
    playerWon: boolean
    copiedPlayer?: boolean
  }
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
    return bytes
  }
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256)
  }
  return bytes
}

function clampWhole(value: unknown, minimum = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.round(value))
    : minimum
}

function clampNumber(value: unknown, minimum = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, value)
    : minimum
}

function cleanToken(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback
  const cleaned = value.trim().slice(0, 48)
  return cleaned || fallback
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function createAnonymousProfile(
  options: { now?: Date; entropy?: Uint8Array } = {},
): StrikefallProfile {
  const entropy = options.entropy ?? randomBytes(12)
  if (entropy.length < 6) throw new RangeError('Profile entropy must contain at least six bytes')
  const hex = bytesToHex(entropy)
  const now = (options.now ?? new Date()).toISOString()
  const callsign = hex.slice(-4).toUpperCase()
  return {
    version: PROFILE_VERSION,
    id: `anon_${hex}`,
    handle: `Striker-${callsign}`,
    createdAt: now,
    updatedAt: now,
    rounds: 0,
    survived: 0,
    escaped: 0,
    eliminated: 0,
    currentStreak: 0,
    bestStreak: 0,
    totalScore: 0,
    bestScore: 0,
    bestMultiplier: 0,
    deckRecords: [],
    rivals: [],
  }
}

export function parseProfile(value: string): StrikefallProfile | null {
  try {
    const parsed = JSON.parse(value) as Partial<StrikefallProfile>
    if (parsed.version !== PROFILE_VERSION || typeof parsed.id !== 'string') return null
    if (!parsed.id.startsWith('anon_') || parsed.id.length < 17) return null
    const createdAt = cleanToken(parsed.createdAt, new Date(0).toISOString())
    const updatedAt = cleanToken(parsed.updatedAt, createdAt)
    const rounds = clampWhole(parsed.rounds)
    const survived = Math.min(rounds, clampWhole(parsed.survived))
    const escaped = Math.min(rounds - survived, clampWhole(parsed.escaped))
    const eliminated = Math.max(0, rounds - survived - escaped)
    const deckRecords = Array.isArray(parsed.deckRecords)
      ? parsed.deckRecords.slice(0, MAX_DECK_RECORDS).flatMap((record) => {
        if (!record || typeof record !== 'object') return []
        const candidate = record as Partial<DeckRecord>
        if (typeof candidate.deckId !== 'string' || !candidate.deckId.trim()) return []
        return [{
          deckId: cleanToken(candidate.deckId, 'unknown'),
          rounds: clampWhole(candidate.rounds),
          survived: clampWhole(candidate.survived),
          escaped: clampWhole(candidate.escaped),
          bestScore: clampWhole(candidate.bestScore),
          bestMultiplier: clampNumber(candidate.bestMultiplier),
        }]
      })
      : []
    const rivals = Array.isArray(parsed.rivals)
      ? parsed.rivals.slice(0, MAX_RIVAL_RECORDS).flatMap((record) => {
        if (!record || typeof record !== 'object') return []
        const candidate = record as Partial<RivalRecord>
        if (typeof candidate.botId !== 'string' || !candidate.botId.trim()) return []
        return [{
          botId: cleanToken(candidate.botId, 'unknown'),
          botName: cleanToken(candidate.botName, 'Unknown bot'),
          wins: clampWhole(candidate.wins),
          losses: clampWhole(candidate.losses),
          // Profiles written before rivalry-copy tracking remain valid v1 records.
          copyEncounters: clampWhole(candidate.copyEncounters),
          lastMetAt: cleanToken(candidate.lastMetAt, updatedAt),
        }]
      })
      : []

    return {
      version: PROFILE_VERSION,
      id: parsed.id,
      handle: cleanToken(parsed.handle, `Striker-${parsed.id.slice(-4).toUpperCase()}`),
      createdAt,
      updatedAt,
      rounds,
      survived,
      escaped,
      eliminated,
      currentStreak: Math.min(rounds, clampWhole(parsed.currentStreak)),
      bestStreak: Math.min(rounds, clampWhole(parsed.bestStreak)),
      totalScore: clampWhole(parsed.totalScore),
      bestScore: clampWhole(parsed.bestScore),
      bestMultiplier: clampNumber(parsed.bestMultiplier),
      deckRecords,
      rivals,
    }
  } catch {
    return null
  }
}

export function loadOrCreateProfile(
  storage: StorageLike | null = defaultStorage(),
  options: { now?: Date; entropy?: Uint8Array } = {},
): StrikefallProfile {
  if (storage) {
    try {
      const existing = storage.getItem(PROFILE_STORAGE_KEY)
      const profile = existing ? parseProfile(existing) : null
      if (profile) return profile
    } catch {
      // Private browsing and constrained embeds may reject storage access.
    }
  }
  const profile = createAnonymousProfile(options)
  persistProfile(profile, storage)
  return profile
}

export function persistProfile(
  profile: StrikefallProfile,
  storage: StorageLike | null = defaultStorage(),
) {
  if (!storage) return false
  try {
    storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile))
    return true
  } catch {
    return false
  }
}

export function renameProfile(
  profile: StrikefallProfile,
  handle: string,
  now = new Date(),
): StrikefallProfile {
  const cleaned = handle.trim().replace(/\s+/g, ' ').slice(0, 24)
  if (cleaned.length < 2) throw new RangeError('Callsign must contain at least two characters')
  return { ...profile, handle: cleaned, updatedAt: now.toISOString() }
}

export function recordProfileRound(
  profile: StrikefallProfile,
  result: ProfileRoundResult,
  now = new Date(),
): StrikefallProfile {
  const survived = result.outcome === 'survived'
  const escaped = result.outcome === 'escaped'
  const successful = survived || escaped
  const score = clampWhole(result.score)
  const multiplier = clampNumber(result.multiplier)
  const currentStreak = successful ? profile.currentStreak + 1 : 0
  const deckRecord = profile.deckRecords.find((record) => record.deckId === result.deckId)
  const nextDeckRecord: DeckRecord = {
    deckId: result.deckId,
    rounds: (deckRecord?.rounds ?? 0) + 1,
    survived: (deckRecord?.survived ?? 0) + Number(survived),
    escaped: (deckRecord?.escaped ?? 0) + Number(escaped),
    bestScore: Math.max(deckRecord?.bestScore ?? 0, score),
    bestMultiplier: Math.max(deckRecord?.bestMultiplier ?? 0, multiplier),
  }
  const deckRecords = [
    nextDeckRecord,
    ...profile.deckRecords.filter((record) => record.deckId !== result.deckId),
  ].slice(0, MAX_DECK_RECORDS)

  let rivals = profile.rivals
  if (result.rival) {
    const previous = rivals.find((record) => record.botId === result.rival?.botId)
    const next: RivalRecord = {
      botId: result.rival.botId,
      botName: result.rival.botName,
      wins: (previous?.wins ?? 0) + Number(result.rival.playerWon),
      losses: (previous?.losses ?? 0) + Number(!result.rival.playerWon),
      copyEncounters: (previous?.copyEncounters ?? 0) + Number(result.rival.copiedPlayer === true),
      lastMetAt: now.toISOString(),
    }
    rivals = [next, ...rivals.filter((record) => record.botId !== result.rival?.botId)]
      .slice(0, MAX_RIVAL_RECORDS)
  }

  return {
    ...profile,
    updatedAt: now.toISOString(),
    rounds: profile.rounds + 1,
    survived: profile.survived + Number(survived),
    escaped: profile.escaped + Number(escaped),
    eliminated: profile.eliminated + Number(result.outcome === 'eliminated'),
    currentStreak,
    bestStreak: Math.max(profile.bestStreak, currentStreak),
    totalScore: profile.totalScore + score,
    bestScore: Math.max(profile.bestScore, score),
    bestMultiplier: Math.max(profile.bestMultiplier, multiplier),
    deckRecords,
    rivals,
  }
}

export function clearProfile(storage: StorageLike | null = defaultStorage()) {
  if (!storage) return false
  try {
    storage.removeItem(PROFILE_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}
