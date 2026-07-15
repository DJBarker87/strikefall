import type { ExperimentEnvelope } from '../product/experiments'
import type { StrikefallProfile } from '../product/profile'
import {
  CLIENT_ERROR_CODES,
  CLIENT_ERROR_SURFACES,
  type ClientErrorCode,
  type ClientErrorSurface,
  type StrikefallEventName,
  type StrikefallTelemetryEvent,
} from '../telemetry'
import {
  calculateAlphaMetrics,
  type AlphaMetric,
  type AlphaMetricsReport,
  type RoadmapGate,
} from './metrics'

export const MAX_ALPHA_EVENTS_PER_SOURCE = 500
export const MIN_VARIANT_SUBJECTS = 10

const EVENT_NAMES = new Set<StrikefallEventName>([
  'session_started',
  'tutorial_completed',
  'deck_revealed',
  'approach_viewed',
  'flag_move',
  'flag_side_changed',
  'placement_locked',
  'bot_move_seen',
  'flag_hit',
  'cluster_wipe',
  'escape_unlocked',
  'escape_pressed',
  'player_eliminated',
  'spectate_started',
  'rematch_started',
  'round_completed',
  'replay_verified',
  'share_opened',
  'clip_exported',
  'break_reminder_shown',
  'ranked_degraded_to_practice',
  'practice_paused',
  'practice_resumed',
  'client_error',
])

const CLIENT_ERROR_CODE_NAMES = new Set<ClientErrorCode>(CLIENT_ERROR_CODES)
const CLIENT_ERROR_SURFACE_NAMES = new Set<ClientErrorSurface>(CLIENT_ERROR_SURFACES)

export interface AlphaAnalyticsSource {
  events: readonly StrikefallTelemetryEvent[]
  experiments?: ExperimentEnvelope | null
  profile?: StrikefallProfile | null
}

export interface AlphaDataQuality {
  sourcesProvided: number
  sourcesIncluded: number
  eventsReceived: number
  eventsIncluded: number
  eventsTrimmed: number
  eventsDiscarded: number
  eventLimitPerSource: number
}

export interface AlphaProfileRollup {
  evidence: 'persisted'
  profiles: number
  rounds: number
  held: number
  escaped: number
  eliminated: number
  bestScore: number
}

export interface AlphaOperationalSignals {
  degradedToPractice: number
  replayFailures: number | null
  replayFailureNote: string
  clientErrors: number
  clientErrorSessions: number
  clientErrorRate: number | null
  clientErrorNote: string
}

export type VariantComparisonStatus = 'single-variant' | 'insufficient' | 'descriptive'

export interface AlphaVariantCohort {
  variant: string
  sources: number
  sessions: number
  completingSessions: number
  completedRounds: number
  metrics: AlphaMetric[]
}

export interface AlphaVariantComparison {
  experiment: string
  /** Canonical persisted assignment key, including version. */
  experimentKey: string
  version: number
  status: VariantComparisonStatus
  minimumSubjectsPerVariant: number
  note: string
  cohorts: AlphaVariantCohort[]
}

export type RoadmapSignalStatus = 'passing' | 'needs-attention' | 'insufficient' | 'descriptive'

export interface AlphaRoadmapSignal {
  gate: RoadmapGate
  label: string
  status: RoadmapSignalStatus
  sufficient: number
  total: number
  note: string
}

export interface AlphaSampleSufficiency {
  assessedMetrics: number
  sufficientMetrics: number
  passingMetrics: number
  failingMetrics: number
  insufficientMetrics: number
}

export interface AlphaDashboardReport {
  protocol: 'strikefall/alpha-dashboard/v1'
  generatedAt: string
  combined: AlphaMetricsReport
  dataQuality: AlphaDataQuality
  profiles: AlphaProfileRollup
  operations: AlphaOperationalSignals
  sampleSufficiency: AlphaSampleSufficiency
  roadmap: AlphaRoadmapSignal[]
  variants: AlphaVariantComparison[]
}

