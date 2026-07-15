import type { GamePhase } from '../game/types'

export const CLUSTER_CASCADE_SPACING_MS = 80

export interface ClusterHitCue {
  clusterIndex: number
  clusterSize: number
  contenderId: string
  delayMs: number
  player: boolean
}

/**
 * Builds the short, deterministic rhythm used when a signed cluster event lands.
 * IDs are de-duplicated defensively because every contender should receive one
 * impact, even if a malformed/replayed event repeats an ID.
 */
export function createClusterHitCues(
  contenderIds: readonly string[],
  spacingMs = CLUSTER_CASCADE_SPACING_MS,
): ClusterHitCue[] {
  const ids = [...new Set(contenderIds)]
  const safeSpacing = Math.min(100, Math.max(60, Math.round(spacingMs)))
  return ids.map((contenderId, clusterIndex) => ({
    clusterIndex,
    clusterSize: ids.length,
    contenderId,
    delayMs: clusterIndex * safeSpacing,
    player: contenderId === 'player',
  }))
}

/** The audible battle count spans 10..1; setup phases keep their quieter 3..1 cue. */
export function countdownCueSecond(
  phase: GamePhase,
  timeRemainingMs: number,
): number | null {
  if (!Number.isFinite(timeRemainingMs) || timeRemainingMs <= 0) return null
  const seconds = Math.ceil(timeRemainingMs / 1_000)
  const maximum = phase === 'battle'
    ? 10
    : phase === 'placement' || phase === 'lock'
      ? 3
      : 0
  return seconds <= maximum ? seconds : null
}

/**
 * Screen readers get the important bookends without ten consecutive live-region
 * interruptions. The visible clock and canvas still show every second.
 */
export function countdownAnnouncement(
  phase: GamePhase,
  timeRemainingMs: number,
): string {
  if (phase !== 'battle') return ''
  const seconds = countdownCueSecond(phase, timeRemainingMs)
  if (seconds === 10) return 'Final ten seconds.'
  if (seconds !== null && seconds <= 3) return `${seconds} second${seconds === 1 ? '' : 's'} remaining.`
  return ''
}
