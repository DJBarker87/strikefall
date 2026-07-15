import type { DramaticMoment } from './types'

export const ESCAPE_CAPTURE_KEY = 'escape'

export function clusterWipeCaptureKey(sequence: number): string {
  return `cluster-wipe:${Math.max(0, Math.floor(sequence))}`
}

export function nearMissCaptureKey(outcome: 'late-hit'): string
export function nearMissCaptureKey(outcome: 'held', closestApproachStep: number): string
export function nearMissCaptureKey(
  outcome: 'held' | 'late-hit',
  closestApproachStep?: number,
): string {
  if (outcome === 'late-hit') return 'near-miss:late-hit'
  if (!Number.isInteger(closestApproachStep) || (closestApproachStep ?? -1) < 0) {
    throw new RangeError('Held near-miss capture requires an authoritative battle step')
  }
  return `near-miss:held:${closestApproachStep}`
}

/** Stable key shared by live candidate retention and final editorial selection. */
export function shareMomentCaptureKey(moment: DramaticMoment | null): string | null {
  if (!moment) return null
  if (moment.kind === 'cluster-wipe') return clusterWipeCaptureKey(moment.sequence)
  if (moment.kind === 'near-miss') {
    if (moment.outcome === 'late-hit') return nearMissCaptureKey('late-hit')
    return !Number.isInteger(moment.closestApproachStep)
      ? null
      : nearMissCaptureKey('held', moment.closestApproachStep as number)
  }
  if (
    moment.kind === 'escape-regret'
    || moment.kind === 'escape-save'
    || moment.kind === 'perfect-escape'
  ) return ESCAPE_CAPTURE_KEY
  return null
}

/** Clips are enabled only when the selected moment maps to an authoritative frame. */
export function shareMomentSupportsClip(moment: DramaticMoment | null): boolean {
  if (moment?.kind !== 'near-miss') return true
  return moment.outcome === 'late-hit'
    || (Number.isInteger(moment.closestApproachStep) && moment.at !== null)
}

export function shareMomentCaptureLabel(moment: DramaticMoment | null): string | null {
  if (!moment) return null
  if (moment.kind === 'cluster-wipe') return `${moment.size}-flag cluster wipe`
  if (moment.kind === 'near-miss') {
    return moment.outcome === 'late-hit' ? 'last-second touch' : 'closest approach'
  }
  if (moment.kind === 'perfect-escape') return 'perfect Escape'
  if (moment.kind === 'escape-save') return 'Escape save'
  if (moment.kind === 'escape-regret') return 'Escape decision'
  return null
}

/**
 * Maps normalized authoritative battle progress onto the recorder's monotonic
 * clock. Result phase starts immediately after battle, so its boundary is a
 * stable anchor even when the event arrived a few frames late.
 */
export function battleMomentClockTime(input: {
  phase: 'battle' | 'result'
  phaseStartedAt: number
  phaseDuration: number
  at: number
  battleDurationMs?: number
}): number {
  const at = Math.min(1, Math.max(0, input.at))
  if (input.phase === 'battle') {
    return input.phaseStartedAt + at * input.phaseDuration
  }
  const battleDuration = input.battleDurationMs ?? 60_000
  return input.phaseStartedAt - (1 - at) * battleDuration
}

/** Maps an authoritative discrete battle step onto the recorder clock. */
export function battleStepClockTime(input: {
  phaseStartedAt: number
  phaseDuration: number
  step: number
  battleSteps: number
}): number {
  const battleSteps = Math.max(1, Math.floor(input.battleSteps))
  const step = Math.min(battleSteps, Math.max(0, Math.floor(input.step)))
  return battleMomentClockTime({
    phase: 'battle',
    phaseStartedAt: input.phaseStartedAt,
    phaseDuration: input.phaseDuration,
    at: step / battleSteps,
  })
}