interface NormalizedSource {
  events: StrikefallTelemetryEvent[]
  experiments: ExperimentEnvelope | null
  profile: StrikefallProfile | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isClientErrorPayload(payload: Record<string, unknown>): boolean {
  const keys = Object.keys(payload).sort()
  return keys.length === 2
    && keys[0] === 'code'
    && keys[1] === 'surface'
    && typeof payload.code === 'string'
    && CLIENT_ERROR_CODE_NAMES.has(payload.code as ClientErrorCode)
    && typeof payload.surface === 'string'
    && CLIENT_ERROR_SURFACE_NAMES.has(payload.surface as ClientErrorSurface)
}

function isTelemetryEvent(value: unknown): value is StrikefallTelemetryEvent {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !value.id) return false
  if (typeof value.name !== 'string' || !EVENT_NAMES.has(value.name as StrikefallEventName)) return false
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return false
  if (typeof value.sessionId !== 'string' || !value.sessionId) return false
  if (value.roundId !== undefined && typeof value.roundId !== 'string') return false
  if (!isRecord(value.payload)) return false
  return value.name !== 'client_error' || isClientErrorPayload(value.payload)
}

function namespaceEvent(
  event: StrikefallTelemetryEvent,
  sourceIndex: number,
): StrikefallTelemetryEvent {
  const prefix = `source-${sourceIndex}`
  return {
    ...event,
    id: `${prefix}:event`,
    sessionId: `${prefix}:session:${event.sessionId}`,
    roundId: event.roundId ? `${prefix}:round:${event.roundId}` : undefined,
  }
}

function boundedEvents(
  events: readonly StrikefallTelemetryEvent[],
  sourceIndex: number,
) {
  const received = events.length
  const trimmed = Math.max(0, received - MAX_ALPHA_EVENTS_PER_SOURCE)
  const candidates = events.slice(-MAX_ALPHA_EVENTS_PER_SOURCE)
  const accepted: StrikefallTelemetryEvent[] = []
  const seen = new Set<string>()
  let discarded = 0

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate: unknown = candidates[index]
    if (!isTelemetryEvent(candidate) || seen.has(candidate.id)) {
      discarded += 1
      continue
    }
    seen.add(candidate.id)
    accepted.push(namespaceEvent(candidate, sourceIndex))
  }

  return {
    events: accepted.reverse(),
    received,
    trimmed,
    discarded,
  }
}

function safeWhole(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0
}

function safeDimension(value: string) {
  const trimmed = value.trim().slice(0, 64)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed)) return '[redacted]'
  if (/(?:seed|path|subject|session|profile|anon_)/i.test(trimmed)) return '[redacted]'
  return trimmed
}

function rollupProfiles(sources: readonly NormalizedSource[]): AlphaProfileRollup {
  const seen = new Set<string>()
  let profiles = 0
  let rounds = 0
  let held = 0
  let escaped = 0
  let eliminated = 0
  let bestScore = 0

  for (const source of sources) {
    const profile = source.profile
    if (!profile || typeof profile.id !== 'string' || seen.has(profile.id)) continue
    seen.add(profile.id)
    profiles += 1
    rounds += safeWhole(profile.rounds)
    held += safeWhole(profile.survived)
    escaped += safeWhole(profile.escaped)
    eliminated += safeWhole(profile.eliminated)
    bestScore = Math.max(bestScore, safeWhole(profile.bestScore))
  }

  return {
    evidence: 'persisted',
    profiles,
    rounds,
    held,
    escaped,
    eliminated,
    bestScore,
  }
}

function metricById(report: AlphaMetricsReport, id: string) {
  return report.metrics.find((metric) => metric.id === id)
}

