import { describe, expect, it } from 'vitest'
import {
  PROFILE_STORAGE_KEY,
  clearProfile,
  createAnonymousProfile,
  loadOrCreateProfile,
  parseProfile,
  persistProfile,
  recordProfileRound,
  renameProfile,
  type StorageLike,
} from './profile'

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

const NOW = new Date('2026-07-14T12:00:00.000Z')
const ENTROPY = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

describe('anonymous player profile', () => {
  it('creates and restores a stable non-wallet identity', () => {
    const storage = new MemoryStorage()
    const created = loadOrCreateProfile(storage, { now: NOW, entropy: ENTROPY })
    expect(created.id).toBe('anon_000102030405060708090a0b')
    expect(created.handle).toBe('Striker-0A0B')
    expect(loadOrCreateProfile(storage)).toEqual(created)
  })

  it('records survival, Escape, elimination, deck records, and rivalry', () => {
    const initial = createAnonymousProfile({ now: NOW, entropy: ENTROPY })
    const survived = recordProfileRound(initial, {
      deckId: 'compression-break',
      outcome: 'survived',
      score: 420,
      multiplier: 4.2,
      rival: { botId: 'turtle', botName: 'Turtle.exe', playerWon: true, copiedPlayer: true },
    }, NOW)
    const escaped = recordProfileRound(survived, {
      deckId: 'compression-break',
      outcome: 'escaped',
      score: 180,
      multiplier: 4.2,
      rival: { botId: 'turtle', botName: 'Turtle.exe', playerWon: false },
    }, NOW)
    const eliminated = recordProfileRound(escaped, {
      deckId: 'opening-bell',
      outcome: 'eliminated',
      score: 0,
      multiplier: 7.5,
    }, NOW)

    expect(eliminated).toMatchObject({
      rounds: 3,
      survived: 1,
      escaped: 1,
      eliminated: 1,
      currentStreak: 0,
      bestStreak: 2,
      totalScore: 600,
      bestScore: 420,
      bestMultiplier: 7.5,
    })
    expect(eliminated.deckRecords[0]).toMatchObject({ deckId: 'opening-bell', rounds: 1 })
    expect(eliminated.deckRecords[1]).toMatchObject({
      deckId: 'compression-break',
      rounds: 2,
      survived: 1,
      escaped: 1,
    })
    expect(eliminated.rivals[0]).toMatchObject({ wins: 1, losses: 1, copyEncounters: 1 })
  })

  it('renames safely and rejects empty callsigns', () => {
    const profile = createAnonymousProfile({ now: NOW, entropy: ENTROPY })
    expect(renameProfile(profile, '  Wick   Runner  ', NOW).handle).toBe('Wick Runner')
    expect(() => renameProfile(profile, ' ', NOW)).toThrow(RangeError)
  })

  it('repairs malformed counters and rejects unrecognized profiles', () => {
    const profile = createAnonymousProfile({ now: NOW, entropy: ENTROPY })
    const repaired = parseProfile(JSON.stringify({
      ...profile,
      rounds: 2.4,
      survived: 99,
      escaped: 99,
      eliminated: -4,
      totalScore: Number.NaN,
      deckRecords: [null, { deckId: '', rounds: 3 }],
    }))
    expect(repaired).toMatchObject({ rounds: 2, survived: 2, escaped: 0, eliminated: 0, totalScore: 0 })
    expect(repaired?.deckRecords).toEqual([])
    expect(parseProfile('{')).toBeNull()
    expect(parseProfile(JSON.stringify({ ...profile, version: 2 }))).toBeNull()
  })

  it('migrates pre-copy rivalry records without changing the v1 storage contract', () => {
    const profile = createAnonymousProfile({ now: NOW, entropy: ENTROPY })
    const restored = parseProfile(JSON.stringify({
      ...profile,
      rivals: [{
        botId: 'mirror',
        botName: 'Mirror',
        wins: 2,
        losses: 1,
        lastMetAt: NOW.toISOString(),
      }],
    }))
    expect(restored?.version).toBe(1)
    expect(restored?.rivals[0]).toMatchObject({
      botId: 'mirror',
      wins: 2,
      losses: 1,
      copyEncounters: 0,
    })
  })

  it('persists and clears without coupling the game to storage availability', () => {
    const storage = new MemoryStorage()
    const profile = createAnonymousProfile({ now: NOW, entropy: ENTROPY })
    expect(persistProfile(profile, storage)).toBe(true)
    expect(storage.getItem(PROFILE_STORAGE_KEY)).not.toBeNull()
    expect(clearProfile(storage)).toBe(true)
    expect(storage.getItem(PROFILE_STORAGE_KEY)).toBeNull()

    const unavailable: StorageLike = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    }
    expect(loadOrCreateProfile(unavailable, { now: NOW, entropy: ENTROPY }).id).toBe(profile.id)
    expect(persistProfile(profile, unavailable)).toBe(false)
    expect(clearProfile(unavailable)).toBe(false)
  })
})
