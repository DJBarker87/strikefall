export interface AuthoritativeProductMetrics {
  distinctSessions: number
  distinctRoundStarts: number
  roundStartSessions: number
  secondRoundSessions: number
  thirdRoundSessions: number
  rematchRatePerMille: number
  thirdRoundRatePerMille: number
  outcomes: Readonly<Record<string, number>>
  clientErrorSessions: number
  errorSessionRatePerMillion: number | null
  g4ErrorStatus: 'insufficient' | 'pass' | 'fail'
  g4MinimumSessions: number
  g4Note: string
  flagRevisionSamples: number
  medianFlagRevisionsMilli: number | null
  survivorSamples: number
  medianSurvivorsMilli: number | null
  placementSpreadRounds: number
  healthyPlacementSpreadRounds: number
  placementSpreadRatePerMille: number | null
  noEliminationRounds: number
  noEliminationRatePerMille: number | null
  earlyMassWipeRounds: number
  earlyMassWipeRatePerMille: number | null
  deadPlayerEliminations: number
  deadPlayerResponsesWithinFiveSeconds: number
  deadPlayerResponseRatePerMille: number | null
  deadPlayerResponseNote: string
  shareIntentRounds: number
  shareIntentRatePerMille: number | null
  clipExportedRounds: number
  clipExportRatePerMille: number | null
}

export interface AuthoritativeExperimentCut extends AuthoritativeProductMetrics {
  experimentKey: string
  variant: string
  counts: Readonly<Record<string, number>>
  completionRatePerMille: number
}

export interface AuthoritativeMetricsResponse extends AuthoritativeProductMetrics {
  schemaVersion: string
  windowStartMs: number
  windowEndMs: number
  deckId: string | null
  counts: Readonly<Record<string, number>>
  completionRatePerMille: number
  experimentCuts: readonly AuthoritativeExperimentCut[]
}

export interface FetchAuthoritativeMetricsOptions {
  baseUrl: string
  token: string
  windowHours?: number
  deckId?: string
  fetch?: typeof globalThis.fetch
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be text`)
  return value
}

function uint(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a safe unsigned integer`)
  }
  return value
}

function nullableUint(value: unknown, field: string): number | null {
  return value === null ? null : uint(value, field)
}

function countMap(value: unknown, field: string): Readonly<Record<string, number>> {
  const source = record(value, field)
  return Object.fromEntries(
    Object.entries(source).map(([key, count]) => [key, uint(count, `${field}.${key}`)]),
  )
}

function errorStatus(value: unknown, field: string): AuthoritativeProductMetrics['g4ErrorStatus'] {
  if (value !== 'insufficient' && value !== 'pass' && value !== 'fail') {
    throw new TypeError(`${field} must be a known status`)
  }
  return value
}

function productMetrics(source: Record<string, unknown>, field: string): AuthoritativeProductMetrics {
  return {
    distinctSessions: uint(source.distinctSessions, `${field}.distinctSessions`),
    distinctRoundStarts: uint(source.distinctRoundStarts, `${field}.distinctRoundStarts`),
    roundStartSessions: uint(source.roundStartSessions, `${field}.roundStartSessions`),
    secondRoundSessions: uint(source.secondRoundSessions, `${field}.secondRoundSessions`),
    thirdRoundSessions: uint(source.thirdRoundSessions, `${field}.thirdRoundSessions`),
    rematchRatePerMille: uint(source.rematchRatePerMille, `${field}.rematchRatePerMille`),
    thirdRoundRatePerMille: uint(source.thirdRoundRatePerMille, `${field}.thirdRoundRatePerMille`),
    outcomes: countMap(source.outcomes, `${field}.outcomes`),
    clientErrorSessions: uint(source.clientErrorSessions, `${field}.clientErrorSessions`),
    errorSessionRatePerMillion: nullableUint(source.errorSessionRatePerMillion, `${field}.errorSessionRatePerMillion`),
    g4ErrorStatus: errorStatus(source.g4ErrorStatus, `${field}.g4ErrorStatus`),
    g4MinimumSessions: uint(source.g4MinimumSessions, `${field}.g4MinimumSessions`),
    g4Note: text(source.g4Note, `${field}.g4Note`),
    flagRevisionSamples: uint(source.flagRevisionSamples, `${field}.flagRevisionSamples`),
    medianFlagRevisionsMilli: nullableUint(source.medianFlagRevisionsMilli, `${field}.medianFlagRevisionsMilli`),
    survivorSamples: uint(source.survivorSamples, `${field}.survivorSamples`),
    medianSurvivorsMilli: nullableUint(source.medianSurvivorsMilli, `${field}.medianSurvivorsMilli`),
    placementSpreadRounds: uint(source.placementSpreadRounds, `${field}.placementSpreadRounds`),
    healthyPlacementSpreadRounds: uint(source.healthyPlacementSpreadRounds, `${field}.healthyPlacementSpreadRounds`),
    placementSpreadRatePerMille: nullableUint(source.placementSpreadRatePerMille, `${field}.placementSpreadRatePerMille`),
    noEliminationRounds: uint(source.noEliminationRounds, `${field}.noEliminationRounds`),
    noEliminationRatePerMille: nullableUint(source.noEliminationRatePerMille, `${field}.noEliminationRatePerMille`),
    earlyMassWipeRounds: uint(source.earlyMassWipeRounds, `${field}.earlyMassWipeRounds`),
    earlyMassWipeRatePerMille: nullableUint(source.earlyMassWipeRatePerMille, `${field}.earlyMassWipeRatePerMille`),
    deadPlayerEliminations: uint(source.deadPlayerEliminations, `${field}.deadPlayerEliminations`),
    deadPlayerResponsesWithinFiveSeconds: uint(source.deadPlayerResponsesWithinFiveSeconds, `${field}.deadPlayerResponsesWithinFiveSeconds`),
    deadPlayerResponseRatePerMille: nullableUint(source.deadPlayerResponseRatePerMille, `${field}.deadPlayerResponseRatePerMille`),
    deadPlayerResponseNote: text(source.deadPlayerResponseNote, `${field}.deadPlayerResponseNote`),
    shareIntentRounds: uint(source.shareIntentRounds, `${field}.shareIntentRounds`),
    shareIntentRatePerMille: nullableUint(source.shareIntentRatePerMille, `${field}.shareIntentRatePerMille`),
    clipExportedRounds: uint(source.clipExportedRounds, `${field}.clipExportedRounds`),
    clipExportRatePerMille: nullableUint(source.clipExportRatePerMille, `${field}.clipExportRatePerMille`),
  }
}

