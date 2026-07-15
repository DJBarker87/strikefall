import type { StrikefallWasmClient } from '../wasm/adapter'
import {
  REQUIRED_REGENERATION_CHECKS,
  type RankedReplayRegenerationAdapter,
} from './verifier'

/**
 * Adapts the exact Rust `verify_replay_bundle_against` WASM export to the
 * fail-closed ranked verifier contract.
 */
export function createWasmRankedRegenerationAdapter(
  client: StrikefallWasmClient,
): RankedReplayRegenerationAdapter {
  return {
    id: 'strikefall-wasm/verify_replay_bundle_against/v2',
    protocolVersion: 'strikefall/ranked-replay/v3',
    async verifyReplay(bundle, anchor) {
      const report = client.verifyRankedReplayJson({
        replayJson: JSON.stringify(bundle),
        expectedCommitment: anchor.commitment,
        expectedServerKey: anchor.serverVerifyingKey,
      })
      const expectedPathPoints = bundle.path.approach.length + bundle.path.battle.length
      const reportMatches = report.valid
        && report.roundId === bundle.roundId
        && report.pathPoints === expectedPathPoints
        && report.signedEvents === bundle.events.length
        && report.verifiedChecks.length > 0
      return {
        valid: reportMatches,
        checks: reportMatches ? REQUIRED_REGENERATION_CHECKS : [],
        reason: reportMatches
          ? undefined
          : 'Rust/WASM verification report did not match the submitted replay.',
      }
    },
  }
}
