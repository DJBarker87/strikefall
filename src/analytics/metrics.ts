import type { StrikefallTelemetryEvent } from '../telemetry'

export type MetricStatus = 'pass' | 'fail' | 'insufficient' | 'descriptive'
export type MetricEvidence = 'observed' | 'inferred'
export type RoadmapGate = 'G1' | 'G2' | 'G3' | 'G4'

export interface AlphaMetric {
  id: string
  label: string
  value: number | null
  unit: 'percent' | 'count'
  numerator: number
  denominator: number
  minimumSample: number
  target: string
  status: MetricStatus
  evidence: MetricEvidence
  evidenceNote: string
  roadmap: RoadmapGate
}

export interface AlphaMetricsReport {
  generatedAt: string
  events: number
  sessions: number
  completingSessions: number
  completedRounds: number
  outcomes: {
    survived: number
    eliminated: number
    escaped: number
    unknown: number
  }
  metrics: AlphaMetric[]
}

/** Plan-aligned closed-alpha floor before the <1% session-error gate is judged. */
export const MIN_G4_ERROR_SESSIONS = 50

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function eventTime(event: StrikefallTelemetryEvent) {
  const value = Date.parse(event.at)
  return Number.isFinite(value) ? value : null
}

function roundKey(event: StrikefallTelemetryEvent) {
  return event.roundId ? `${event.sessionId}\u0000${event.roundId}` : null
}

function median(values: readonly number[]) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : sorted[middle] as number
}

function rateMetric(options: {
  id: string
  label: string
  numerator: number
  denominator: number
  minimum: number
  target: string
  minimumSample?: number
  roadmap: RoadmapGate
  evidence?: MetricEvidence
  evidenceNote: string
  descriptive?: boolean
}): AlphaMetric {
  const minimumSample = options.minimumSample ?? 1
  const value = options.denominator > 0 ? options.numerator / options.denominator : null
  return {
    id: options.id,
    label: options.label,
    value,
    unit: 'percent',
    numerator: options.numerator,
    denominator: options.denominator,
    minimumSample,
    target: options.target,
    status: options.denominator < minimumSample
      ? 'insufficient'
      : options.descriptive
        ? 'descriptive'
        : value !== null && value >= options.minimum ? 'pass' : 'fail',
    evidence: options.evidence ?? 'observed',
    evidenceNote: options.evidenceNote,
    roadmap: options.roadmap,
  }
}

function ceilingRateMetric(options: {
  id: string
  label: string
  numerator: number
  denominator: number
  maximumExclusive: number
  target: string
  minimumSample?: number
  roadmap: RoadmapGate
  evidenceNote: string
}): AlphaMetric {
  const minimumSample = options.minimumSample ?? 1
  const value = options.denominator > 0 ? options.numerator / options.denominator : null
  return {
    id: options.id,
    label: options.label,
    value,
    unit: 'percent',
    numerator: options.numerator,
    denominator: options.denominator,
    minimumSample,
    target: options.target,
    status: options.denominator < minimumSample
      ? 'insufficient'
      : value !== null && value < options.maximumExclusive ? 'pass' : 'fail',
    evidence: 'observed',
    evidenceNote: options.evidenceNote,
    roadmap: options.roadmap,
  }
}

function countMetric(options: {
  id: string
  label: string
  value: number | null
  denominator: number
  passes: (value: number) => boolean
  target: string
  minimumSample?: number
  roadmap: RoadmapGate
  evidence?: MetricEvidence
  evidenceNote: string
}): AlphaMetric {
  const minimumSample = options.minimumSample ?? 1
  return {
    id: options.id,
    label: options.label,
    value: options.value,
    unit: 'count',
    numerator: options.value ?? 0,
    denominator: options.denominator,
    minimumSample,
    target: options.target,
    status: options.denominator < minimumSample || options.value === null
      ? 'insufficient'
      : options.passes(options.value) ? 'pass' : 'fail',
    evidence: options.evidence ?? 'observed',
    evidenceNote: options.evidenceNote,
    roadmap: options.roadmap,
  }
}

function latestByRound(
  events: readonly StrikefallTelemetryEvent[],
  name: StrikefallTelemetryEvent['name'],
) {
  const result = new Map<string, StrikefallTelemetryEvent>()
  for (const event of events) {
    const key = roundKey(event)
    if (event.name === name && key) result.set(key, event)
  }
  return result
}

/**
 * Calculates product signals from event observations only. The report does not
 * retain event, session, or round identifiers and is therefore safe to pass to
 * aggregate-only views and exporters.
 */
