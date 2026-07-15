import { beforeAll, describe, expect, it } from 'vitest'
import golden from '../wasm/golden-vectors.json'
import { getDeck } from '../game/decks'
import { buildReplayBundle, verifyReplayBundle } from '../game/replay'
import { barrierForPlacement, scoreContenders } from '../game/scoring'
import type { Contender } from '../game/types'
import { loadStrikefallWasm } from '../wasm'
import {
  barrierWithActiveEngine,
  installScoringEngineClient,
  quoteWithActiveEngine,
} from './runtime'
import { displayNumberToFixed } from './fixed'

function contender(
  id: string,
  side: 'upper' | 'lower',
  distance: number,
): Contender {
  return {
    id,
    name: id,
    persona: 'Chaos',
    isPlayer: id === 'player',
    side,
    distance,
    barrier: barrierForPlacement(100, side, distance),
    risk: 1,
    crowd: 1,
    potential: 100,
    color: '#fff',
    outcome: 'active',
    hitAt: null,
    closestApproach: distance,
    escape: null,
    moves: [],
  }
}

describe('browser engine against native Rust golden vectors', () => {
  beforeAll(async () => {
    // Node-only test input; the shipped browser build uses Vite's emitted URL.
    // @ts-expect-error Node types are intentionally not part of the browser tsconfig.
    const { readFile } = await import('node:fs/promises')
    const wasmBytes = await readFile(
      new URL('../wasm/generated/strikefall_wasm_bg.wasm', import.meta.url),
    )
    const loaded = await loadStrikefallWasm({
      moduleOrPath: wasmBytes,
      retry: true,
    })
    if (loaded.status !== 'ready') {
      throw new Error(
        loaded.status === 'unsupported' ? loaded.reason : loaded.error.message,
      )
    }
    installScoringEngineClient(
      loaded.client,
      { id: 'balanced-tape', name: 'Balanced Tape' },
      0.0064,
    )
  })

  it('matches Rust quote, barrier, and locked placement outputs', () => {
    const expected = golden.expected
    const quote = quoteWithActiveEngine({
      spot: 100,
      barrier: 110,
      remainingVariance: 0.0064,
      side: 'upper',
    })
    expect(displayNumberToFixed(quote!.survivalProbability)).toBe(
      expected.noTouchQuote.survivalProbability,
    )
    expect(displayNumberToFixed(quote!.hitProbability)).toBe(
      expected.noTouchQuote.hitProbability,
    )
    expect(displayNumberToFixed(barrierWithActiveEngine(100, 0.45, 'upper')!)).toBe(
      expected.barrierSolve,
    )

    const scored = scoreContenders([
      contender('player', 'upper', 10),
      contender('second', 'upper', 10.5),
      contender('third', 'lower', 9),
    ], 100)
    for (const [index, score] of scored.entries()) {
      const rust = expected.lobbyScores[index]!
      expect(displayNumberToFixed(score.barrier)).toBe(rust.barrier)
      expect(displayNumberToFixed(score.risk)).toBe(rust.riskMultiplier)
      expect(displayNumberToFixed(score.crowd)).toBe(rust.crowdFactor)
      expect(score.potential).toBe(Math.round(Number(rust.terminalScore) / 1e12))
    }
  })

  it('commits WASM eligibility while keeping the client-seeded round unranked', async () => {
    const bundle = await buildReplayBundle({
      masterSeed: 'wasm-ranked-golden',
      deck: getDeck('balanced-tape')!,
      salt: 'b4c96b8539d52b0962eef870427deb3bdd894fa88e1ea4debdedf1db40aca290',
      approachCandles: 3,
      battleSteps: 17,
      escapeEnabled: false,
    })
    const verification = await verifyReplayBundle(bundle, bundle.commitment.value)
    expect(bundle.protocolVersion).toBe('strikefall/replay/v4')
    expect(bundle.roundAuthority).toBe('local-practice/v1')
    expect(bundle.engine).toMatchObject({
      mode: 'wasm-solmath',
      rankable: true,
      rustDeckId: 'balanced_tape',
      pathSource: 'rust-wasm-bridge-extrema/v1',
    })
    expect(bundle.commitment).toMatchObject({
      engineMode: 'wasm-solmath',
      engineVersion: bundle.engine.engineVersion,
      engineDigest: bundle.engine.digest,
      engineRankable: true,
    })
    expect(verification.valid).toBe(true)
    expect(verification.rankable).toBe(false)
  })
})
