import { describe, expect, it, vi } from 'vitest'
import replayFixture from '../../crates/strikefall-protocol/tests/fixtures/ranked_replay_v3.json'
import anchorFixture from '../../crates/strikefall-protocol/tests/fixtures/ranked_replay_v3_anchors.json'
import { RankedReplayVerificationError } from '../ranked/errors'
import type { RankedReplayVerificationReport } from '../ranked/verifier'
import { loadVerifiedRankedReplay, type RankedReplayLoader } from './verify'

const validReport = {
  valid: true,
  protocolVersion: 'strikefall/ranked-replay/v3',
  browserChecks: ['every Ed25519 event signature'],
  delegatedChecks: ['event_semantics'],
  regenerationVerifier: 'test/full-verifier',
  digests: {
    deck: anchorFixture.deckDigest,
    path: anchorFixture.pathDigest,
    commitment: anchorFixture.commitment,
    lockedScores: anchorFixture.lockedScoresDigest,
    resultProof: anchorFixture.resultProofDigest,
    events: [],
  },
} as unknown as RankedReplayVerificationReport

function loaderFor(replay: unknown = replayFixture): RankedReplayLoader {
  return vi.fn(async () => ({
    replay,
    anchor: {
      roundId: anchorFixture.roundId,
      protocolVersion: anchorFixture.protocolVersion,
      commitment: anchorFixture.commitment,
      serverVerifyingKey: anchorFixture.serverVerifyingKey,
      experimentAssignments: anchorFixture.experimentAssignments,
    },
  }))
}

describe('ranked replay viewer verification boundary', () => {
  it('returns render data only after the supplied full verifier succeeds', async () => {
    const verify = vi.fn(async () => validReport)
    const result = await loadVerifiedRankedReplay({
      replayId: anchorFixture.roundId,
      loader: loaderFor(),
      signal: new AbortController().signal,
      verify,
    })

    expect(verify).toHaveBeenCalledOnce()
    expect(result.view.roundId).toBe(anchorFixture.roundId)
    expect(result.view.proof.verifier).toBe('test/full-verifier')
  })

  it('fails closed on an invalid proof without deriving a visible result', async () => {
    const verify = vi.fn(async () => {
      throw new RankedReplayVerificationError(
        'verification_failed',
        'result_proof',
        'Result proof changed.',
      )
    })

    await expect(loadVerifiedRankedReplay({
      replayId: anchorFixture.roundId,
      loader: loaderFor(),
      signal: new AbortController().signal,
      verify,
    })).rejects.toMatchObject({
      code: 'verification_failed',
      check: 'result_proof',
    })
    expect(verify).toHaveBeenCalledOnce()
  })

  it('rejects a replay whose body does not match the requested ID before verification', async () => {
    const replay = structuredClone(replayFixture)
    replay.roundId = 'f295e5aa-319a-44d9-90f7-5d3bc5eaccf5'
    const verify = vi.fn(async () => validReport)

    await expect(loadVerifiedRankedReplay({
      replayId: anchorFixture.roundId,
      loader: loaderFor(replay),
      signal: new AbortController().signal,
      verify,
    })).rejects.toMatchObject({ code: 'protocol_mismatch' })
    expect(verify).not.toHaveBeenCalled()
  })
})
