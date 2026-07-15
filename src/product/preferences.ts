export const PREFERENCES_STORAGE_KEY = 'strikefall.preferences.v1'

export type MotionPreference = 'system' | 'reduced' | 'full'
export type TelemetryPreference = 'off' | 'local' | 'shared'
export type ChartStylePreference = 'candles' | 'line'

export interface StrikefallPreferences {
  version: 1
  motion: MotionPreference
  mutedFlash: boolean
  telemetry: TelemetryPreference
  breakReminderRounds: number
  onboardingComplete: boolean
  chartStyle: ChartStylePreference
}

export const DEFAULT_PREFERENCES: StrikefallPreferences = {
  version: 1,
  motion: 'system',
  mutedFlash: false,
  telemetry: 'local',
  breakReminderRounds: 5,
  onboardingComplete: false,
  chartStyle: 'candles',
}

export function parsePreferences(value: string): StrikefallPreferences | null {
  try {
    const parsed = JSON.parse(value) as Partial<StrikefallPreferences>
    if (parsed.version !== 1) return null
    const motion = parsed.motion === 'reduced' || parsed.motion === 'full' || parsed.motion === 'system'
      ? parsed.motion
      : DEFAULT_PREFERENCES.motion
    const telemetry = parsed.telemetry === 'off' || parsed.telemetry === 'local' || parsed.telemetry === 'shared'
      ? parsed.telemetry
      : DEFAULT_PREFERENCES.telemetry
    const breakReminderRounds = Number.isInteger(parsed.breakReminderRounds)
      ? Math.max(0, Math.min(20, parsed.breakReminderRounds as number))
      : DEFAULT_PREFERENCES.breakReminderRounds
    return {
      version: 1,
      motion,
      mutedFlash: typeof parsed.mutedFlash === 'boolean'
        ? parsed.mutedFlash
        : DEFAULT_PREFERENCES.mutedFlash,
      telemetry,
      breakReminderRounds,
      onboardingComplete: Boolean(parsed.onboardingComplete),
      chartStyle: parsed.chartStyle === 'line' || parsed.chartStyle === 'candles'
        ? parsed.chartStyle
        : DEFAULT_PREFERENCES.chartStyle,
    }
  } catch {
    return null
  }
}

export function loadPreferences(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
) {
  try {
    const value = storage?.getItem(PREFERENCES_STORAGE_KEY)
    return value ? parsePreferences(value) ?? DEFAULT_PREFERENCES : DEFAULT_PREFERENCES
  } catch {
    return DEFAULT_PREFERENCES
  }
}

export function savePreferences(
  preferences: StrikefallPreferences,
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
) {
  try {
    storage?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
    return storage !== null
  } catch {
    return false
  }
}

export function shouldReduceMotion(
  preference: MotionPreference,
  systemReduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
) {
  if (preference === 'reduced') return true
  if (preference === 'full') return false
  return systemReduced
}

export function shouldShowBreakReminder(preferences: StrikefallPreferences, completedRounds: number) {
  return preferences.breakReminderRounds > 0 &&
    completedRounds > 0 &&
    completedRounds % preferences.breakReminderRounds === 0
}