export function calculateAlphaMetrics(
  events: readonly StrikefallTelemetryEvent[],
  generatedAt = new Date(),
): AlphaMetricsReport {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((left, right) =>
      ((eventTime(left.event) ?? 0) - (eventTime(right.event) ?? 0)) || left.index - right.index)
    .map(({ event }) => event)
  const sessionIds = new Set(ordered.map((event) => event.sessionId))
  const clientErrorSessions = new Set(
    ordered.filter((event) => event.name === 'client_error').map((event) => event.sessionId),
  )

  const completedByRound = latestByRound(ordered, 'round_completed')
  const completed = [...completedByRound.values()]
  const completedBySession = new Map<string, Set<string>>()
  for (const event of completed) {
    const rounds = completedBySession.get(event.sessionId) ?? new Set<string>()
    const key = roundKey(event)
    if (key) rounds.add(key)
    completedBySession.set(event.sessionId, rounds)
  }
  const completingSessions = [...completedBySession.values()]
  const secondRoundSessions = completingSessions.filter((rounds) => rounds.size >= 2).length
  const thirdRoundSessions = completingSessions.filter((rounds) => rounds.size >= 3).length
  const outcomes = completed.reduce<AlphaMetricsReport['outcomes']>((counts, event) => {
    const outcome = event.payload.outcome
    if (outcome === 'survived' || outcome === 'eliminated' || outcome === 'escaped') {
      counts[outcome] += 1
    } else {
      counts.unknown += 1
    }
    return counts
  }, { survived: 0, eliminated: 0, escaped: 0, unknown: 0 })

  const revisions = new Map<string, number>()
  for (const event of ordered) {
    const key = roundKey(event)
    if (event.name !== 'flag_move' || !key) continue
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
  }
  const revisionCounts = [...completedByRound.keys()].map((key) => revisions.get(key) ?? 0)

  const eliminations = [...latestByRound(ordered, 'player_eliminated').values()]
  const retainedDeadPlayers = eliminations.filter((elimination) => {
    const eliminatedAt = eventTime(elimination)
    if (eliminatedAt === null) return false
    return ordered.some((candidate) => {
      if (candidate.sessionId !== elimination.sessionId) return false
      if (candidate.name !== 'spectate_started' && candidate.name !== 'rematch_started') return false
      const at = eventTime(candidate)
      return at !== null && at >= eliminatedAt && at - eliminatedAt <= 5_000
    })
  }).length

  const replayChecks = [...latestByRound(ordered, 'replay_verified').values()]
  const replayPasses = replayChecks.filter((event) => event.payload.success === true).length
  const sharedRounds = new Set(
    ordered.flatMap((event) => {
      const key = roundKey(event)
      return event.name === 'share_opened' && key && completedByRound.has(key) ? [key] : []
    }),
  )
  const clippedRounds = new Set(
    ordered.flatMap((event) => {
      const key = roundKey(event)
      return event.name === 'clip_exported' && key && completedByRound.has(key) ? [key] : []
    }),
  )
  const escapes = completed.filter((event) => event.payload.outcome === 'escaped').length
  const survivorCounts = completed.flatMap((event) => {
    const survivors = finiteNumber(event.payload.survivors)
    return survivors === null ? [] : [survivors]
  })
  const medianSurvivors = median(survivorCounts)
  const placementSpread = [...latestByRound(ordered, 'placement_locked').entries()]
    .filter(([key]) => completedByRound.has(key))
    .flatMap(([, event]) => {
      const upper = finiteNumber(event.payload.lobbyUpper)
      const lower = finiteNumber(event.payload.lobbyLower)
      const bands = finiteNumber(event.payload.lobbyRiskBands)
      return upper === null || lower === null || bands === null ? [] : [{ upper, lower, bands }]
    })
  const spreadRounds = placementSpread.filter(({ upper, lower, bands }) =>
    upper > 0 && lower > 0 && bands >= 6).length
  const eliminationCounts = completed.flatMap((event) => {
    const eliminated = finiteNumber(event.payload.eliminated)
    return eliminated === null ? [] : [eliminated]
  })
  const noEliminationRounds = eliminationCounts.filter((count) => count === 0).length
  const earlyMassWipeRounds = new Set(ordered.flatMap((event) => {
    const key = roundKey(event)
    const size = finiteNumber(event.payload.size)
    const progress = finiteNumber(event.payload.progress)
    return event.name === 'cluster_wipe'
      && key
      && completedByRound.has(key)
      && size !== null
      && size >= 3
      && progress !== null
      && progress <= 1 / 6
      ? [key]
      : []
  }))

  const metrics: AlphaMetric[] = [
    rateMetric({
      id: 'second-round',
      label: 'Same-session second round',
      numerator: secondRoundSessions,
      denominator: completingSessions.length,
      minimum: 0.6,
      target: '≥ 60%',
      minimumSample: 10,
      roadmap: 'G1',
      evidenceNote: 'Observed completed rounds grouped within a local session.',
    }),
    rateMetric({
      id: 'third-round',
      label: 'Same-session third round',
      numerator: thirdRoundSessions,
      denominator: completingSessions.length,
      minimum: 0.35,
      target: '≥ 35%',
      minimumSample: 10,
      roadmap: 'G1',
      evidenceNote: 'Observed completed rounds grouped within a local session.',
    }),
    countMetric({
      id: 'flag-revisions',
      label: 'Median flag revisions',
      value: median(revisionCounts),
      denominator: completed.length,
      passes: (value) => value >= 2,
      target: '≥ 2',
      minimumSample: 10,
      roadmap: 'G1',
      evidenceNote: 'Observed throttled flag-move events per completed round.',
    }),
    rateMetric({
      id: 'dead-player-retention',
      label: 'Dead-player five-second retention',
      numerator: retainedDeadPlayers,
      denominator: eliminations.length,
      minimum: 0.7,
      target: '≥ 70%',
      minimumSample: 10,
      roadmap: 'G1',
      evidence: 'inferred',
      evidenceNote: 'Inferred when spectate or rematch activity follows elimination within five seconds.',
    }),
    countMetric({
      id: 'median-survivors',
      label: 'Median untouched survivors',
      value: medianSurvivors,
      denominator: survivorCounts.length,
      passes: (value) => value >= 2 && value <= 6,
      target: '2–6',
      minimumSample: 24,
      roadmap: 'G1',
      evidenceNote: 'Observed final survivor count on completed rounds.',
    }),
    rateMetric({
      id: 'placement-spread',
      label: 'Healthy lobby placement spread',
      numerator: spreadRounds,
      denominator: placementSpread.length,
      minimum: 0.8,
      target: '≥ 80% use both sides and ≥ 6 risk bands',
      minimumSample: 24,
      roadmap: 'G2',
      evidenceNote: 'Observed aggregate side and risk-band counts at placement lock; no contender positions or identities are retained.',
    }),
    ceilingRateMetric({
      id: 'no-elimination-rate',
      label: 'No-elimination rounds',
      numerator: noEliminationRounds,
      denominator: eliminationCounts.length,
      maximumExclusive: 0.1,
      target: '< 10%',
      minimumSample: 24,
      roadmap: 'G2',
      evidenceNote: 'Observed completed rounds with zero destroyed flags.',
    }),
    ceilingRateMetric({
      id: 'early-mass-wipe-rate',
      label: 'First-10-second mass wipes',
      numerator: earlyMassWipeRounds.size,
      denominator: completed.length,
      maximumExclusive: 0.1,
      target: '< 10%',
      minimumSample: 24,
      roadmap: 'G2',
      evidenceNote: 'Observed completed rounds with a three-or-more flag cluster wipe in the first sixth of battle.',
    }),
    rateMetric({
      id: 'share-intent',
      label: 'Share intent',
      numerator: sharedRounds.size,
      denominator: completed.length,
      minimum: 0.15,
      target: '≥ 15%',
      minimumSample: 10,
      roadmap: 'G4',
      evidence: 'inferred',
      evidenceNote: 'Inferred from opening the share flow; it does not claim a successful external share.',
    }),
    rateMetric({
      id: 'clip-export',
      label: 'Clip export',
      numerator: clippedRounds.size,
      denominator: completed.length,
      minimum: 0,
      target: 'Descriptive',
      minimumSample: 1,
      roadmap: 'G4',
      descriptive: true,
      evidenceNote: 'Observed completed clip exports per completed round.',
    }),
    rateMetric({
      id: 'replay-verification',
      label: 'Replay validity',
      numerator: replayPasses,
      denominator: replayChecks.length,
      minimum: 1,
      target: '100%',
      minimumSample: 1,
      roadmap: 'G3',
      evidenceNote: 'Observed local replay verification results; this is not a server-ranking audit.',
    }),
    rateMetric({
      id: 'escape-uptake',
      label: 'Player Escape uptake',
      numerator: escapes,
      denominator: completed.length,
      minimum: 0,
      target: 'A/B diagnostic',
      minimumSample: 1,
      roadmap: 'G4',
      descriptive: true,
      evidenceNote: 'Observed escaped outcomes. Interpret only beside rematch and retention signals.',
    }),
    ceilingRateMetric({
      id: 'client-error-session-rate',
      label: 'Client-error sessions',
      numerator: clientErrorSessions.size,
      denominator: sessionIds.size,
      maximumExclusive: 0.01,
      target: '< 1%',
      minimumSample: MIN_G4_ERROR_SESSIONS,
      roadmap: 'G4',
      evidenceNote: 'Observed distinct browser telemetry sessions containing at least one bounded client error; this is a session proxy, not a unique-tester or process-crash rate.',
    }),
  ]

  return {
    generatedAt: generatedAt.toISOString(),
    events: ordered.length,
    sessions: sessionIds.size,
    completingSessions: completingSessions.length,
    completedRounds: completed.length,
    outcomes,
    metrics,
  }
}
