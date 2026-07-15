import type {
  ContenderOutcome,
  HexString,
  ReplayBundle,
  SignedRoundEvent,
  UnsignedDecimalString,
} from '../ranked/types'
import type { RankedReplayVerificationReport } from '../ranked/verifier'

export interface ReplayDecimalDisplay {
  /** Canonical wire value. Never rounded or converted to Number. */
  readonly raw: UnsignedDecimalString
  /** Presentation-only derivative of `raw`. */
  readonly display: string
}

export interface ReplayFingerprint {
  readonly raw: HexString
  readonly display: string
}

export interface ReplayStandingView {
  readonly contenderId: number
  readonly name: string
  readonly rank: number
  readonly outcome: ContenderOutcome
  readonly score: ReplayDecimalDisplay
  readonly closestApproach: ReplayDecimalDisplay
  readonly touchStep: number | null
  readonly isPlayer: boolean
}

export type ReplayTimelineKind = 'hit' | 'cluster' | 'escape'

export interface ReplayTimelineItem {
  readonly key: string
  readonly kind: ReplayTimelineKind
  readonly sequence: number
  readonly step: number
  readonly title: string
  readonly detail: string
  readonly relativeTime: string
  readonly digest: ReplayFingerprint
  readonly signature: ReplayFingerprint
}

export interface ReplayBotCandidateView {
  readonly candidateNumber: number
  readonly side: 'upper' | 'lower'
  readonly survival: string
  readonly barrier: ReplayDecimalDisplay
  readonly crowd: ReplayDecimalDisplay
  readonly terminalScore: ReplayDecimalDisplay
  readonly utility: string
  readonly selected: boolean
}

export interface ReplayBotDecisionView {
  readonly decisionNumber: number
  readonly decisionTime: string
  readonly observationTime: string
  readonly reactionLatency: string
  readonly candidateCount: number
  readonly selectedSide: 'upper' | 'lower'
  readonly selectedBarrier: ReplayDecimalDisplay
  readonly selectedUtility: string
  readonly reason: string
  readonly publicState: ReplayFingerprint
  readonly entropy: ReplayFingerprint
  readonly candidates: readonly ReplayBotCandidateView[]
}

export interface ReplayBotAuditView {
  readonly contenderId: number
  readonly name: string
  readonly persona: string
  readonly botLabel: 'BOT'
  readonly decisions: readonly ReplayBotDecisionView[]
}

export interface RankedReplayViewModel {
  readonly roundId: string
  readonly protocolVersion: string
  readonly experiments: readonly {
    readonly key: string
    readonly variant: string
  }[]
  readonly deck: {
    readonly id: string
    readonly version: number
    readonly displayName: string
    readonly duration: string
    readonly calibration: ReplayFingerprint
  }
  readonly player: ReplayStandingView
  readonly result: {
    readonly outcome: ContenderOutcome
    readonly score: ReplayDecimalDisplay
    readonly rank: number
    readonly fieldSize: number
    readonly survivors: number
    readonly closestApproach: ReplayDecimalDisplay
  }
  readonly proof: {
    readonly commitment: ReplayFingerprint
    readonly serverKey: ReplayFingerprint
    readonly result: ReplayFingerprint
    readonly eventCount: number
    readonly browserCheckCount: number
    readonly regenerationCheckCount: number
    readonly verifier: string
    readonly acknowledged: boolean
  }
  readonly standings: readonly ReplayStandingView[]
  readonly timeline: readonly ReplayTimelineItem[]
  readonly botAudit: readonly ReplayBotAuditView[]
  readonly path: {
    readonly approachPoints: number
    readonly battlePoints: number
    readonly initial: ReplayDecimalDisplay
    readonly final: ReplayDecimalDisplay
    readonly low: ReplayDecimalDisplay
    readonly high: ReplayDecimalDisplay
    readonly digest: ReplayFingerprint
  }
  readonly reveal: {
    readonly pathSeed: string
    readonly salt: ReplayFingerprint
    readonly botSeedRoot: ReplayFingerprint
    readonly deckDigest: ReplayFingerprint
    readonly pathDigest: ReplayFingerprint
  }
}

function groupWholeDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Formats SCALE=1e12 fixed text without passing the proof value through Number. */
export function formatReplayFixed(value: UnsignedDecimalString, fractionDigits: number): string {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 12) {
    throw new RangeError('fractionDigits must be an integer between zero and twelve')
  }
  const raw = BigInt(value)
  const divisor = 10n ** BigInt(12 - fractionDigits)
  const rounded = (raw + divisor / 2n) / divisor
  if (fractionDigits === 0) return groupWholeDigits(rounded.toString())
  const displayScale = 10n ** BigInt(fractionDigits)
  const whole = rounded / displayScale
  const fraction = (rounded % displayScale).toString().padStart(fractionDigits, '0')
  return `${groupWholeDigits(whole.toString())}.${fraction}`
}

