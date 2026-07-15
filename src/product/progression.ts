import { DECKS, getDeck, type DeckDefinition } from '../game'
import type { ProfileRoundResult, StorageLike, StrikefallProfile } from './profile'

export const DAILY_PROGRESS_STORAGE_KEY = 'strikefall.daily-progress.v1'

const DAILY_PROGRESS_VERSION = 1 as const
const DAY_MS = 86_400_000
const MAX_DAILY_ENTRIES = 14

export type DailyMissionId =
  | 'high-risk-hold'
  | 'perfect-escape'
  | 'sniper-sweep'

export interface DailyMissionDefinition {
  id: DailyMissionId
  title: string
  description: string
  rule: string
}

export interface DailyChallenge {
  id: string
  date: string
  deck: DeckDefinition
  rankedDeckId: string
  deckVersion: number
  mission: DailyMissionDefinition
  pathPolicy: 'fresh-per-attempt'
}

export interface DailyProgressEntry {
  challengeId: string
  attempts: number
  completedAt: string | null
}

export interface DailyProgressState {
  version: typeof DAILY_PROGRESS_VERSION
  entries: DailyProgressEntry[]
}

export interface DailyChallengeProgress {
  attempts: number
  completed: boolean
  completedAt: string | null
}

export interface MasteryTier {
  level: number
  name: string
  minimumXp: number
}

export interface CosmeticUnlock {
  id: string
  name: string
  kind: 'flag' | 'trail' | 'impact' | 'frame'
  level: number
}

export interface DeckMastery {
  deck: DeckDefinition
  xp: number
  tier: MasteryTier
  nextTier: MasteryTier | null
  progress: number
  unlocked: CosmeticUnlock[]
  nextUnlock: CosmeticUnlock | null
  rounds: number
  held: number
  escaped: number
  bestScore: number
}

export const DAILY_MISSIONS: readonly DailyMissionDefinition[] = [
  {
    id: 'high-risk-hold',
    title: 'Hold the red line',
    description: 'Survive with a 4× or larger risk reward.',
    rule: 'Hold to the finish · risk reward ≥ 4×',
  },
  {
    id: 'perfect-escape',
    title: 'Airlock artist',
    description: 'Escape no more than one second before the line would hit.',
    rule: 'Escape 0–1.0 s before impact',
  },
  {
    id: 'sniper-sweep',
    title: 'Outscope the Snipers',
    description: 'Finish ahead of every Sniper bot in the room.',
    rule: 'Beat every Sniper · no future path access',
  },
] as const

export const MASTERY_TIERS: readonly MasteryTier[] = [
  { level: 0, name: 'Unplayed', minimumXp: 0 },
  { level: 1, name: 'Scout', minimumXp: 100 },
  { level: 2, name: 'Striker', minimumXp: 320 },
  { level: 3, name: 'Warden', minimumXp: 720 },
  { level: 4, name: 'Stormbound', minimumXp: 1_400 },
] as const

const COSMETIC_UNLOCKS: readonly Omit<CosmeticUnlock, 'id'>[] = [
  { name: 'Signal pennant', kind: 'flag', level: 1 },
  { name: 'Pressure trail', kind: 'trail', level: 2 },
  { name: 'Strike flare', kind: 'impact', level: 3 },
  { name: 'Stormbound frame', kind: 'frame', level: 4 },
] as const

export const EMPTY_DAILY_PROGRESS: DailyProgressState = {
  version: DAILY_PROGRESS_VERSION,
  entries: [],
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function dayOrdinal(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS)
}

export function utcDateKey(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Daily challenge date is invalid')
  return now.toISOString().slice(0, 10)
}

/**
 * Daily identity binds only the featured deck and mission. Every attempt still
 * asks the round engine for fresh hidden path and bot seeds.
 */
