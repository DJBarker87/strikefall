import { describe, expect, it } from 'vitest'
import { createAnonymousProfile, recordProfileRound, type ProfileRoundResult, type StorageLike } from './profile'
import {
  DAILY_MISSIONS,
  DAILY_PROGRESS_STORAGE_KEY,
  EMPTY_DAILY_PROGRESS,
  challengeProgress,
  clearDailyProgress,
  dailyChallengeFor,
  deriveDeckMastery,
  loadDailyProgress,
  masteryForDeck,
  parseDailyProgress,
  persistDailyProgress,
  recordDailyChallengeRound,
} from './progression'

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

function dateForMission(id: (typeof DAILY_MISSIONS)[number]['id']) {
  for (let day = 0; day < 30; day += 1) {
    const now = new Date(Date.UTC(2026, 6, 1 + day, 12))
    if (dailyChallengeFor(now).mission.id === id) return now
  }
  throw new Error(`No fixture date found for ${id}`)
}

function resultFor(now: Date, update: Partial<ProfileRoundResult> = {}): ProfileRoundResult {
  return {
    deckId: dailyChallengeFor(now).deck.id,
    dailyChallengeId: dailyChallengeFor(now).id,
    outcome: 'survived',
    score: 500,
    multiplier: 5,
    ...update,
  }
}

describe('Daily Deck progression', () => {
  it('uses UTC identity, rotates content, and never exposes a reusable path seed', () => {
    const beforeMidnight = dailyChallengeFor(new Date('2026-07-15T16:59:59-07:00'))
    const sameUtcDay = dailyChallengeFor(new Date('2026-07-15T23:59:59Z'))
    const nextUtcDay = dailyChallengeFor(new Date('2026-07-16T00:00:01Z'))

    expect(beforeMidnight.id).toBe(sameUtcDay.id)
    expect(beforeMidnight.deck.id).toBe(sameUtcDay.deck.id)
    expect(nextUtcDay.id).not.toBe(beforeMidnight.id)
    expect(nextUtcDay.deck.id).not.toBe(beforeMidnight.deck.id)
    expect(beforeMidnight.pathPolicy).toBe('fresh-per-attempt')
    expect(beforeMidnight.rankedDeckId).toBe(beforeMidnight.deck.id.replaceAll('-', '_'))
    expect(beforeMidnight.deckVersion).toBe(3)
    expect(beforeMidnight).not.toHaveProperty('seed')
    expect(beforeMidnight).not.toHaveProperty('path')
  })

  it('records only featured-deck attempts and clears the high-risk hold mission', () => {
    const now = dateForMission('high-risk-hold')
    const challenge = dailyChallengeFor(now)
    const ignored = recordDailyChallengeRound(EMPTY_DAILY_PROGRESS, {
      ...resultFor(now),
      deckId: challenge.deck.id === 'pulse' ? 'balanced-tape' : 'pulse',
    }, now)
    expect(ignored).toBe(EMPTY_DAILY_PROGRESS)

    const ordinaryQuickRun = recordDailyChallengeRound(ignored, {
      ...resultFor(now),
      dailyChallengeId: undefined,
    }, now)
    expect(ordinaryQuickRun).toBe(EMPTY_DAILY_PROGRESS)

    const miss = recordDailyChallengeRound(ignored, resultFor(now, {
      outcome: 'escaped',
      multiplier: 8,
    }), now)
    expect(challengeProgress(miss, challenge)).toEqual({
      attempts: 1,
      completed: false,
      completedAt: null,
    })

    const cleared = recordDailyChallengeRound(miss, resultFor(now), now)
    expect(challengeProgress(cleared, challenge)).toMatchObject({
      attempts: 2,
      completed: true,
      completedAt: now.toISOString(),
    })
    const replayed = recordDailyChallengeRound(cleared, resultFor(now, { multiplier: 1 }), new Date(now.getTime() + 500))
    expect(challengeProgress(replayed, challenge)).toMatchObject({
      attempts: 3,
      completed: true,
      completedAt: now.toISOString(),
    })
  })

  it('attributes a Daily attempt to its launch identity when the round crosses UTC midnight', () => {
    const launchedAt = new Date('2026-07-15T23:59:50.000Z')
    const completedAt = new Date('2026-07-16T00:00:20.000Z')
    const launchedChallenge = dailyChallengeFor(launchedAt)
    const currentChallenge = dailyChallengeFor(completedAt)

    const state = recordDailyChallengeRound(
      EMPTY_DAILY_PROGRESS,
      resultFor(launchedAt),
      completedAt,
    )

    expect(challengeProgress(state, launchedChallenge).attempts).toBe(1)
    expect(challengeProgress(state, currentChallenge).attempts).toBe(0)
  })

  it('requires an actual sub-second counterfactual hit for the Escape mission', () => {
    const now = dateForMission('perfect-escape')
    const miss = recordDailyChallengeRound(EMPTY_DAILY_PROGRESS, resultFor(now, {
      outcome: 'escaped',
      escapeLeadSeconds: 1.01,
    }), now)
    expect(challengeProgress(miss, dailyChallengeFor(now)).completed).toBe(false)

    const cleared = recordDailyChallengeRound(miss, resultFor(now, {
      outcome: 'escaped',
      escapeLeadSeconds: 0.72,
    }), now)
    expect(challengeProgress(cleared, dailyChallengeFor(now))).toMatchObject({
      attempts: 2,
      completed: true,
    })
  })

  it('requires the player to finish ahead of every disclosed Sniper', () => {
    const now = dateForMission('sniper-sweep')
    const miss = recordDailyChallengeRound(EMPTY_DAILY_PROGRESS, resultFor(now, {
      rank: 4,
      opponents: [
        { persona: 'Sniper', rank: 3 },
        { persona: 'Sniper', rank: 8 },
      ],
    }), now)
    expect(challengeProgress(miss, dailyChallengeFor(now)).completed).toBe(false)

    const cleared = recordDailyChallengeRound(miss, resultFor(now, {
      rank: 2,
      opponents: [
        { persona: 'Sniper', rank: 3 },
        { persona: 'Sniper', rank: 8 },
        { persona: 'Turtle', rank: 1 },
      ],
    }), now)
    expect(challengeProgress(cleared, dailyChallengeFor(now))).toMatchObject({
      attempts: 2,
      completed: true,
    })
  })

  it('bounds, repairs, persists, and clears the local daily history', () => {
    const entries = Array.from({ length: 18 }, (_, index) => ({
      challengeId: `strikefall-daily:2026-07-${String(index + 1).padStart(2, '0')}`,
      attempts: index === 0 ? -4 : index,
      completedAt: index % 2 === 0 ? 'bad-date' : '2026-07-01T12:00:00Z',
    }))
    const parsed = parseDailyProgress(JSON.stringify({
      version: 1,
      entries: [entries[0], entries[0], { nope: true }, ...entries.slice(1)],
    }))
    expect(parsed?.entries.length).toBeLessThanOrEqual(14)
    expect(parsed?.entries.at(-1)?.attempts).toBeGreaterThanOrEqual(0)
    expect(parsed?.entries.every((entry) => entry.completedAt === null || entry.completedAt.endsWith('Z'))).toBe(true)
    expect(parseDailyProgress('{')).toBeNull()

    const storage = new MemoryStorage()
    expect(persistDailyProgress(parsed!, storage)).toBe(true)
    expect(storage.getItem(DAILY_PROGRESS_STORAGE_KEY)).not.toBeNull()
    expect(loadDailyProgress(storage)).toEqual(parsed)
    expect(clearDailyProgress(storage)).toBe(true)
    expect(loadDailyProgress(storage)).toEqual(EMPTY_DAILY_PROGRESS)
  })
})

