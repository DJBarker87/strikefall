import { BOT_PROFILES, DECKS, type BotProfile, type DeckDefinition } from '../game'
import type { ProfileRoundResult, StorageLike } from './profile'

export const WEEKLY_PROGRESS_STORAGE_KEY = 'strikefall.weekly-progress.v1'

const WEEKLY_PROGRESS_VERSION = 1 as const
const WEEK_MS = 7 * 86_400_000
const MONDAY_EPOCH_MS = Date.UTC(1970, 0, 5)
const MAX_WEEKLY_ENTRIES = 16

export type WeeklyDeckConditionId =
  | 'balanced-hold'
  | 'compression-courage'
  | 'opening-pack'
  | 'pulse-airlock'

export interface WeeklyRival {
  botId: string
  name: string
  persona: BotProfile['persona']
  color: string
  /** Exact authoritative roster identity used when this challenge is launched in Ranked. */
  rankedAlias: {
    botId: string
    name: string
    persona: BotProfile['persona']
  }
}

export interface WeeklyMissionDefinition {
  id: WeeklyDeckConditionId
  title: string
  description: string
  rule: string
}

export interface WeeklyChallenge {
  id: string
  weekStart: string
  weekEndExclusive: string
  deck: DeckDefinition
  rankedDeckId: string
  deckVersion: number
  rival: WeeklyRival
  mission: WeeklyMissionDefinition
  /** Challenge identity never selects the hidden path or bot seed. */
  pathPolicy: 'fresh-per-attempt'
  launchPolicy: 'ordinary-round'
}

export interface WeeklyProgressEntry {
  challengeId: string
  attempts: number
  completedAt: string | null
}

export interface WeeklyProgressState {
  version: typeof WEEKLY_PROGRESS_VERSION
  entries: WeeklyProgressEntry[]
}

export interface WeeklyChallengeProgress {
  attempts: number
  completed: boolean
  completedAt: string | null
}

export const EMPTY_WEEKLY_PROGRESS: WeeklyProgressState = {
  version: WEEKLY_PROGRESS_VERSION,
  entries: [],
}

const RIVAL_BY_DECK: Readonly<Record<string, string>> = {
  'balanced-tape': 'turtle-exe',
  'compression-break': 'greedlord',
  'opening-rush': 'wickhunter',
  pulse: 'echo',
}

