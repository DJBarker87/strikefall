import { describe, expect, it, vi } from 'vitest'
import { fetchAuthoritativeMetrics, parseAuthoritativeMetrics } from './authoritative'

function fixture() {
  return {
    schemaVersion: 'strikefall/telemetry/v2',
    windowStartMs: 10,
    windowEndMs: 20,
    deckId: null,
    counts: { round_completed: 4 },
    completionRatePerMille: 800,
    distinctSessions: 5,
    distinctRoundStarts: 5,
    roundStartSessions: 5,
    secondRoundSessions: 3,
    thirdRoundSessions: 2,
    rematchRatePerMille: 600,
    thirdRoundRatePerMille: 400,
    outcomes: { survived: 2, eliminated: 2 },
    clientErrorSessions: 0,
    errorSessionRatePerMillion: 0,
    g4ErrorStatus: 'insufficient',
    g4MinimumSessions: 50,
    g4Note: 'sample pending',
    flagRevisionSamples: 4,
    medianFlagRevisionsMilli: 2500,
    survivorSamples: 4,
    medianSurvivorsMilli: 4000,
    placementSpreadRounds: 4,
    healthyPlacementSpreadRounds: 4,
    placementSpreadRatePerMille: 1000,
    noEliminationRounds: 0,
    noEliminationRatePerMille: 0,
    earlyMassWipeRounds: 0,
    earlyMassWipeRatePerMille: 0,
    eliminationStepDistribution: null,
    eliminationStepDistributionNote: 'bounded histogram',
    deadPlayerEliminations: 2,
    deadPlayerResponsesWithinFiveSeconds: 2,
    deadPlayerResponseRatePerMille: 1000,
    deadPlayerResponseNote: 'server receipt time',
    shareIntentRounds: 1,
    shareIntentRatePerMille: 250,
    clipExportedRounds: 1,
    clipExportRatePerMille: 250,
    experimentCuts: [],
  }
}

describe('authoritative metrics client', () => {
  it('parses privacy-bounded server aggregates', () => {
    expect(parseAuthoritativeMetrics(fixture())).toMatchObject({
      schemaVersion: 'strikefall/telemetry/v2',
      rematchRatePerMille: 600,
      medianFlagRevisionsMilli: 2500,
      shareIntentRounds: 1,
    })
    expect(() => parseAuthoritativeMetrics({ ...fixture(), distinctSessions: -1 })).toThrow(
      /distinctSessions/,
    )
  })

  it('uses an in-memory operator bearer and never sends it in the URL', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(fixture()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const result = await fetchAuthoritativeMetrics({
      baseUrl: 'https://alpha.example/',
      token: 'operator-secret',
      windowHours: 72,
      deckId: 'pulse',
      fetch,
    })
    expect(result.distinctSessions).toBe(5)
    expect(fetch).toHaveBeenCalledWith(
      'https://alpha.example/v1/telemetry/metrics?windowHours=72&deckId=pulse',
      expect.objectContaining({
        headers: { authorization: 'Bearer operator-secret' },
        cache: 'no-store',
      }),
    )
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>
    expect(String(calls[0]?.[0])).not.toContain('operator-secret')
  })
})