function buildVariantComparisons(
  sources: readonly NormalizedSource[],
  generatedAt: Date,
): AlphaVariantComparison[] {
  const experiments = new Map<string, Map<string, Map<string, NormalizedSource>>>()

  for (const source of sources) {
    const envelope = source.experiments
    if (!envelope || typeof envelope.subjectId !== 'string' || !envelope.subjectId || !Array.isArray(envelope.assignments)) continue
    const seenAssignments = new Set<string>()
    for (const assignment of envelope.assignments) {
      if (
        !assignment ||
        typeof assignment.experimentId !== 'string' ||
        !Number.isInteger(assignment.experimentVersion) ||
        assignment.experimentVersion < 1 ||
        typeof assignment.variant !== 'string'
      ) continue
      const experiment = safeDimension(assignment.experimentId)
      const variant = safeDimension(assignment.variant)
      if (experiment === '[redacted]' || variant === '[redacted]') continue
      const experimentKey = `${experiment}:v${assignment.experimentVersion}`
      const assignmentKey = `${experimentKey}:${variant}`
      if (seenAssignments.has(assignmentKey)) continue
      seenAssignments.add(assignmentKey)
      const cohorts = experiments.get(experimentKey) ?? new Map<string, Map<string, NormalizedSource>>()
      const cohort = cohorts.get(variant) ?? new Map<string, NormalizedSource>()
      const previous = cohort.get(envelope.subjectId)
      if (!previous || source.events.length > previous.events.length) {
        cohort.set(envelope.subjectId, source)
      }
      cohorts.set(variant, cohort)
      experiments.set(experimentKey, cohorts)
    }
  }

  return [...experiments.entries()].map(([experimentKey, grouped]) => {
    const separator = experimentKey.lastIndexOf(':v')
    const experiment = experimentKey.slice(0, separator)
    const version = Number(experimentKey.slice(separator + 2))
    const cohorts = [...grouped.entries()].map(([variant, cohortSubjects]) => {
      const cohortSources = [...cohortSubjects.values()]
      const report = calculateAlphaMetrics(
        cohortSources.flatMap((source) => source.events),
        generatedAt,
      )
      return {
        variant,
        sources: cohortSources.length,
        sessions: report.sessions,
        completingSessions: report.completingSessions,
        completedRounds: report.completedRounds,
        metrics: report.metrics,
      }
    }).sort((left, right) => left.variant.localeCompare(right.variant))

    const status: VariantComparisonStatus = cohorts.length < 2
      ? 'single-variant'
      : cohorts.every((cohort) =>
        cohort.sources >= MIN_VARIANT_SUBJECTS &&
        cohort.completingSessions >= MIN_VARIANT_SUBJECTS)
        ? 'descriptive'
        : 'insufficient'

    return {
      experiment,
      experimentKey,
      version,
      status,
      minimumSubjectsPerVariant: MIN_VARIANT_SUBJECTS,
      note: status === 'single-variant'
        ? 'Only one assigned variant is present in this local sample.'
        : status === 'insufficient'
          ? `Wait for at least ${MIN_VARIANT_SUBJECTS} subjects with completed rounds in every variant.`
          : 'Observed cohort differences only; no causal winner is inferred.',
      cohorts,
    }
  }).sort((left, right) => left.experiment.localeCompare(right.experiment) || left.version - right.version)
}

function gateSignal(
  gate: RoadmapGate,
  label: string,
  metrics: readonly AlphaMetric[],
  note: string,
  forceDescriptive = false,
): AlphaRoadmapSignal {
  const assessed = metrics.filter((metric) => metric.status !== 'descriptive')
  const sufficient = assessed.filter((metric) => metric.status !== 'insufficient').length
  const status: RoadmapSignalStatus = forceDescriptive
    ? 'descriptive'
    : assessed.length === 0 || sufficient === 0
      ? 'insufficient'
      : assessed.some((metric) => metric.status === 'fail')
        ? 'needs-attention'
        : sufficient < assessed.length ? 'insufficient' : 'passing'
  return { gate, label, status, sufficient, total: assessed.length, note }
}

function roadmapSignals(report: AlphaMetricsReport): AlphaRoadmapSignal[] {
  const metrics = (ids: readonly string[]) => ids.flatMap((id) => {
    const metric = metricById(report, id)
    return metric ? [metric] : []
  })
  return [
    gateSignal(
      'G1',
      'Fun loop',
      metrics(['second-round', 'third-round', 'flag-revisions', 'dead-player-retention', 'median-survivors']),
      'Telemetry supports the gate; observed-player sessions are still required.',
    ),
    gateSignal(
      'G2',
      'Balance & pacing',
      metrics(['placement-spread', 'no-elimination-rate', 'early-mass-wipe-rate']),
      'Observed pacing supports this gate; deterministic-math correctness remains owned by the reference and WASM suites.',
    ),
    gateSignal(
      'G3',
      'Replay trust',
      metrics(['replay-verification']),
      'Local replay validity does not by itself prove server-authoritative ranking.',
    ),
    gateSignal(
      'G4',
      'Closed alpha',
      metrics(['share-intent', 'clip-export', 'escape-uptake', 'client-error-session-rate']),
      'The <1% client-error-session gate is assessed only after 50 observed sessions; share and Escape signals remain product observations.',
    ),
  ]
}