export function dailyChallengeFor(now = new Date()): DailyChallenge {
  const date = utcDateKey(now)
  const ordinal = dayOrdinal(date)
  const deck = DECKS[((ordinal % DECKS.length) + DECKS.length) % DECKS.length] as DeckDefinition
  const mission = DAILY_MISSIONS[
    ((ordinal % DAILY_MISSIONS.length) + DAILY_MISSIONS.length) % DAILY_MISSIONS.length
  ] as DailyMissionDefinition
  return {
    id: `strikefall-daily:${date}`,
    date,
    deck,
    rankedDeckId: deck.id.replaceAll('-', '_'),
    deckVersion: deck.version,
    mission,
    pathPolicy: 'fresh-per-attempt',
  }
}

function dailyChallengeDateFromId(challengeId: string | undefined): Date | null {
  const match = /^strikefall-daily:(\d{4}-\d{2}-\d{2})$/.exec(challengeId ?? '')
  if (!match) return null
  const date = new Date(`${match[1]}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || utcDateKey(date) !== match[1]) return null
  return date
}

export function parseDailyProgress(value: string): DailyProgressState | null {
  try {
    const parsed = JSON.parse(value) as Partial<DailyProgressState>
    if (parsed.version !== DAILY_PROGRESS_VERSION || !Array.isArray(parsed.entries)) return null
    const seen = new Set<string>()
    const entries = parsed.entries.slice(0, MAX_DAILY_ENTRIES).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const candidate = entry as Partial<DailyProgressEntry>
      if (
        typeof candidate.challengeId !== 'string'
        || !/^strikefall-daily:\d{4}-\d{2}-\d{2}$/.test(candidate.challengeId)
        || seen.has(candidate.challengeId)
      ) return []
      seen.add(candidate.challengeId)
      const attempts = typeof candidate.attempts === 'number' && Number.isFinite(candidate.attempts)
        ? Math.max(0, Math.min(10_000, Math.round(candidate.attempts)))
        : 0
      const completedAt = typeof candidate.completedAt === 'string'
        && Number.isFinite(Date.parse(candidate.completedAt))
        ? new Date(candidate.completedAt).toISOString()
        : null
      return [{ challengeId: candidate.challengeId, attempts, completedAt }]
    })
    entries.sort((left, right) => right.challengeId.localeCompare(left.challengeId))
    return { version: DAILY_PROGRESS_VERSION, entries }
  } catch {
    return null
  }
}

export function loadDailyProgress(
  storage: StorageLike | null = defaultStorage(),
): DailyProgressState {
  if (!storage) return EMPTY_DAILY_PROGRESS
  try {
    const value = storage.getItem(DAILY_PROGRESS_STORAGE_KEY)
    return value ? parseDailyProgress(value) ?? EMPTY_DAILY_PROGRESS : EMPTY_DAILY_PROGRESS
  } catch {
    return EMPTY_DAILY_PROGRESS
  }
}

export function persistDailyProgress(
  progress: DailyProgressState,
  storage: StorageLike | null = defaultStorage(),
) {
  if (!storage) return false
  try {
    storage.setItem(DAILY_PROGRESS_STORAGE_KEY, JSON.stringify(progress))
    return true
  } catch {
    return false
  }
}

export function clearDailyProgress(
  storage: StorageLike | null = defaultStorage(),
) {
  if (!storage) return false
  try {
    storage.removeItem(DAILY_PROGRESS_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

export function challengeProgress(
  state: DailyProgressState,
  challenge: DailyChallenge,
): DailyChallengeProgress {
  const entry = state.entries.find((candidate) => candidate.challengeId === challenge.id)
  return {
    attempts: entry?.attempts ?? 0,
    completed: entry?.completedAt !== null && entry?.completedAt !== undefined,
    completedAt: entry?.completedAt ?? null,
  }
}

function completesMission(mission: DailyMissionId, result: ProfileRoundResult) {
  if (mission === 'high-risk-hold') {
    return result.outcome === 'survived' && result.multiplier >= 4
  }
  if (mission === 'perfect-escape') {
    return result.outcome === 'escaped'
      && typeof result.escapeLeadSeconds === 'number'
      && Number.isFinite(result.escapeLeadSeconds)
      && result.escapeLeadSeconds >= 0
      && result.escapeLeadSeconds <= 1
  }
  const snipers = result.opponents?.filter((opponent) => opponent.persona === 'Sniper') ?? []
  return typeof result.rank === 'number'
    && Number.isFinite(result.rank)
    && snipers.length > 0
    && snipers.every((sniper) => result.rank! < sniper.rank)
}

export function recordDailyChallengeRound(
  state: DailyProgressState,
  result: ProfileRoundResult,
  now = new Date(),
): DailyProgressState {
  const challengeDate = dailyChallengeDateFromId(result.dailyChallengeId)
  if (!challengeDate) return state
  const challenge = dailyChallengeFor(challengeDate)
  if (
    result.dailyChallengeId !== challenge.id
    || result.deckId !== challenge.deck.id
  ) return state
  const previous = state.entries.find((entry) => entry.challengeId === challenge.id)
  const completed = previous?.completedAt !== null && previous?.completedAt !== undefined
  const completedNow = !completed && completesMission(challenge.mission.id, result)
  const next: DailyProgressEntry = {
    challengeId: challenge.id,
    attempts: (previous?.attempts ?? 0) + 1,
    completedAt: previous?.completedAt ?? (completedNow ? now.toISOString() : null),
  }
  return {
    version: DAILY_PROGRESS_VERSION,
    entries: [
      next,
      ...state.entries.filter((entry) => entry.challengeId !== challenge.id),
    ]
      .sort((left, right) => right.challengeId.localeCompare(left.challengeId))
      .slice(0, MAX_DAILY_ENTRIES),
  }
}

function masteryXp(record: StrikefallProfile['deckRecords'][number] | undefined) {
  if (!record) return 0
  return Math.max(0, Math.round(
    record.rounds * 20
    + record.survived * 45
    + record.escaped * 30
    + Math.min(record.bestScore, 1_000) * 0.1
    + Math.min(record.bestMultiplier, 8) * 10,
  ))
}

function cosmeticsFor(deck: DeckDefinition): CosmeticUnlock[] {
  return COSMETIC_UNLOCKS.map((unlock) => ({
    ...unlock,
    id: `${deck.id}:${unlock.kind}`,
  }))
}

export function deriveDeckMastery(profile: StrikefallProfile): DeckMastery[] {
  return DECKS.map((deck) => {
    const record = profile.deckRecords.find((candidate) => candidate.deckId === deck.id)
    const xp = masteryXp(record)
    const tier = [...MASTERY_TIERS].reverse().find((candidate) => xp >= candidate.minimumXp)
      ?? MASTERY_TIERS[0] as MasteryTier
    const nextTier = MASTERY_TIERS.find((candidate) => candidate.level === tier.level + 1) ?? null
    const span = nextTier ? nextTier.minimumXp - tier.minimumXp : 1
    const progress = nextTier
      ? Math.max(0, Math.min(1, (xp - tier.minimumXp) / span))
      : 1
    const cosmetics = cosmeticsFor(deck)
    return {
      deck,
      xp,
      tier,
      nextTier,
      progress,
      unlocked: cosmetics.filter((unlock) => unlock.level <= tier.level),
      nextUnlock: cosmetics.find((unlock) => unlock.level > tier.level) ?? null,
      rounds: record?.rounds ?? 0,
      held: record?.survived ?? 0,
      escaped: record?.escaped ?? 0,
      bestScore: record?.bestScore ?? 0,
    }
  })
}

export function masteryForDeck(profile: StrikefallProfile, deckId: string) {
  if (!getDeck(deckId)) return null
  return deriveDeckMastery(profile).find((mastery) => mastery.deck.id === deckId) ?? null
}
