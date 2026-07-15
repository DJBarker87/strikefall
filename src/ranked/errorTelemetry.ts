import { reportClientError } from '../runtimeErrors'
import { RankedClientError } from './errors'

const REPLAY_MISMATCH_CODES: ReadonlySet<RankedClientError['code']> = new Set([
  'protocol_mismatch',
  'verification_failed',
])

/**
 * Emits only the bounded fact that ranked replay verification failed. The
 * error object is used solely as an in-memory dedupe identity; its message,
 * stack, check name, round id, and replay data never enter telemetry.
 */
export function reportRankedReplayVerificationFailure(error: unknown): boolean {
  if (!(error instanceof RankedClientError) || !REPLAY_MISMATCH_CODES.has(error.code)) {
    return false
  }
  return reportClientError({
    code: 'verification_failed',
    surface: 'replay',
    cause: error,
  })
}
