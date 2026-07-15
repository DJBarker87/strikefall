import { describe, expect, it, vi } from 'vitest'
import {
  StrikefallWasmError,
  createStrikefallWasmClient,
  createStrikefallWasmLoader,
  toSignedDecimal,
  toU64Decimal,
  toUnsignedDecimal,
} from './adapter'
import type { StrikefallWasmBindings } from './adapter'

function validBindings(overrides: Partial<StrikefallWasmBindings> = {}): StrikefallWasmBindings {
  return {
    deck_catalog_json: vi.fn(() =>
      JSON.stringify([
        {
          id: 'balanced_tape',
          version: 3,
          displayName: 'Balanced Tape',
          approachSteps: 60,
          battleSteps: 240,
          stepMs: 250,
          monitoringConvention: 'strikefall/brownian-bridge-extrema/v1',
          varianceWeights: [25, 25, 25, 25],
          openingRunway: { steps: 40, varianceShareBps: 340 },
          totalIntegratedVariance: '6400000000',
          driftPerVariance: '-500000000000',
          minInitialSurvival: '120000000000',
          maxInitialSurvival: '900000000000',
          riskMultiplierCap: '8000000000000',
          artTheme: 'electric_cyan',
          audioProfile: 'steady_pressure',
          calibrationDigest: 'f315781248b4ada5266258026abf0d99934f1c7b665d5d5296b967df3cad8334',
        },
      ]),
    ),
    generate_round_path_json: vi.fn(() =>
      JSON.stringify({
        approach: [{ step: 0, varianceElapsed: '0', logReturn: '0', price: '100000000000000', intervalHigh: '100000000000000', intervalLow: '100000000000000' }],
        battle: [{ step: 1, varianceElapsed: '10', logReturn: '-2', price: '99999999999998', intervalHigh: '100000000000020', intervalLow: '99999999999970' }],
      }),
    ),
    generate_battle_path_json: vi.fn(() =>
      JSON.stringify([
        { step: 0, varianceElapsed: '0', logReturn: '0', price: '100000000000000', intervalHigh: '100000000000000', intervalLow: '100000000000000' },
        { step: 1, varianceElapsed: '10', logReturn: '-2', price: '99999999999998', intervalHigh: '100000000000020', intervalLow: '99999999999970' },
      ]),
    ),
    remaining_variance_fixed: vi.fn(() => '3200000000'),
    quote_no_touch_json: vi.fn(() =>
      JSON.stringify({ survivalProbability: '450000000000', hitProbability: '550000000000' }),
    ),
    barrier_for_survival_fixed: vi.fn(() => '104735436920400'),
    lock_lobby_scores_json: vi.fn(() =>
      JSON.stringify([
        {
          contenderId: 7,
          side: 'upper',
          barrier: '110000000000000',
          normalizedDistance: '1191399649942',
          initialSurvival: '721906827452',
          riskMultiplier: '1246698279839',
          crowdFactor: '1600000000000',
          terminalScore: '199471724774200',
        },
      ]),
    ),
    verify_ranked_replay_json: vi.fn(() => JSON.stringify({
      valid: true,
      roundId: 'round-1',
      verifiedChecks: ['hidden path regeneration'],
      pathPoints: 302,
      signedEvents: 392,
    })),
    ...overrides,
  }
}

describe('precision-safe WASM decimals', () => {
  it('canonicalizes bigint inputs without crossing a JavaScript number', () => {
    expect(toUnsignedDecimal(340282366920938463463374607431768211455n)).toBe(
      '340282366920938463463374607431768211455',
    )
    expect(toSignedDecimal(-170141183460469231731687303715884105728n)).toBe(
      '-170141183460469231731687303715884105728',
    )
    expect(toU64Decimal(18446744073709551615n)).toBe('18446744073709551615')
  })

  it('rejects lossy numbers, non-canonical text, and Rust overflow', () => {
    expect(() => toUnsignedDecimal(1 as unknown as string)).toThrow(/numbers are not accepted/)
    expect(() => toUnsignedDecimal('01')).toThrow(/canonical decimal/)
    expect(() => toSignedDecimal('-0')).toThrow(/canonical decimal/)
    expect(() => toUnsignedDecimal('-1')).toThrow(/canonical decimal/)
    expect(() => toU64Decimal('18446744073709551616')).toThrow(/outside the supported integer range/)
    expect(() => toSignedDecimal('170141183460469231731687303715884105728')).toThrow(
      /outside the supported integer range/,
    )
  })
})

