export const H0 = '00'.repeat(32)
export const H1 = '11'.repeat(32)
export const H2 = '22'.repeat(32)
export const H3 = '33'.repeat(32)
export const H4 = '44'.repeat(32)
export const SIGNATURE = '55'.repeat(64)
export const EXPERIMENT_ASSIGNMENTS = {
  'escape:v2': 'midpoint',
  'risk-display:v2': 'danger-band',
}

export function deck() {
  return {
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
    calibrationDigest: H1,
  }
}

export function point(step = 0) {
  return {
    step,
    varianceElapsed: '0',
    logReturn: '0',
    price: '100000000000000',
    intervalHigh: '100000000000100',
    intervalLow: '99999999999900',
  }
}

export function placement(contenderId = 0, isBot = false) {
  return {
    contenderId,
    name: isBot ? `BOT ${contenderId}` : 'PLAYER',
    isBot,
    persona: isBot ? 'steady' : null,
    side: 'upper',
    barrier: '110000000000000',
  }
}

export function createResponse(protocolVersion = 'strikefall/ranked-replay/v3') {
  return {
    protocolVersion,
    roundId: 'round-1',
    deck: deck(),
    status: 'placement',
    commitment: H1,
    serverVerifyingKey: H2,
    createdAtMs: 1_700_000_000_000,
    placementDeadlineMs: 1_700_000_015_000,
    inputFreezeAtMs: 1_700_000_014_000,
    experimentAssignments: EXPERIMENT_ASSIGNMENTS,
    approach: [point()],
    playerPlacement: placement(),
    bots: [placement(1, true)],
    streamUrl: '/v1/solo-rounds/round-1/stream',
  }
}

export function reveal() {
  return {
    pathSeed: '42',
    botSeedRoot: H2,
    salt: H3,
    deckDigest: H4,
    pathDigest: H1,
  }
}

export function result() {
  return {
    outcome: 'survived',
    score: '400000000000000',
    rank: 1,
    survivors: 3,
    closestApproach: '1000000000000',
    contenders: [{
      contenderId: 0,
      name: 'PLAYER',
      outcome: 'survived',
      score: '400000000000000',
      rank: 1,
      touchStep: null,
      closestApproach: '1000000000000',
    }],
    proofDigest: H4,
  }
}

export function signedEvent(
  sequence: number,
  kind: unknown,
  previousDigest = sequence === 0 ? H0 : H1,
  digest = H1,
) {
  return {
    sequence,
    serverTimeMs: 1_700_000_000_000 + sequence,
    previousDigest,
    kind,
    digest,
    signature: SIGNATURE,
  }
}

export function roundCreatedEvent(sequence = 0) {
  return signedEvent(sequence, {
    type: 'round_created',
    data: {
      protocolVersion: 'strikefall/ranked-replay/v3',
      commitment: H1,
      experimentAssignments: EXPERIMENT_ASSIGNMENTS,
      playerPlacement: placement(),
    },
  })
}

export function replayBundle() {
  const events = [
    signedEvent(0, {
      type: 'round_created',
      data: {
        protocolVersion: 'strikefall/ranked-replay/v3',
        commitment: H1,
        experimentAssignments: EXPERIMENT_ASSIGNMENTS,
        playerPlacement: placement(),
      },
    }, H0, H1),
    signedEvent(1, {
      type: 'round_ended',
      data: { proofDigest: H4 },
    }, H1, H2),
    signedEvent(2, {
      type: 'seed_revealed',
      data: { reveal: reveal() },
    }, H2, H3),
  ]
  return {
    protocolVersion: 'strikefall/ranked-replay/v3',
    roundId: 'round-1',
    deck: deck(),
    initialSpot: '100000000000000',
    commitment: H1,
    serverVerifyingKey: H2,
    experimentAssignments: EXPERIMENT_ASSIGNMENTS,
    bots: [placement(1, true)],
    botPlacementDecisions: [],
    placements: [placement(), placement(1, true)],
    lockedScores: [],
    path: { approach: [point()], battle: [point()] },
    escape: null,
    botEscapeDecisions: [],
    botEscapes: [],
    touches: [],
    result: result(),
    reveal: reveal(),
    replayVerification: null,
    events,
  }
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}
