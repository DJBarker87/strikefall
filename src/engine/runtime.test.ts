import { describe, expect, it } from 'vitest'
import {
  createStrikefallWasmClient,
  type StrikefallWasmBindings,
} from '../wasm/adapter'
import {
  assertActiveEngine,
  barrierFixedWithActiveEngine,
  barrierWithActiveEngine,
  createLegacyFallbackEngineDescriptor,
  installScoringEngineClient,
  lockLobbyWithActiveEngine,
  quoteWithActiveEngine,
  remainingVarianceFixedWithActiveEngine,
  rustDeckId,
  scoringEngineDescriptorIsValid,
} from './runtime'

function fakeBindings(calls: unknown[][]): StrikefallWasmBindings {
  return {
    deck_catalog_json: () => JSON.stringify([{
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
    }]),
    generate_round_path_json: () => JSON.stringify({ approach: [], battle: [] }),
    generate_battle_path_json: () => JSON.stringify([]),
    remaining_variance_fixed: () => '3200000000',
    quote_no_touch_json: (...args) => {
      calls.push([...args])
      return JSON.stringify({
        survivalProbability: '450000000000',
        hitProbability: '550000000000',
      })
    },
    barrier_for_survival_fixed: (...args) => {
      calls.push([...args])
      return args[4] === 'upper' ? '104735436920400' : '95489918338100'
    },
    lock_lobby_scores_json: (spot, variance, drift, placementsJson) => {
      calls.push([spot, variance, drift, placementsJson])
      const placements = JSON.parse(placementsJson) as Array<{
        contenderId: number
        side: 'upper' | 'lower'
        barrier: string
      }>
      return JSON.stringify(placements.map((placement) => ({
        ...placement,
        normalizedDistance: '591147200000',
        initialSurvival: '450000000000',
        riskMultiplier: '2000000000000',
        crowdFactor: '1500000000000',
        terminalScore: '300000000000000',
      })))
    },
    verify_ranked_replay_json: () => JSON.stringify({
      valid: true,
      roundId: 'round-test',
      verifiedChecks: [],
      pathPoints: 0,
      signedEvents: 0,
    }),
  }
}

describe('browser scoring runtime', () => {
  it('maps browser deck ids onto the Rust catalog explicitly', () => {
    expect(rustDeckId('balanced-tape')).toBe('balanced_tape')
    expect(rustDeckId('compression-break')).toBe('compression_break')
    expect(rustDeckId('opening-rush')).toBe('opening_rush')
    expect(rustDeckId('pulse')).toBe('pulse')
    expect(() => rustDeckId('unknown')).toThrow(RangeError)
  })

  it('rejects a browser deck schedule that aliases a Rust deck/version', () => {
    const client = createStrikefallWasmClient(fakeBindings([]))
    expect(() => installScoringEngineClient(client, {
      id: 'balanced-tape',
      name: 'Balanced Tape',
      version: 3,
      monitoringConvention: 'strikefall/brownian-bridge-extrema/v1',
      variance: [1, 1, 1, 2],
      openingRunway: { steps: 40, varianceShareBps: 340 },
    }, 0.0064)).toThrow(/variance schedule mismatch/)
  })

  it('passes only canonical fixed strings into every adapter fixed input', () => {
    const calls: unknown[][] = []
    const client = createStrikefallWasmClient(fakeBindings(calls))
    const descriptor = installScoringEngineClient(
      client,
      { id: 'balanced-tape', name: 'Balanced Tape' },
      0.0064,
    )
    calls.length = 0

    expect(barrierWithActiveEngine(100, 0.45, 'upper')).toBe(104.7354369204)
    expect(quoteWithActiveEngine({
      spot: 100,
      barrier: 110,
      remainingVariance: 0.0064,
      side: 'upper',
    })).toEqual({
      survivalProbabilityFixed: '450000000000',
      hitProbabilityFixed: '550000000000',
      survivalProbability: 0.45,
      hitProbability: 0.55,
    })
    expect(lockLobbyWithActiveEngine(100, [
      { id: 'alpha', side: 'upper', barrier: 110 },
    ])).toEqual([{
      id: 'alpha',
      survivalFixed: '450000000000',
      riskFixed: '2000000000000',
      crowdFixed: '1500000000000',
      potentialFixed: '300000000000000',
      survival: 0.45,
      risk: 2,
      crowd: 1.5,
      potential: 300,
    }])

    expect(descriptor.rankable).toBe(true)
    expect(descriptor.pathSource).toBe('rust-wasm-bridge-extrema/v1')
    expect(scoringEngineDescriptorIsValid(descriptor)).toBe(true)
    for (const call of calls) {
      expect(call.some((value) => typeof value === 'number')).toBe(false)
      expect(call.slice(0, 3).every((value) => (
        typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)
      ))).toBe(true)
    }
    const placementsJson = calls.at(-1)?.[3]
    expect(typeof placementsJson).toBe('string')
    const encodedPlacements = JSON.parse(String(placementsJson)) as Array<{
      contenderId: number
      barrier: unknown
    }>
    expect(encodedPlacements[0]).toEqual({
      contenderId: 0,
      side: 'upper',
      barrier: '110000000000000',
    })
  })

  it('prefers canonical fixed inputs over deliberately different display projections', () => {
    const calls: unknown[][] = []
    const client = createStrikefallWasmClient(fakeBindings(calls))
    installScoringEngineClient(
      client,
      { id: 'balanced-tape', name: 'Balanced Tape', version: 3 },
      0.0064,
    )
    calls.length = 0

    expect(barrierFixedWithActiveEngine(
      1,
      0.45,
      'upper',
      '100000000000000',
    )).toBe('104735436920400')
    quoteWithActiveEngine({
      spot: 1,
      spotFixed: '100000000000000',
      barrier: 2,
      barrierFixed: '110000000000000',
      remainingVariance: 3,
      remainingVarianceFixed: '6400000000',
      side: 'upper',
    })
    lockLobbyWithActiveEngine(
      1,
      [{
        id: 'exact',
        side: 'upper',
        barrier: 2,
        barrierFixed: '110000000000000',
      }],
      '100000000000000',
    )

    expect(calls[0]?.[0]).toBe('100000000000000')
    expect(calls[1]?.slice(0, 3)).toEqual([
      '100000000000000',
      '110000000000000',
      '6400000000',
    ])
    expect(calls[2]?.slice(0, 3)).toEqual([
      '100000000000000',
      '6400000000',
      '-500000000000',
    ])
    expect(remainingVarianceFixedWithActiveEngine(
      { id: 'balanced-tape', name: 'Balanced Tape', version: 3 },
      120,
      241,
    )).toBe('3200000000')
    expect(() => quoteWithActiveEngine({
      spot: 100,
      spotFixed: '',
      barrier: 110,
      remainingVariance: 0.0064,
      side: 'upper',
    })).toThrow(/spotFixed/)
  })

  it('decodes the legacy TypeScript descriptor but never activates it for new rounds', () => {
    const descriptor = createLegacyFallbackEngineDescriptor('stored replay metadata')
    expect(descriptor.mode).toBe('typescript-fallback')
    expect(descriptor.rankable).toBe(false)
    expect(descriptor.pathSource).toBe('typescript-bridge-extrema/v2')
    expect(scoringEngineDescriptorIsValid(descriptor)).toBe(true)
    expect(() => assertActiveEngine(descriptor)).toThrow(/replay metadata only/)
  })
})
