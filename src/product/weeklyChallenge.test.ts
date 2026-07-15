import { describe, expect, it } from 'vitest'
import type { ProfileRoundResult, StorageLike } from './profile'
import {
  EMPTY_WEEKLY_PROGRESS,
  WEEKLY_PROGRESS_STORAGE_KEY,
  clearWeeklyProgress,
  loadWeeklyProgress,
  parseWeeklyProgress,
  persistWeeklyProgress,
  recordWeeklyChallengeRound,
  utcWeekStartKey,
  weeklyChallengeFor,
  weeklyChallengeForMode,
  weeklyChallengeProgress,
  type WeeklyChallenge,
} from './weeklyChallenge'

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

function winningResult(challenge: WeeklyChallenge): ProfileRoundResult {
  return {
    deckId: challenge.deck.id,
    weeklyChallengeId: challenge.id,
    outcome: challenge.mission.id === 'pulse-airlock' ? 'escaped' : 'survived',
    score: 500,
    multiplier: 5,
    rank: 1,
    opponents: [{
      botId: challenge.rival.botId,
      botName: challenge.rival.name,
      persona: challenge.rival.persona,
      rank: 2,
    }],
  }
}

describe('weekly live-ops challenge', () => {
  it('uses a Monday UTC identity across local offsets and rolls over exactly at UTC week start', () => {
    const sunday = new Date('2026-07-19T16:59:59-07:00')
    const sameUtcWeek = new Date('2026-07-19T23:59:59Z')
    const monday = new Date('2026-07-20T00:00:00Z')

    expect(utcWeekStartKey(sunday)).toBe('2026-07-13')
    expect(weeklyChallengeFor(sunday).id).toBe(weeklyChallengeFor(sameUtcWeek).id)
    expect(weeklyChallengeFor(monday).id).not.toBe(weeklyChallengeFor(sunday).id)
    expect(weeklyChallengeFor(sunday).weekEndExclusive).toBe('2026-07-20')
  })

  it('rotates all four active v3 decks and stable canonical named rivals over four weeks', () => {
    const challenges = Array.from({ length: 4 }, (_, week) => (
      weeklyChallengeFor(new Date(Date.UTC(2026, 6, 13 + week * 7, 12)))
    ))
    expect(new Set(challenges.map((challenge) => challenge.deck.id))).toEqual(new Set([
      'balanced-tape',
      'compression-break',
      'opening-rush',
      'pulse',
    ]))
    expect(new Set(challenges.map((challenge) => challenge.rival.botId))).toEqual(new Set([
      'turtle-exe',
      'greedlord',
      'wickhunter',
      'echo',
    ]))
    expect(challenges.every((challenge) => challenge.deck.version === 3)).toBe(true)
    expect(challenges.every((challenge) => challenge.deckVersion === 3)).toBe(true)
    expect(challenges.every((challenge) => challenge.pathPolicy === 'fresh-per-attempt')).toBe(true)
    expect(challenges.every((challenge) => challenge.launchPolicy === 'ordinary-round')).toBe(true)
    expect(challenges.every((challenge) => !('seed' in challenge) && !('path' in challenge))).toBe(true)
  })

  it('presents and binds one exact named rival in each Practice and Ranked roster', () => {
    const now = new Date('2026-07-15T12:00:00Z')
    const practice = weeklyChallengeFor(now)
    const ranked = weeklyChallengeForMode(practice, 'ranked')
    expect(ranked.rival).toMatchObject(practice.rival.rankedAlias)
    expect(ranked.mission.title).toContain(ranked.rival.name)

    const result = winningResult(ranked)
    const state = recordWeeklyChallengeRound(EMPTY_WEEKLY_PROGRESS, result, now)
    expect(weeklyChallengeProgress(state, practice).completed).toBe(true)

    const wrongNamedBot = recordWeeklyChallengeRound(EMPTY_WEEKLY_PROGRESS, {
      ...result,
      opponents: [{
        botId: 'bot-16',
        botName: 'Echo Vector',
        persona: ranked.rival.persona,
        rank: 2,
      }],
    }, now)
    expect(weeklyChallengeProgress(wrongNamedBot, practice).completed).toBe(false)
  })

  it('requires the launch identity, featured deck, named rival win, and measurable deck condition', () => {
    const now = new Date('2026-07-15T12:00:00Z')
    const challenge = weeklyChallengeFor(now)
    const winning = winningResult(challenge)

    expect(recordWeeklyChallengeRound(EMPTY_WEEKLY_PROGRESS, {
      ...winning,
      weeklyChallengeId: undefined,
    }, now)).toBe(EMPTY_WEEKLY_PROGRESS)
    expect(recordWeeklyChallengeRound(EMPTY_WEEKLY_PROGRESS, {
      ...winning,
      deckId: challenge.deck.id === 'pulse' ? 'balanced-tape' : 'pulse',
    }, now)).toBe(EMPTY_WEEKLY_PROGRESS)

    const lostRivalry = recordWeeklyChallengeRound(EMPTY_WEEKLY_PROGRESS, {
      ...winning,
      rank: 3,
    }, now)
    expect(weeklyChallengeProgress(lostRivalry, challenge)).toEqual({
      attempts: 1,
      completed: false,
      completedAt: null,
    })

    const missedCondition = recordWeeklyChallengeRound(lostRivalry, {
      ...winning,
      outcome: 'eliminated',
      multiplier: 1,
    }, now)
    expect(weeklyChallengeProgress(missedCondition, challenge).completed).toBe(false)

    const cleared = recordWeeklyChallengeRound(missedCondition, winning, now)
    expect(weeklyChallengeProgress(cleared, challenge)).toEqual({
      attempts: 3,
      completed: true,
      completedAt: now.toISOString(),
    })
    const replayed = recordWeeklyChallengeRound(cleared, winning, new Date(now.getTime() + 1_000))
    expect(weeklyChallengeProgress(replayed, challenge)).toMatchObject({
      attempts: 4,
      completed: true,
      completedAt: now.toISOString(),
    })
  })

  it('attributes a Weekly attempt to its launch identity when the round crosses Monday UTC', () => {
    const launchedAt = new Date('2026-07-19T23:59:50.000Z')
    const completedAt = new Date('2026-07-20T00:00:20.000Z')
    const launchedChallenge = weeklyChallengeFor(launchedAt)
    const currentChallenge = weeklyChallengeFor(completedAt)

    const state = recordWeeklyChallengeRound(
      EMPTY_WEEKLY_PROGRESS,
      winningResult(launchedChallenge),
      completedAt,
    )

    expect(weeklyChallengeProgress(state, launchedChallenge).attempts).toBe(1)
    expect(weeklyChallengeProgress(state, currentChallenge).attempts).toBe(0)
  })

  it('keeps a persona-only fallback for legacy progress records without identity facts', () => {
    const now = new Date('2026-07-15T12:00:00Z')
    const challenge = weeklyChallengeFor(now)
    const result = winningResult(challenge)
    const state = recordWeeklyChallengeRound(EMPTY_WEEKLY_PROGRESS, {
      ...result,
      opponents: [
        { persona: challenge.rival.persona, rank: 2 },
        { persona: challenge.rival.persona, rank: 8 },
      ],
    }, now)
    expect(weeklyChallengeProgress(state, challenge).completed).toBe(true)
  })

  it('repairs, bounds, persists, and clears versioned weekly progress safely', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      challengeId: `strikefall-weekly:2026-${String(index + 1).padStart(2, '0')}-01`,
      attempts: index === 0 ? -5 : index,
      completedAt: index % 2 ? '2026-07-15T12:00:00Z' : 'not-a-date',
    }))
    const parsed = parseWeeklyProgress(JSON.stringify({
      version: 1,
      entries: [entries[0], entries[0], null, ...entries.slice(1)],
    }))
    expect(parsed?.entries.length).toBeLessThanOrEqual(16)
    expect(parsed?.entries.every((entry) => entry.attempts >= 0)).toBe(true)
    expect(parsed?.entries.every((entry) => entry.completedAt === null || entry.completedAt.endsWith('Z'))).toBe(true)
    expect(parseWeeklyProgress('{')).toBeNull()
    expect(parseWeeklyProgress(JSON.stringify({ version: 0, entries: [] }))).toBeNull()

    const storage = new MemoryStorage()
    expect(persistWeeklyProgress(parsed!, storage)).toBe(true)
    expect(storage.getItem(WEEKLY_PROGRESS_STORAGE_KEY)).not.toBeNull()
    expect(loadWeeklyProgress(storage)).toEqual(parsed)
    expect(clearWeeklyProgress(storage)).toBe(true)
    expect(loadWeeklyProgress(storage)).toEqual(EMPTY_WEEKLY_PROGRESS)
  })
})