export function parseAuthoritativeMetrics(value: unknown): AuthoritativeMetricsResponse {
  const source = record(value, 'authoritativeMetrics')
  if (!Array.isArray(source.experimentCuts)) {
    throw new TypeError('authoritativeMetrics.experimentCuts must be an array')
  }
  return {
    schemaVersion: text(source.schemaVersion, 'authoritativeMetrics.schemaVersion'),
    windowStartMs: uint(source.windowStartMs, 'authoritativeMetrics.windowStartMs'),
    windowEndMs: uint(source.windowEndMs, 'authoritativeMetrics.windowEndMs'),
    deckId: source.deckId === null ? null : text(source.deckId, 'authoritativeMetrics.deckId'),
    counts: countMap(source.counts, 'authoritativeMetrics.counts'),
    completionRatePerMille: uint(source.completionRatePerMille, 'authoritativeMetrics.completionRatePerMille'),
    ...productMetrics(source, 'authoritativeMetrics'),
    experimentCuts: source.experimentCuts.map((value, index) => {
      const cut = record(value, `authoritativeMetrics.experimentCuts[${index}]`)
      return {
        experimentKey: text(cut.experimentKey, `authoritativeMetrics.experimentCuts[${index}].experimentKey`),
        variant: text(cut.variant, `authoritativeMetrics.experimentCuts[${index}].variant`),
        counts: countMap(cut.counts, `authoritativeMetrics.experimentCuts[${index}].counts`),
        completionRatePerMille: uint(cut.completionRatePerMille, `authoritativeMetrics.experimentCuts[${index}].completionRatePerMille`),
        ...productMetrics(cut, `authoritativeMetrics.experimentCuts[${index}]`),
      }
    }),
  }
}

export async function fetchAuthoritativeMetrics(
  options: FetchAuthoritativeMetricsOptions,
): Promise<AuthoritativeMetricsResponse> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '')
  const token = options.token.trim()
  if (!baseUrl) throw new TypeError('Metrics API base URL is required')
  if (!token) throw new TypeError('Operator metrics token is required')
  const windowHours = options.windowHours ?? 24
  if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
    throw new RangeError('Metrics window must be between 1 and 168 hours')
  }
  const query = new URLSearchParams({ windowHours: String(windowHours) })
  if (options.deckId?.trim()) query.set('deckId', options.deckId.trim())
  const response = await (options.fetch ?? globalThis.fetch)(
    `${baseUrl}/v1/telemetry/metrics?${query}`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    },
  )
  let body: unknown
  try {
    body = await response.json() as unknown
  } catch (error) {
    throw new TypeError('Metrics service returned malformed JSON', { cause: error })
  }
  if (!response.ok) throw new Error(`Metrics service returned HTTP ${response.status}`)
  return parseAuthoritativeMetrics(body)
}
