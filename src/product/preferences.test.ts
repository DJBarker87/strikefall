import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  loadPreferences,
  parsePreferences,
  savePreferences,
  shouldReduceMotion,
  shouldShowBreakReminder,
} from './preferences'

describe('privacy and accessibility preferences', () => {
  it('defaults analytics to local-only and respects system motion', () => {
    expect(DEFAULT_PREFERENCES.telemetry).toBe('local')
    expect(shouldReduceMotion('system', true)).toBe(true)
    expect(shouldReduceMotion('system', false)).toBe(false)
    expect(shouldReduceMotion('reduced', false)).toBe(true)
    expect(shouldReduceMotion('full', true)).toBe(false)
  })

  it('repairs malformed persisted settings', () => {
    expect(parsePreferences(JSON.stringify({
      version: 1,
      motion: 'warp-speed',
      telemetry: 'sell-everything',
      breakReminderRounds: 999,
      mutedFlash: 'yes',
    }))).toEqual({
      ...DEFAULT_PREFERENCES,
      breakReminderRounds: 20,
    })
    expect(parsePreferences('{')).toBeNull()
    expect(parsePreferences('{"version":2}')).toBeNull()
  })

  it('loads and saves without making storage a gameplay dependency', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const preferences = { ...DEFAULT_PREFERENCES, telemetry: 'shared' as const, mutedFlash: true }
    expect(savePreferences(preferences, storage)).toBe(true)
    expect(values.has(PREFERENCES_STORAGE_KEY)).toBe(true)
    expect(loadPreferences(storage)).toEqual(preferences)
    expect(loadPreferences({ getItem: () => { throw new Error('blocked') } })).toEqual(DEFAULT_PREFERENCES)
  })

  it('offers non-coercive periodic break reminders', () => {
    expect(shouldShowBreakReminder(DEFAULT_PREFERENCES, 4)).toBe(false)
    expect(shouldShowBreakReminder(DEFAULT_PREFERENCES, 5)).toBe(true)
    expect(shouldShowBreakReminder({ ...DEFAULT_PREFERENCES, breakReminderRounds: 0 }, 5)).toBe(false)
  })
})
