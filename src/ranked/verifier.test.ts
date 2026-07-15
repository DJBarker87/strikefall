import { beforeAll, describe, expect, it, vi } from 'vitest'
import replayFixture from '../../crates/strikefall-protocol/tests/fixtures/ranked_replay_v3.json'
import anchorFixture from '../../crates/strikefall-protocol/tests/fixtures/ranked_replay_v3_anchors.json'
import { loadStrikefallWasm, type StrikefallWasmClient } from '../wasm'
import { RankedReplayVerificationError } from './errors'
import type { ReplayAnchor, ReplayBundle } from './types'
import { parseReplayBundle } from './validation'
import {
  REQUIRED_REGENERATION_CHECKS,
  computeRankedBrowserDigests,
  verifyRankedReplay,
  type RankedReplayRegenerationAdapter,
} from './verifier'
import { createWasmRankedRegenerationAdapter } from './wasmRegenerator'

interface MutableReplayFixture {
  commitment: string
  experimentAssignments: Record<string, string>
  deck: { displayName: string }
  reveal: { deckDigest: string; pathDigest: string; salt: string }
  path: { battle: Array<{ price: string; logReturn: string }> }
  lockedScores: Array<{ terminalScore: string }>
  result: {
    score: string
    proofDigest: string
    contenders: Array<{ score: string }>
  }
  botPlacementDecisions: Array<{
    decisionTimeMs: number
    observationTimeMs: number
    reactionLatencyMs: number
    selectedCandidate: number
    selectedUtility: string
    candidates: Array<{ utility: string }>
  }>
  events: Array<{
    digest: string
    signature: string
    kind: { type: string; data: Record<string, unknown> }
  }>
}

const anchor = {
  roundId: anchorFixture.roundId,
  protocolVersion: anchorFixture.protocolVersion,
  commitment: anchorFixture.commitment,
  serverVerifyingKey: anchorFixture.serverVerifyingKey,
  experimentAssignments: anchorFixture.experimentAssignments,
} as unknown as ReplayAnchor

const completeAdapter: RankedReplayRegenerationAdapter = {
  id: 'test/full-rust-contract',
  protocolVersion: 'strikefall/ranked-replay/v3',
  verifyReplay: vi.fn(async () => ({ valid: true, checks: REQUIRED_REGENERATION_CHECKS })),
}

function frozenBundle(): ReplayBundle {
  return parseReplayBundle(structuredClone(replayFixture))
}

function mutatedBundle(mutate: (fixture: MutableReplayFixture) => void): ReplayBundle {
  const fixture = structuredClone(replayFixture) as unknown as MutableReplayFixture
  mutate(fixture)
  return parseReplayBundle(fixture)
}

function flipHex(value: string): string {
  return `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`
}

function browserSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) throw new Error('Test runtime does not provide SubtleCrypto')
  return subtle
}