describe('typed WASM client', () => {
  it('validates and maps every boundary operation', () => {
    const bindings = validBindings()
    const client = createStrikefallWasmClient(bindings)

    expect(client.deckCatalog()[0]?.totalIntegratedVariance).toBe('6400000000')
    expect(client.deckCatalog()[0]?.calibrationDigest).toBe(
      'f315781248b4ada5266258026abf0d99934f1c7b665d5d5296b967df3cad8334',
    )
    expect(
      client.generateRoundPath({
        deckId: 'balanced_tape',
        deckVersion: 3,
        seed: 3405691582n,
        initialSpot: 100000000000000n,
      }).battle[0]?.logReturn,
    ).toBe('-2')
    expect(client.generateBattlePath({
      deckId: 'balanced_tape',
      deckVersion: 3,
      seed: 3405691582n,
      initialSpot: 100000000000000n,
    })[1]?.logReturn).toBe('-2')
    expect(client.remainingVariance({
      deckId: 'balanced_tape',
      deckVersion: 3,
      completedSteps: 120,
    })).toBe('3200000000')
    expect(
      client.quoteNoTouch({
        spot: '100000000000000',
        barrier: '110000000000000',
        remainingVariance: '6400000000',
        driftPerVariance: '-500000000000',
        side: 'upper',
        alreadyBreached: true,
      }).hitProbability,
    ).toBe('550000000000')
    expect(
      client.barrierForSurvival({
        spot: '100000000000000',
        targetSurvival: '450000000000',
        remainingVariance: '6400000000',
        driftPerVariance: '-500000000000',
        side: 'upper',
      }),
    ).toBe('104735436920400')
    expect(
      client.lockLobbyScores({
        spot: '100000000000000',
        remainingVariance: '6400000000',
        driftPerVariance: '-500000000000',
        placements: [{ contenderId: 7, side: 'upper', barrier: '110000000000000' }],
      })[0]?.terminalScore,
    ).toBe('199471724774200')
    expect(client.verifyRankedReplayJson({
      replayJson: '{"protocolVersion":"strikefall/ranked-replay/v3"}',
      expectedCommitment: '11'.repeat(32),
      expectedServerKey: '22'.repeat(32),
    })).toMatchObject({ valid: true, signedEvents: 392 })

    expect(bindings.generate_round_path_json).toHaveBeenCalledWith(
      'balanced_tape',
      3,
      '3405691582',
      '100000000000000',
    )
    expect(bindings.generate_battle_path_json).toHaveBeenCalledWith(
      'balanced_tape',
      3,
      '3405691582',
      '100000000000000',
    )
    expect(bindings.remaining_variance_fixed).toHaveBeenCalledWith('balanced_tape', 3, 120)
    const lobbyJson = vi.mocked(bindings.lock_lobby_scores_json).mock.calls[0]?.[3]
    expect(JSON.parse(lobbyJson ?? '')).toEqual([
      { contenderId: 7, side: 'upper', barrier: '110000000000000' },
    ])
  })

  it('rejects malformed responses and runtime-only input mistakes', () => {
    const malformed = createStrikefallWasmClient(
      validBindings({ quote_no_touch_json: () => '{"survivalProbability":1}' }),
    )
    const quoteInput = {
      spot: '100000000000000',
      barrier: '110000000000000',
      remainingVariance: '6400000000',
      driftPerVariance: '-500000000000',
      side: 'upper' as const,
    }

    expect(() => malformed.quoteNoTouch(quoteInput)).toThrow(StrikefallWasmError)
    const impossibleWick = createStrikefallWasmClient(validBindings({
      generate_round_path_json: () => JSON.stringify({
        approach: [],
        battle: [{
          step: 0,
          varianceElapsed: '0',
          logReturn: '0',
          price: '100',
          intervalHigh: '99',
          intervalLow: '100',
        }],
      }),
    }))
    expect(() => impossibleWick.generateRoundPath({
      deckId: 'balanced_tape',
      deckVersion: 3,
      seed: '1',
      initialSpot: '100',
    })).toThrow(/intervalHigh/)
    expect(() =>
      createStrikefallWasmClient(validBindings()).quoteNoTouch({
        ...quoteInput,
        alreadyBreached: 'yes' as unknown as boolean,
      }),
    ).toThrow(/alreadyBreached must be a boolean/)
  })
})

describe('WASM loader state machine', () => {
  it('reports unsupported environments without attempting initialization', async () => {
    const initialize = vi.fn(async () => validBindings())
    const loader = createStrikefallWasmLoader({ isSupported: () => false, initialize })

    await expect(loader.load()).resolves.toMatchObject({ status: 'unsupported' })
    expect(loader.getState().status).toBe('unsupported')
    expect(initialize).not.toHaveBeenCalled()
  })

  it('coalesces concurrent loads and caches the ready client', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const initialize = vi.fn(async () => {
      await gate
      return validBindings()
    })
    const loader = createStrikefallWasmLoader({ isSupported: () => true, initialize })

    const first = loader.load()
    const second = loader.load()
    expect(first).toBe(second)
    expect(loader.getState().status).toBe('loading')
    release?.()

    const ready = await first
    expect(ready.status).toBe('ready')
    await expect(loader.load()).resolves.toBe(ready)
    expect(initialize).toHaveBeenCalledTimes(1)
  })

  it('caches initialization errors and retries only when requested', async () => {
    const initialize = vi
      .fn<() => Promise<StrikefallWasmBindings>>()
      .mockRejectedValueOnce(new Error('broken bytes'))
      .mockResolvedValueOnce(validBindings())
    const loader = createStrikefallWasmLoader({ isSupported: () => true, initialize })

    const failed = await loader.load()
    expect(failed.status).toBe('error')
    await expect(loader.load()).resolves.toBe(failed)
    expect(initialize).toHaveBeenCalledTimes(1)

    await expect(loader.load({ retry: true })).resolves.toMatchObject({ status: 'ready' })
    expect(initialize).toHaveBeenCalledTimes(2)
  })
})