/** Ranked uses stable numeric roster slots and its own public display names. */
const RANKED_RIVAL_BY_DECK: Readonly<Record<string, WeeklyRival['rankedAlias']>> = {
  'balanced-tape': { botId: 'bot-1', name: 'Turtle.exe', persona: 'Turtle' },
  'compression-break': { botId: 'bot-8', name: 'Cold Storage', persona: 'Greedlord' },
  'opening-rush': { botId: 'bot-2', name: 'Wick Witch', persona: 'Sniper' },
  pulse: { botId: 'bot-4', name: 'Mimic', persona: 'Mimic' },
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function safeModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function utcWeekStartKey(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Weekly challenge date is invalid')
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const mondayOffset = (new Date(midnight).getUTCDay() + 6) % 7
  return utcDate(midnight - mondayOffset * 86_400_000)
}

function weekStartMs(weekStart: string): number {
  const [year, month, day] = weekStart.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function canonicalRival(deck: DeckDefinition): WeeklyRival {
  const botId = RIVAL_BY_DECK[deck.id]
  const profile = BOT_PROFILES.find((candidate) => candidate.id === botId)
  if (!profile) throw new Error(`Missing canonical weekly rival for ${deck.id}`)
  return {
    botId: profile.id,
    name: profile.name,
    persona: profile.persona,
    color: profile.color,
    rankedAlias: RANKED_RIVAL_BY_DECK[deck.id],
  }
}

function missionFor(deck: DeckDefinition, rival: WeeklyRival): WeeklyMissionDefinition {
  if (deck.id === 'balanced-tape') {
    return {
      id: 'balanced-hold',
      title: `Outlast ${rival.name}`,
      description: `Finish ahead of ${rival.name} (${rival.persona}) and hold a 3× or larger flag to the bell.`,
      rule: `Beat ${rival.name} · survive · risk reward ≥ 3×`,
    }
  }
  if (deck.id === 'compression-break') {
    return {
      id: 'compression-courage',
      title: `Break ${rival.name}`,
      description: `Finish ahead of ${rival.name} (${rival.persona}) and survive the back-loaded break at 4× or more.`,
      rule: `Beat ${rival.name} · survive · risk reward ≥ 4×`,
    }
  }
  if (deck.id === 'opening-rush') {
    return {
      id: 'opening-pack',
      title: `Outscope ${rival.name}`,
      description: `Finish ahead of ${rival.name} (${rival.persona}) and weather the opening into the top five.`,
      rule: `Beat ${rival.name} · finish active · rank 1–5`,
    }
  }
  return {
    id: 'pulse-airlock',
    title: `Ghost ${rival.name}`,
    description: `Finish ahead of ${rival.name} (${rival.persona}) and bank a 3× or larger Pulse escape.`,
    rule: `Beat ${rival.name} · Escape · risk reward ≥ 3×`,
  }
}

/**
 * The UTC week selects only public content. Starting the challenge still calls
 * the ordinary round launcher, which creates fresh path and bot seeds.
 */
export function weeklyChallengeFor(now = new Date()): WeeklyChallenge {
  const weekStart = utcWeekStartKey(now)
  const startMs = weekStartMs(weekStart)
  const ordinal = Math.floor((startMs - MONDAY_EPOCH_MS) / WEEK_MS)
  const deck = DECKS[safeModulo(ordinal, DECKS.length)] as DeckDefinition
  const rival = canonicalRival(deck)
  return {
    id: `strikefall-weekly:${weekStart}`,
    weekStart,
    weekEndExclusive: utcDate(startMs + WEEK_MS),
    deck,
    rankedDeckId: deck.id.replaceAll('-', '_'),
    deckVersion: deck.version,
    rival,
    mission: missionFor(deck, rival),
    pathPolicy: 'fresh-per-attempt',
    launchPolicy: 'ordinary-round',
  }
}

function weeklyChallengeDateFromId(challengeId: string | undefined): Date | null {
  const match = /^strikefall-weekly:(\d{4}-\d{2}-\d{2})$/.exec(challengeId ?? '')
  if (!match) return null
  const date = new Date(`${match[1]}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || utcDate(date.getTime()) !== match[1]) return null
  return date
}

/** Present the exact named rival that exists in the selected disclosed roster. */
export function weeklyChallengeForMode(
  challenge: WeeklyChallenge,
  mode: 'practice' | 'ranked',
): WeeklyChallenge {
  if (mode === 'practice') return challenge
  const rival: WeeklyRival = {
    ...challenge.rival,
    ...challenge.rival.rankedAlias,
  }
  return {
    ...challenge,
    rival,
    mission: missionFor(challenge.deck, rival),
  }
}

export function parseWeeklyProgress(value: string): WeeklyProgressState | null {
  try {
    const parsed = JSON.parse(value) as Partial<WeeklyProgressState>
    if (parsed.version !== WEEKLY_PROGRESS_VERSION || !Array.isArray(parsed.entries)) return null
    const seen = new Set<string>()
    const entries = parsed.entries.slice(0, MAX_WEEKLY_ENTRIES * 2).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const candidate = entry as Partial<WeeklyProgressEntry>
      if (
        typeof candidate.challengeId !== 'string'
        || !/^strikefall-weekly:\d{4}-\d{2}-\d{2}$/.test(candidate.challengeId)
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
    return { version: WEEKLY_PROGRESS_VERSION, entries: entries.slice(0, MAX_WEEKLY_ENTRIES) }
  } catch {
    return null
  }
}

export function loadWeeklyProgress(
  storage: StorageLike | null = defaultStorage(),
): WeeklyProgressState {
  if (!storage) return EMPTY_WEEKLY_PROGRESS
  try {
    const value = storage.getItem(WEEKLY_PROGRESS_STORAGE_KEY)
    return value ? parseWeeklyProgress(value) ?? EMPTY_WEEKLY_PROGRESS : EMPTY_WEEKLY_PROGRESS
  } catch {
    return EMPTY_WEEKLY_PROGRESS
  }
}

export function persistWeeklyProgress(
  progress: WeeklyProgressState,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false
  try {
    storage.setItem(WEEKLY_PROGRESS_STORAGE_KEY, JSON.stringify(progress))
    return true
  } catch {
    return false
  }
}

export function clearWeeklyProgress(
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false
  try {
    storage.removeItem(WEEKLY_PROGRESS_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

export function weeklyChallengeProgress(
  state: WeeklyProgressState,
  challenge: WeeklyChallenge,
): WeeklyChallengeProgress {
  const entry = state.entries.find((candidate) => candidate.challengeId === challenge.id)
  return {
    attempts: entry?.attempts ?? 0,
    completed: entry?.completedAt !== null && entry?.completedAt !== undefined,
    completedAt: entry?.completedAt ?? null,
  }
}

function beatWeeklyRival(challenge: WeeklyChallenge, result: ProfileRoundResult): boolean {
  if (typeof result.rank !== 'number' || !Number.isFinite(result.rank)) return false
  const opponents = result.opponents ?? []
  const identities = [challenge.rival, challenge.rival.rankedAlias]
  const named = opponents.filter((opponent) => identities.some((identity) => (
    opponent.botId === identity.botId
    || opponent.botName?.toLocaleLowerCase() === identity.name.toLocaleLowerCase()
  )))
  const hasIdentityFacts = opponents.some((opponent) => opponent.botId || opponent.botName)
  // Persona-only records are retained solely for migration from pre-identity
  // progress. New rounds always disclose and bind the exact roster identity.
  const targets = named.length > 0 || hasIdentityFacts
    ? named
    : opponents.filter((opponent) => identities.some(
        (identity) => opponent.persona === identity.persona,
      ))
  return targets.length > 0 && targets.every((opponent) => result.rank! < opponent.rank)
}

function completesDeckCondition(
  condition: WeeklyDeckConditionId,
  result: ProfileRoundResult,
): boolean {
  if (condition === 'balanced-hold') {
    return result.outcome === 'survived' && result.multiplier >= 3
  }
  if (condition === 'compression-courage') {
    return result.outcome === 'survived' && result.multiplier >= 4
  }
  if (condition === 'opening-pack') {
    return result.outcome !== 'eliminated'
      && typeof result.rank === 'number'
      && result.rank >= 1
      && result.rank <= 5
  }
  return result.outcome === 'escaped' && result.multiplier >= 3
}

export function recordWeeklyChallengeRound(
  state: WeeklyProgressState,
  result: ProfileRoundResult,
  now = new Date(),
): WeeklyProgressState {
  const challengeDate = weeklyChallengeDateFromId(result.weeklyChallengeId)
  if (!challengeDate) return state
  const challenge = weeklyChallengeFor(challengeDate)
  if (
    result.weeklyChallengeId !== challenge.id
    || result.deckId !== challenge.deck.id
  ) return state
  const previous = state.entries.find((entry) => entry.challengeId === challenge.id)
  const completed = previous?.completedAt !== null && previous?.completedAt !== undefined
  const completedNow = !completed
    && beatWeeklyRival(challenge, result)
    && completesDeckCondition(challenge.mission.id, result)
  const next: WeeklyProgressEntry = {
    challengeId: challenge.id,
    attempts: (previous?.attempts ?? 0) + 1,
    completedAt: previous?.completedAt ?? (completedNow ? now.toISOString() : null),
  }
  return {
    version: WEEKLY_PROGRESS_VERSION,
    entries: [
      next,
      ...state.entries.filter((entry) => entry.challengeId !== challenge.id),
    ]
      .sort((left, right) => right.challengeId.localeCompare(left.challengeId))
      .slice(0, MAX_WEEKLY_ENTRIES),
  }
}