describe('ranked v3 cross-language browser verification', () => {
  let wasmClient: StrikefallWasmClient

  beforeAll(async () => {
    // Node-only test input; production lets Vite initialize its emitted URL.
    // @ts-expect-error Node types are intentionally outside the browser tsconfig.
    const { readFile } = await import('node:fs/promises')
    const wasmBytes = await readFile(
      new URL('../wasm/generated/strikefall_wasm_bg.wasm', import.meta.url),
    )
    const loaded = await loadStrikefallWasm({ moduleOrPath: wasmBytes, retry: true })
    if (loaded.status !== 'ready') {
      throw new Error(loaded.status === 'unsupported' ? loaded.reason : loaded.error.message)
    }
    wasmClient = loaded.client
  })

  it('matches every frozen Rust digest and verifies every Ed25519 signature', async () => {
    const bundle = frozenBundle()
    const digests = await computeRankedBrowserDigests(bundle, browserSubtle())
    expect(digests).toMatchObject({
      deck: anchorFixture.deckDigest,
      path: anchorFixture.pathDigest,
      commitment: anchorFixture.commitment,
      lockedScores: anchorFixture.lockedScoresDigest,
      resultProof: anchorFixture.resultProofDigest,
    })
    expect(digests.events).toHaveLength(anchorFixture.eventCount)
    expect(digests.events[0]).toBe(anchorFixture.firstEvent.digest)
    expect(digests.events[anchorFixture.roundEndedEvent.sequence]).toBe(
      anchorFixture.roundEndedEvent.digest,
    )
    expect(digests.events.at(-1)).toBe(anchorFixture.lastEvent.digest)

    const report = await verifyRankedReplay(bundle, {
      anchor,
      subtle: browserSubtle(),
      regenerator: createWasmRankedRegenerationAdapter(wasmClient),
    })
    expect(report.valid).toBe(true)
    expect(report.browserChecks).toContain('every Ed25519 event signature')
    expect(report.delegatedChecks).toEqual(REQUIRED_REGENERATION_CHECKS)
    expect(report.regenerationVerifier).toContain('verify_replay_bundle_against')
  })

  it.each([
    ['deck digest', (fixture: MutableReplayFixture) => {
      fixture.reveal.deckDigest = flipHex(fixture.reveal.deckDigest)
    }, 'deck_digest'],
    ['path digest', (fixture: MutableReplayFixture) => {
      fixture.reveal.pathDigest = flipHex(fixture.reveal.pathDigest)
    }, 'path_digest'],
    ['locked digest', (fixture: MutableReplayFixture) => {
      const locked = fixture.events.find(({ kind }) => kind.type === 'placement_locked')
      if (locked === undefined) throw new Error('fixture lacks placement lock')
      locked.kind.data.lockedScoresDigest = '00'.repeat(32)
    }, 'locked_scores_digest'],
    ['live locked-score payload', (fixture: MutableReplayFixture) => {
      const locked = fixture.events.find(({ kind }) => kind.type === 'placement_locked')
      if (locked === undefined) throw new Error('fixture lacks placement lock')
      const scores = locked.kind.data.lockedScores as Array<{ terminalScore: string }>
      const score = scores[0]
      if (score === undefined) throw new Error('fixture lacks live locked score')
      score.terminalScore = (BigInt(score.terminalScore) + 1n).toString()
    }, 'locked_scores_payload'],
    ['signed lock-phase timing', (fixture: MutableReplayFixture) => {
      const locked = fixture.events.find(({ kind }) => kind.type === 'placement_locked')
      if (locked === undefined) throw new Error('fixture lacks placement lock')
      locked.kind.data.battleStartsAtMs = Number(locked.kind.data.battleStartsAtMs) + 1
    }, 'lock_phase_timeline'],
    ['result digest', (fixture: MutableReplayFixture) => {
      fixture.result.proofDigest = flipHex(fixture.result.proofDigest)
    }, 'result_proof'],
    ['event digest', (fixture: MutableReplayFixture) => {
      const first = fixture.events[0]
      if (first === undefined) throw new Error('fixture lacks event')
      first.digest = flipHex(first.digest)
    }, 'event_digest'],
    ['revealed commitment material', (fixture: MutableReplayFixture) => {
      fixture.reveal.salt = flipHex(fixture.reveal.salt)
    }, 'commitment'],
    ['path point', (fixture: MutableReplayFixture) => {
      const first = fixture.path.battle[0]
      if (first === undefined) throw new Error('fixture lacks battle point')
      first.logReturn = (BigInt(first.logReturn) + 1n).toString()
    }, 'path_digest'],
    ['player summary score', (fixture: MutableReplayFixture) => {
      fixture.result.score = (BigInt(fixture.result.score) + 1n).toString()
    }, 'result_summary'],
    ['contender proof score', (fixture: MutableReplayFixture) => {
      const player = fixture.result.contenders.find((_, index) => index === 0)
      if (player === undefined) throw new Error('fixture lacks contender')
      player.score = (BigInt(player.score) + 1n).toString()
    }, 'result_proof'],
    ['experiment assignment', (fixture: MutableReplayFixture) => {
      fixture.experimentAssignments['risk-display:v2'] = 'probability'
    }, 'experiment_anchor'],
  ])('rejects a mutated %s', async (_label, mutate, expectedCheck) => {
    await expect(verifyRankedReplay(mutatedBundle(mutate), {
      anchor,
      subtle: browserSubtle(),
      regenerator: completeAdapter,
    })).rejects.toMatchObject({
      code: 'verification_failed',
      check: expectedCheck,
    })
  })

  it('rejects mutations to each external anchor and every event signature', async () => {
    await expect(verifyRankedReplay(frozenBundle(), {
      anchor: { ...anchor, roundId: `${anchor.roundId}-changed` },
      subtle: browserSubtle(),
      regenerator: completeAdapter,
    })).rejects.toMatchObject({ check: 'round_anchor' })
    await expect(verifyRankedReplay(frozenBundle(), {
      anchor: {
        ...anchor,
        protocolVersion: 'strikefall/replay/v4' as ReplayAnchor['protocolVersion'],
      },
      subtle: browserSubtle(),
      regenerator: completeAdapter,
    })).rejects.toMatchObject({ check: 'protocol_anchor' })
    await expect(verifyRankedReplay(frozenBundle(), {
      anchor: { ...anchor, commitment: flipHex(anchor.commitment) as ReplayAnchor['commitment'] },
      subtle: browserSubtle(),
      regenerator: completeAdapter,
    })).rejects.toMatchObject({ check: 'commitment_anchor' })
    await expect(verifyRankedReplay(frozenBundle(), {
      anchor: {
        ...anchor,
        serverVerifyingKey: flipHex(anchor.serverVerifyingKey) as ReplayAnchor['serverVerifyingKey'],
      },
      subtle: browserSubtle(),
      regenerator: completeAdapter,
    })).rejects.toMatchObject({ check: 'server_key_anchor' })
    await expect(verifyRankedReplay(frozenBundle(), {
      anchor: {
        ...anchor,
        experimentAssignments: {
          ...anchor.experimentAssignments,
          'risk-display:v2': 'probability',
        },
      },
      subtle: browserSubtle(),
      regenerator: completeAdapter,
    })).rejects.toMatchObject({ check: 'experiment_anchor' })

    for (const index of [0, Math.floor(anchorFixture.eventCount / 2), anchorFixture.eventCount - 1]) {
      const signed = mutatedBundle((fixture) => {
        const event = fixture.events[index]
        if (event === undefined) throw new Error(`fixture lacks event ${index}`)
        event.signature = flipHex(event.signature)
      })
      await expect(verifyRankedReplay(signed, {
        anchor,
        subtle: browserSubtle(),
        regenerator: completeAdapter,
      })).rejects.toMatchObject({ check: 'event_signature' })
    }
  })

  it('fails closed when WebCrypto, full regeneration, or required checks are unavailable', async () => {
    await expect(verifyRankedReplay(frozenBundle(), {
      anchor,
      subtle: null,
      regenerator: completeAdapter,
    })).rejects.toMatchObject({
      code: 'verification_unavailable',
      check: 'webcrypto',
    })
    await expect(verifyRankedReplay(frozenBundle(), {
      anchor,
      subtle: browserSubtle(),
      regenerator: null,
    })).rejects.toMatchObject({
      code: 'verification_unavailable',
      check: 'rust_wasm_regeneration',
    })
    await expect(verifyRankedReplay(frozenBundle(), {
      anchor,
      subtle: browserSubtle(),
      regenerator: {
        ...completeAdapter,
        verifyReplay: async () => ({ valid: true, checks: ['path_regeneration'] }),
      },
    })).rejects.toBeInstanceOf(RankedReplayVerificationError)
  })

  it('delegates bot and score regeneration to the exact Rust verifier', async () => {
    const adapter = createWasmRankedRegenerationAdapter(wasmClient)
    const changedBot = mutatedBundle((fixture) => {
      const decision = fixture.botPlacementDecisions[0]
      if (decision === undefined) throw new Error('fixture lacks bot decision')
      const candidate = decision.candidates[0]
      if (candidate === undefined) throw new Error('fixture lacks bot candidate')
      candidate.utility = (BigInt(candidate.utility) + 1n).toString()
      if (decision.selectedCandidate === 0) decision.selectedUtility = candidate.utility
    })
    await expect(adapter.verifyReplay(changedBot, anchor)).rejects.toThrow()

    const changedLocked = mutatedBundle((fixture) => {
      const score = fixture.lockedScores[0]
      if (score === undefined) throw new Error('fixture lacks locked score')
      score.terminalScore = (BigInt(score.terminalScore) + 1n).toString()
    })
    await expect(adapter.verifyReplay(changedLocked, anchor)).rejects.toThrow()
  })

  it('rejects a reaction interval whose observation cutoff does not match its latency', () => {
    const fixture = structuredClone(replayFixture) as unknown as MutableReplayFixture
    const decision = fixture.botPlacementDecisions[0]
    if (decision === undefined) throw new Error('fixture lacks bot decision')
    decision.observationTimeMs += 1
    expect(() => parseReplayBundle(fixture)).toThrow(/observationTimeMs/)
  })
})
