import { useCallback, useEffect, useMemo, useState } from 'react'
import { clearLocalTelemetry } from '../telemetry'
import {
  EXPERIMENT_STORAGE_KEY,
  experimentVariant,
  loadExperimentEnvelope,
  type ExperimentEnvelope,
} from './experiments'
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  loadPreferences,
  savePreferences,
  shouldReduceMotion,
  type StrikefallPreferences,
} from './preferences'
import {
  clearProfile,
  createAnonymousProfile,
  loadOrCreateProfile,
  persistProfile,
  recordProfileRound,
  renameProfile,
  type ProfileRoundResult,
  type StrikefallProfile,
} from './profile'
import {
  DAILY_PROGRESS_STORAGE_KEY,
  challengeProgress,
  clearDailyProgress,
  dailyChallengeFor,
  deriveDeckMastery,
  loadDailyProgress,
  persistDailyProgress,
  recordDailyChallengeRound,
  type DailyChallenge,
  type DailyChallengeProgress,
  type DailyProgressState,
  type DeckMastery,
} from './progression'
import {
  WEEKLY_PROGRESS_STORAGE_KEY,
  clearWeeklyProgress,
  loadWeeklyProgress,
  persistWeeklyProgress,
  recordWeeklyChallengeRound,
  weeklyChallengeFor,
  weeklyChallengeProgress,
  type WeeklyChallenge,
  type WeeklyChallengeProgress,
  type WeeklyProgressState,
} from './weeklyChallenge'

const UTC_DAY_MS = 86_400_000

type ChallengeClockTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

export interface UtcChallengeClockOptions {
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => number
  cancel?: (timer: number) => void
  focusTarget?: ChallengeClockTarget | null
  visibilityTarget?: ChallengeClockTarget | null
  isVisible?: () => boolean
}

/** Delay to the next UTC date boundary, independent of the browser time zone. */
export function millisecondsUntilNextUtcDay(nowMs: number): number {
  if (!Number.isFinite(nowMs)) throw new RangeError('Challenge clock time is invalid')
  const now = new Date(nowMs)
  if (!Number.isFinite(now.getTime())) throw new RangeError('Challenge clock time is invalid')
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  )
  return Math.max(1, Math.min(UTC_DAY_MS, nextMidnight - nowMs))
}

/**
 * Keeps date-bound product content current even when background-tab throttling
 * delays the midnight timer. Daily midnight also covers the Monday Weekly
 * boundary; focus and visible-tab recovery immediately reconcile missed ticks.
 */
export function subscribeUtcChallengeClock(
  onRefresh: (nowMs: number) => void,
  options: UtcChallengeClockOptions = {},
): () => void {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs))
  const cancel = options.cancel ?? ((timer) => window.clearTimeout(timer))
  const focusTarget = options.focusTarget === undefined
    ? (typeof window === 'undefined' ? null : window)
    : options.focusTarget
  const visibilityTarget = options.visibilityTarget === undefined
    ? (typeof document === 'undefined' ? null : document)
    : options.visibilityTarget
  const isVisible = options.isVisible ?? (() => (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
  ))
  let timer: number | null = null
  let disposed = false

  const arm = (referenceNow = now()): void => {
    if (disposed) return
    if (timer !== null) cancel(timer)
    timer = schedule(boundaryRefresh, millisecondsUntilNextUtcDay(referenceNow))
  }
  const refresh = (): void => {
    if (disposed) return
    const refreshedAt = now()
    onRefresh(refreshedAt)
    arm(refreshedAt)
  }
  const boundaryRefresh = (): void => {
    timer = null
    refresh()
  }
  const recoverVisible = () => {
    if (isVisible()) refresh()
  }

  focusTarget?.addEventListener('focus', refresh)
  visibilityTarget?.addEventListener('visibilitychange', recoverVisible)
  arm()

  return () => {
    disposed = true
    if (timer !== null) cancel(timer)
    timer = null
    focusTarget?.removeEventListener('focus', refresh)
    visibilityTarget?.removeEventListener('visibilitychange', recoverVisible)
  }
}