describe('deck mastery and cosmetics', () => {
  it('derives all four decks, tiers, progress, and non-competitive unlocks', () => {
    let profile = createAnonymousProfile({
      now: new Date('2026-07-15T12:00:00Z'),
      entropy: Uint8Array.from([0, 1, 2, 3, 4, 5]),
    })
    profile = recordProfileRound(profile, {
      deckId: 'pulse',
      outcome: 'survived',
      score: 520,
      multiplier: 5.2,
    })

    const mastery = deriveDeckMastery(profile)
    expect(mastery).toHaveLength(4)
    expect(mastery.map((entry) => entry.deck.id)).toEqual([
      'balanced-tape',
      'compression-break',
      'opening-rush',
      'pulse',
    ])
    expect(masteryForDeck(profile, 'unknown')).toBeNull()
    expect(masteryForDeck(profile, 'balanced-tape')).toMatchObject({
      xp: 0,
      tier: { level: 0, name: 'Unplayed' },
      unlocked: [],
      nextUnlock: { name: 'Signal pennant', kind: 'flag', level: 1 },
    })
    expect(masteryForDeck(profile, 'pulse')).toMatchObject({
      tier: { level: 1, name: 'Scout' },
      rounds: 1,
      held: 1,
      bestScore: 520,
    })
    expect(masteryForDeck(profile, 'pulse')?.unlocked.map((unlock) => unlock.kind)).toEqual([
      'flag',
    ])
  })
})