function formatSignedFixed(value: string, fractionDigits: number): string {
  const fixed = BigInt(value)
  const negative = fixed < 0n
  const absolute = (negative ? -fixed : fixed) as bigint
  const formatted = formatReplayFixed(absolute.toString() as UnsignedDecimalString, fractionDigits)
  return `${negative ? '−' : ''}${formatted}`
}

function formatProbability(value: UnsignedDecimalString): string {
  const tenths = (BigInt(value) * 1_000n + 500_000_000_000n) / 1_000_000_000_000n
  return `${tenths / 10n}.${tenths % 10n}%`
}

function humanReason(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

export function replayFingerprint(value: HexString): ReplayFingerprint {
  return { raw: value, display: `${value.slice(0, 8)}…${value.slice(-6)}` }
}

function decimal(value: UnsignedDecimalString, fractionDigits: number): ReplayDecimalDisplay {
  return { raw: value, display: formatReplayFixed(value, fractionDigits) }
}

function sideLabel(side: 'upper' | 'lower'): string {
  return `${side[0].toUpperCase()}${side.slice(1)}`
}

function relativeTime(event: SignedRoundEvent, startMs: number): string {
  const elapsed = Math.max(0, event.serverTimeMs - startMs)
  const whole = Math.floor(elapsed / 1_000)
  const tenths = Math.floor((elapsed % 1_000) / 100)
  return `+${whole}.${tenths}s`
}

function timelineFromEvents(bundle: ReplayBundle): readonly ReplayTimelineItem[] {
  const names = new Map(bundle.result.contenders.map((contender) => [
    contender.contenderId,
    contender.name,
  ]))
  const startMs = bundle.events[0]?.serverTimeMs ?? 0
  const timeline: ReplayTimelineItem[] = []

  for (const event of bundle.events) {
    const common = {
      sequence: event.sequence,
      relativeTime: relativeTime(event, startMs),
      digest: replayFingerprint(event.digest),
      signature: replayFingerprint(event.signature),
    }
    if (event.kind.type === 'flag_hit') {
      const { touch } = event.kind.data
      const name = names.get(touch.contenderId) ?? `Contender ${touch.contenderId}`
      timeline.push({
        ...common,
        key: `hit-${event.sequence}`,
        kind: 'hit',
        step: touch.step,
        title: `${name} was struck`,
        detail: `${sideLabel(touch.side)} flag at ${formatReplayFixed(touch.barrier, 2)} · line ${formatReplayFixed(touch.lineValue, 2)}`,
      })
    } else if (event.kind.type === 'flag_cluster') {
      const { cluster } = event.kind.data
      const contenders = cluster.contenderIds.map((id) => names.get(id) ?? `#${id}`)
      timeline.push({
        ...common,
        key: `cluster-${event.sequence}`,
        kind: 'cluster',
        step: cluster.step,
        title: `${cluster.contenderIds.length}-flag collision`,
        detail: contenders.join(' · '),
      })
    } else if (event.kind.type === 'escape_accepted') {
      const { contenderId, actor, escape } = event.kind.data
      const name = names.get(contenderId) ?? `Contender ${contenderId}`
      timeline.push({
        ...common,
        key: `escape-${event.sequence}`,
        kind: 'escape',
        step: escape.step,
        title: `${name} banked an Escape`,
        detail: `${actor === 'player' ? 'Player' : 'Bot'} decision · ${formatReplayFixed(escape.bankedScore, 0)} points`,
      })
    }
  }
  return timeline
}

function durationLabel(bundle: ReplayBundle): string {
  const totalMs = (bundle.deck.approachSteps + bundle.deck.battleSteps) * bundle.deck.stepMs
  const seconds = Math.floor(totalMs / 1_000)
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return minutes > 0 ? `${minutes}m ${remaining.toString().padStart(2, '0')}s` : `${seconds}s`
}

export function deriveRankedReplayView(
  bundle: ReplayBundle,
  verification: RankedReplayVerificationReport,
): RankedReplayViewModel {
  if (!verification.valid) throw new TypeError('Only a verified replay can be rendered.')
  const standings = [...bundle.result.contenders]
    .sort((left, right) => left.rank - right.rank || left.contenderId - right.contenderId)
    .map((contender): ReplayStandingView => ({
      contenderId: contender.contenderId,
      name: contender.name,
      rank: contender.rank,
      outcome: contender.outcome,
      score: decimal(contender.score, 0),
      closestApproach: decimal(contender.closestApproach, 2),
      touchStep: contender.touchStep,
      isPlayer: contender.contenderId === 0,
    }))
  const player = standings.find(({ isPlayer }) => isPlayer)
  if (player === undefined) throw new TypeError('Verified replay has no player standing.')

  const points = [...bundle.path.approach, ...bundle.path.battle]
  const prices = points.map(({ price }) => price)
  const initial = bundle.initialSpot
  const final = prices.at(-1) ?? initial
  const low = prices.reduce(
    (minimum, price) => BigInt(price) < BigInt(minimum) ? price : minimum,
    initial,
  )
  const high = prices.reduce(
    (maximum, price) => BigInt(price) > BigInt(maximum) ? price : maximum,
    initial,
  )
  const botNames = new Map(bundle.bots.map((bot) => [bot.contenderId, bot.name]))
  const botAudit = [...new Set(bundle.botPlacementDecisions.map(({ contenderId }) => contenderId))]
    .sort((left, right) => left - right)
    .map((contenderId): ReplayBotAuditView => {
      const decisions = bundle.botPlacementDecisions
        .filter((decision) => decision.contenderId === contenderId)
        .sort((left, right) => left.decisionNumber - right.decisionNumber)
        .map((decision): ReplayBotDecisionView => ({
          decisionNumber: decision.decisionNumber,
          decisionTime: `+${(decision.decisionTimeMs / 1_000).toFixed(2)}s`,
          observationTime: `+${(decision.observationTimeMs / 1_000).toFixed(2)}s`,
          reactionLatency: `${decision.reactionLatencyMs} ms`,
          candidateCount: decision.candidateCount,
          selectedSide: decision.placement.side,
          selectedBarrier: decimal(decision.placement.barrier, 2),
          selectedUtility: formatSignedFixed(decision.selectedUtility, 2),
          reason: humanReason(decision.reasonCode),
          publicState: replayFingerprint(decision.publicInputsDigest),
          entropy: replayFingerprint(decision.entropyDigest),
          candidates: decision.candidates.map((candidate): ReplayBotCandidateView => ({
            candidateNumber: candidate.candidateNumber,
            side: candidate.side,
            survival: formatProbability(candidate.quotedSurvival),
            barrier: decimal(candidate.barrier, 2),
            crowd: decimal(candidate.projectedCrowdFactor, 2),
            terminalScore: decimal(candidate.terminalScore, 0),
            utility: formatSignedFixed(candidate.utility, 2),
            selected: candidate.candidateNumber === decision.selectedCandidate,
          })),
        }))
      return {
        contenderId,
        name: botNames.get(contenderId) ?? `Bot ${contenderId}`,
        persona: decisions.length > 0
          ? bundle.botPlacementDecisions.find((decision) => decision.contenderId === contenderId)?.persona.replaceAll('_', ' ') ?? 'bot'
          : 'bot',
        botLabel: 'BOT',
        decisions,
      }
    })

  return {
    roundId: bundle.roundId,
    protocolVersion: bundle.protocolVersion,
    experiments: Object.entries(bundle.experimentAssignments)
      .map(([key, variant]) => ({ key, variant }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    deck: {
      id: bundle.deck.id,
      version: bundle.deck.version,
      displayName: bundle.deck.displayName,
      duration: durationLabel(bundle),
      calibration: replayFingerprint(bundle.deck.calibrationDigest),
    },
    player,
    result: {
      outcome: bundle.result.outcome,
      score: decimal(bundle.result.score, 0),
      rank: bundle.result.rank,
      fieldSize: standings.length,
      survivors: bundle.result.survivors,
      closestApproach: decimal(bundle.result.closestApproach, 2),
    },
    proof: {
      commitment: replayFingerprint(bundle.commitment),
      serverKey: replayFingerprint(bundle.serverVerifyingKey),
      result: replayFingerprint(bundle.result.proofDigest),
      eventCount: bundle.events.length,
      browserCheckCount: verification.browserChecks.length,
      regenerationCheckCount: verification.delegatedChecks.length,
      verifier: verification.regenerationVerifier,
      acknowledged: bundle.replayVerification?.proofDigest === bundle.result.proofDigest,
    },
    standings,
    timeline: timelineFromEvents(bundle),
    botAudit,
    path: {
      approachPoints: bundle.path.approach.length,
      battlePoints: bundle.path.battle.length,
      initial: decimal(initial, 2),
      final: decimal(final, 2),
      low: decimal(low, 2),
      high: decimal(high, 2),
      digest: replayFingerprint(bundle.reveal.pathDigest),
    },
    reveal: {
      pathSeed: bundle.reveal.pathSeed,
      salt: replayFingerprint(bundle.reveal.salt),
      botSeedRoot: replayFingerprint(bundle.reveal.botSeedRoot),
      deckDigest: replayFingerprint(bundle.reveal.deckDigest),
      pathDigest: replayFingerprint(bundle.reveal.pathDigest),
    },
  }
}