export interface StrikefallProductState {
  profile: StrikefallProfile
  dailyChallenge: DailyChallenge
  dailyProgress: DailyChallengeProgress
  dailyProgressState: DailyProgressState
  weeklyChallenge: WeeklyChallenge
  weeklyProgress: WeeklyChallengeProgress
  weeklyProgressState: WeeklyProgressState
  deckMastery: DeckMastery[]
  preferences: StrikefallPreferences
  experiments: ExperimentEnvelope
  reducedMotion: boolean
  updatePreferences: (
    update: Partial<StrikefallPreferences> | ((current: StrikefallPreferences) => StrikefallPreferences),
  ) => void
  recordRound: (result: ProfileRoundResult) => void
  setCallsign: (handle: string) => void
  resetLocalData: () => void
  variant: (experimentId: string) => string | null
}

export function useStrikefallProductState(): StrikefallProductState {
  const [profile, setProfile] = useState<StrikefallProfile>(() => loadOrCreateProfile())
  const [dailyProgressState, setDailyProgressState] = useState<DailyProgressState>(
    () => loadDailyProgress(),
  )
  const [weeklyProgressState, setWeeklyProgressState] = useState<WeeklyProgressState>(
    () => loadWeeklyProgress(),
  )
  const [preferences, setPreferences] = useState<StrikefallPreferences>(() => loadPreferences())
  const [systemReducedMotion, setSystemReducedMotion] = useState(() =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [challengeClock, setChallengeClock] = useState(Date.now)
  const experiments = useMemo(
    () => loadExperimentEnvelope(profile.id),
    [profile.id],
  )
  const dailyChallenge = useMemo(
    () => dailyChallengeFor(new Date(challengeClock)),
    [challengeClock],
  )
  const dailyProgress = challengeProgress(dailyProgressState, dailyChallenge)
  const weeklyChallenge = useMemo(
    () => weeklyChallengeFor(new Date(challengeClock)),
    [challengeClock],
  )
  const weeklyProgress = weeklyChallengeProgress(weeklyProgressState, weeklyChallenge)
  const deckMastery = useMemo(() => deriveDeckMastery(profile), [profile])

  useEffect(() => subscribeUtcChallengeClock(setChallengeClock), [])

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setSystemReducedMotion(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  const updatePreferences = useCallback<StrikefallProductState['updatePreferences']>((update) => {
    setPreferences((current) => {
      const next = typeof update === 'function'
        ? update(current)
        : { ...current, ...update, version: 1 as const }
      savePreferences(next)
      if (next.telemetry === 'off' && current.telemetry !== 'off') clearLocalTelemetry()
      return next
    })
  }, [])

  const recordRound = useCallback((result: ProfileRoundResult) => {
    setProfile((current) => {
      const next = recordProfileRound(current, result)
      persistProfile(next)
      return next
    })
    setDailyProgressState((current) => {
      const next = recordDailyChallengeRound(current, result)
      if (next !== current) persistDailyProgress(next)
      return next
    })
    setWeeklyProgressState((current) => {
      const next = recordWeeklyChallengeRound(current, result)
      if (next !== current) persistWeeklyProgress(next)
      return next
    })
  }, [])

  const setCallsign = useCallback((handle: string) => {
    setProfile((current) => {
      const next = renameProfile(current, handle)
      persistProfile(next)
      return next
    })
  }, [])

  const resetLocalData = useCallback(() => {
    clearLocalTelemetry()
    clearProfile()
    clearDailyProgress()
    clearWeeklyProgress()
    try {
      localStorage.removeItem(PREFERENCES_STORAGE_KEY)
      localStorage.removeItem(EXPERIMENT_STORAGE_KEY)
      localStorage.removeItem(DAILY_PROGRESS_STORAGE_KEY)
      localStorage.removeItem(WEEKLY_PROGRESS_STORAGE_KEY)
    } catch {
      // State still resets when storage is unavailable.
    }
    const nextProfile = createAnonymousProfile()
    persistProfile(nextProfile)
    setProfile(nextProfile)
    setDailyProgressState(loadDailyProgress())
    setWeeklyProgressState(loadWeeklyProgress())
    setPreferences(DEFAULT_PREFERENCES)
  }, [])

  const variant = useCallback(
    (experimentId: string) => experimentVariant(experiments, experimentId),
    [experiments],
  )

  return {
    profile,
    dailyChallenge,
    dailyProgress,
    dailyProgressState,
    weeklyChallenge,
    weeklyProgress,
    weeklyProgressState,
    deckMastery,
    preferences,
    experiments,
    reducedMotion: shouldReduceMotion(preferences.motion, systemReducedMotion),
    updatePreferences,
    recordRound,
    setCallsign,
    resetLocalData,
    variant,
  }
}