/**
 * Aggregates one or more bounded local snapshots. Identifier names are replaced
 * before metrics are calculated, and no raw event payload is returned.
 */
export function calculateAlphaDashboardReport(
  input: readonly AlphaAnalyticsSource[],
  generatedAt = new Date(),
): AlphaDashboardReport {
  let eventsReceived = 0
  let eventsTrimmed = 0
  let eventsDiscarded = 0
  const sources = input.map((source, index): NormalizedSource => {
    const bounded = boundedEvents(source.events, index)
    eventsReceived += bounded.received
    eventsTrimmed += bounded.trimmed
    eventsDiscarded += bounded.discarded
    return {
      events: bounded.events,
      experiments: source.experiments ?? null,
      profile: source.profile ?? null,
    }
  })
  const combinedEvents = sources.flatMap((source) => source.events)
  const combined = calculateAlphaMetrics(combinedEvents, generatedAt)
  const replayMetric = metricById(combined, 'replay-verification')
  const assessed = combined.metrics.filter((metric) => metric.status !== 'descriptive')
  const clientErrorEvents = combinedEvents.filter((event) => event.name === 'client_error')
  const clientErrorSessions = new Set(clientErrorEvents.map((event) => event.sessionId)).size
  const clientErrorRate = combined.sessions > 0
    ? clientErrorSessions / combined.sessions
    : null

  return {
    protocol: 'strikefall/alpha-dashboard/v1',
    generatedAt: generatedAt.toISOString(),
    combined,
    dataQuality: {
      sourcesProvided: input.length,
      sourcesIncluded: sources.filter((source) =>
        source.events.length > 0 || source.profile || source.experiments).length,
      eventsReceived,
      eventsIncluded: combinedEvents.length,
      eventsTrimmed,
      eventsDiscarded,
      eventLimitPerSource: MAX_ALPHA_EVENTS_PER_SOURCE,
    },
    profiles: rollupProfiles(sources),
    operations: {
      degradedToPractice: combinedEvents.filter((event) =>
        event.name === 'ranked_degraded_to_practice').length,
      replayFailures: replayMetric
        ? replayMetric.denominator > 0
          ? Math.max(0, replayMetric.denominator - replayMetric.numerator)
          : null
        : null,
      replayFailureNote: replayMetric && replayMetric.denominator > 0
        ? 'Observed failed replay checks.'
        : 'No replay checks were observed; zero is not inferred.',
      clientErrors: clientErrorEvents.length,
      clientErrorSessions,
      clientErrorRate,
      clientErrorNote: clientErrorRate === null
        ? 'No telemetry sessions were observed, so the <1% error target is unassessed.'
        : `${clientErrorSessions}/${combined.sessions} observed telemetry sessions reported a bounded client error (${(clientErrorRate * 100).toFixed(1)}%; target <1%; assessed after 50 sessions).`,
    },
    sampleSufficiency: {
      assessedMetrics: assessed.length,
      sufficientMetrics: assessed.filter((metric) => metric.status !== 'insufficient').length,
      passingMetrics: assessed.filter((metric) => metric.status === 'pass').length,
      failingMetrics: assessed.filter((metric) => metric.status === 'fail').length,
      insufficientMetrics: assessed.filter((metric) => metric.status === 'insufficient').length,
    },
    roadmap: roadmapSignals(combined),
    variants: buildVariantComparisons(sources, generatedAt),
  }
}

export function alphaMetric(
  report: AlphaMetricsReport,
  id: string,
) {
  return metricById(report, id) ?? null
}
