import type { Contender, FeedEvent, RoundState } from '../game/types'
import { PHASE_DURATIONS } from '../game/round'
import {
  selectRelevantRoundRival,
  type RelevantRoundRival,
  type RivalryShareContext,
} from '../product/rivalry'
import type {
  BotRivalryMoment,
  ClusterWipeMoment,
  DramaticMoment,
  EscapeRegretMoment,
  EscapeSaveMoment,
  GreedHoldMoment,
  NearMissMoment,
  PerfectEscapeMoment,
  ShareRoundInput,
} from './types'

const NEAR_MISS_BASIS_POINTS = 35
const NEAR_MISS_MARGIN_FRACTION = 0.14
const LATE_HIT_PROGRESS = 0.9
const GREED_RISK = 5

const KIND_ORDER: Readonly<Record<DramaticMoment['kind'], number>> = {
  'perfect-escape': 7,
  'escape-save': 6,
  'greed-hold': 5,
  'escape-regret': 4,
  'near-miss': 3,
  'cluster-wipe': 2,
  'bot-rivalry': 1,
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function roundNumber(value: number, places = 2): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

function playerOf(round: ShareRoundInput): Contender | undefined {
  return round.contenders.find((contender) => contender.isPlayer)
}

function detectNearMiss(round: ShareRoundInput, player: Contender): NearMissMoment | null {
  const summary = round.summary
  if (!summary) return null
  const reference = Math.max(1, Math.abs(player.barrier), Math.abs(round.lineValue))
  const basisPoints = (summary.closestApproach / reference) * 10_000
  const marginFraction = summary.closestApproach / Math.max(player.distance, Number.EPSILON)
  const finalBattleStep = Math.max(0, round.battlePath.length - 1)
  const closestApproachStep = Number.isInteger(player.closestApproachStep)
    && (player.closestApproachStep ?? -1) >= 0
    && (player.closestApproachStep ?? Number.POSITIVE_INFINITY) <= finalBattleStep
    ? player.closestApproachStep as number
    : null

  if (
    summary.outcome === 'survived' &&
    (basisPoints <= NEAR_MISS_BASIS_POINTS || marginFraction <= NEAR_MISS_MARGIN_FRACTION)
  ) {
    const marginPercent = roundNumber(summary.closestApproach / reference * 100, 3)
    return {
      kind: 'near-miss',
      impact: Math.round(clamp(92 - basisPoints * 0.2, 82, 94)),
      kicker: 'NEAR MISS',
      title: 'THE LINE MISSED BY A BREATH.',
      detail: `${marginPercent.toFixed(3)}% between your flag and impact.`,
      accent: 'primary',
      at: closestApproachStep === null || finalBattleStep === 0
        ? null
        : closestApproachStep / finalBattleStep,
      outcome: 'held',
      closestApproach: summary.closestApproach,
      closestApproachStep,
      marginPercent,
    }
  }

  if (summary.outcome === 'eliminated' && (player.hitAt ?? 0) >= LATE_HIT_PROGRESS) {
    const hitAt = clamp(player.hitAt ?? 1, 0, 1)
    return {
      kind: 'near-miss',
      impact: Math.round(84 + hitAt * 10),
      kicker: 'SECONDS FROM GLORY',
      title: 'THE LINE FOUND YOU LATE.',
      detail: `Your flag held through ${(hitAt * 100).toFixed(0)}% of the storm.`,
      accent: 'danger',
      at: hitAt,
      outcome: 'late-hit',
      closestApproach: 0,
      closestApproachStep: player.closestApproachStep
        ?? Math.round(hitAt * finalBattleStep),
      marginPercent: 0,
    }
  }

  return null
}

function detectGreedHold(round: ShareRoundInput, player: Contender): GreedHoldMoment | null {
  const summary = round.summary
  if (!summary || summary.outcome !== 'survived' || summary.multiplier < GREED_RISK) return null
  return {
    kind: 'greed-hold',
    impact: Math.round(clamp(88 + (summary.multiplier - GREED_RISK) * 2, 88, 98)),
    kicker: 'GREED HOLD',
    title: 'MAX RISK. ZERO FLINCH.',
    detail: `${summary.multiplier.toFixed(1)}× risk survived the full path.`,
    accent: 'success',
    at: 1,
    risk: player.risk,
    score: summary.score,
    rank: summary.rank,
  }
}

function detectEscape(
  round: ShareRoundInput,
): EscapeRegretMoment | EscapeSaveMoment | PerfectEscapeMoment | null {
  const summary = round.summary
  const escape = summary?.escape
  if (!summary || summary.outcome !== 'escaped' || !escape) return null

  if (escape.holdOutcome === 'would-hit') {
    if (
      escape.holdHitAt === null
      || !Number.isFinite(escape.holdHitAt)
      || escape.holdHitAt < escape.at
    ) return null
    const rawDelayProgress = clamp(escape.holdHitAt - escape.at, 0, 1)
    const rawDelaySeconds = rawDelayProgress * PHASE_DURATIONS.battle / 1_000
    const delayProgress = roundNumber(rawDelayProgress, 9)
    const delaySeconds = roundNumber(
      rawDelaySeconds,
      6,
    )
    const common = {
      at: escape.at,
      bankedScore: escape.bankedScore,
      strikeDelayProgress: delayProgress,
      strikeDelaySeconds: delaySeconds,
      escapeProbability: escape.survivalProbability,
    }
    // Accommodate only IEEE-754 noise at exactly 1.0; any meaningful value above it is generic.
    if (rawDelaySeconds <= 1 + Number.EPSILON * 32) {
      return {
        kind: 'perfect-escape',
        impact: Math.round(clamp(99 - delaySeconds, 98, 99)),
        kicker: 'PERFECT ESCAPE',
        title: delaySeconds === 0 ? 'ESCAPED AT THE STRIKE.' : 'ONE SECOND OR LESS TO SPARE.',
        detail: `${Math.round(escape.bankedScore).toLocaleString('en-US')} points secured just before impact.`,
        accent: 'success',
        ...common,
      }
    }
    return {
      kind: 'escape-save',
      impact: Math.round(clamp(94 - delaySeconds * 0.25, 86, 93)),
      kicker: 'ESCAPE SAVE',
      title: 'BANKED BEFORE THE STRIKE.',
      detail: `${Math.round(escape.bankedScore).toLocaleString('en-US')} points saved; impact came ${delaySeconds.toFixed(delaySeconds < 10 ? 1 : 0)}s later.`,
      accent: 'primary',
      ...common,
    }
  }

  if (escape.holdOutcome === 'would-survive') {
    const leftBehind = Math.max(0, escape.terminalScore - escape.bankedScore)
    return {
      kind: 'escape-regret',
      impact: Math.round(clamp(84 + leftBehind / Math.max(1, escape.terminalScore) * 12, 84, 96)),
      kicker: 'ESCAPE REGRET',
      title: 'SAFE SCORE. THE FLAG WOULD HAVE HELD.',
      detail: `${Math.round(leftBehind).toLocaleString('en-US')} points stayed on the line.`,
      accent: 'violet',
      at: escape.at,
      bankedScore: escape.bankedScore,
      scoreLeftBehind: leftBehind,
      escapeProbability: escape.survivalProbability,
    }
  }

  return null
}

function clusterMoments(round: ShareRoundInput): ClusterWipeMoment[] {
  return round.feed
    .filter((event): event is FeedEvent => event.type === 'cluster' && event.contenderIds.length >= 3)
    .map((event) => {
      const size = event.contenderIds.length
      const playerInvolved = event.contenderIds.includes('player')
      return {
        kind: 'cluster-wipe' as const,
        impact: Math.round(clamp(72 + size * 4 + (playerInvolved ? 5 : 0), 80, 99)),
        kicker: 'CLUSTER WIPE',
        title: `${size} FLAGS. ONE STRIKE.`,
        detail: playerInvolved
          ? 'Your flag fell with the whole neighbourhood.'
          : 'A crowded lane disappeared in one move.',
        accent: 'strike' as const,
        at: clamp(event.at, 0, 1),
        size,
        playerInvolved,
        sequence: event.sequence,
      }
    })
}

function matchedRivalryContext(
  selection: RelevantRoundRival,
  context: RivalryShareContext | null | undefined,
): RivalryShareContext | null {
  if (
    !context
    || context.rivalName !== selection.contender.name
    || context.rivalPersona !== selection.contender.persona
  ) return null
  return {
    ...context,
    playerWins: Math.max(0, Math.round(Number.isFinite(context.playerWins) ? context.playerWins : 0)),
    playerLosses: Math.max(0, Math.round(Number.isFinite(context.playerLosses) ? context.playerLosses : 0)),
    copyEncounters: Math.max(0, Math.round(Number.isFinite(context.copyEncounters) ? context.copyEncounters : 0)),
  }
}

function seriesCopy(context: RivalryShareContext | null): string | null {
  if (!context || context.playerWins + context.playerLosses < 2) return null
  if (context.playerLosses > context.playerWins) {
    return `${context.rivalName} owns me ${context.playerLosses}–${context.playerWins}`
  }
  if (context.playerWins > context.playerLosses) {
    return `I own ${context.rivalName} ${context.playerWins}–${context.playerLosses}`
  }
  return `${context.rivalName} and I are tied ${context.playerWins}–${context.playerLosses}`
}

function rivalryMoment(
  round: ShareRoundInput,
  context?: RivalryShareContext | null,
): BotRivalryMoment | null {
  const selection = selectRelevantRoundRival(round)
  if (!selection) return null
  const rival = selection.contender
  const history = matchedRivalryContext(selection, context)
  const persistentCopy = seriesCopy(history)
  const copyEncounters = history?.copyEncounters ?? 0
  const copyDetail = copyEncounters > 0
    ? ` Copied my flag ${copyEncounters === 1 ? 'once' : `${copyEncounters} times`}.`
    : ''
  const historyImpact = persistentCopy ? Math.min(97, 91 + history!.playerWins + history!.playerLosses) : 0

  if (selection.relation === 'shared-wipe') {
    return {
      kind: 'bot-rivalry',
      impact: Math.max(86, historyImpact),
      kicker: 'RIVALRY',
      title: persistentCopy ? `${persistentCopy}.` : `YOU AND ${rival.name.toUpperCase()} FELL TOGETHER.`,
      detail: `${rival.persona} pressure ended in the same strike.${copyDetail}`,
      accent: 'violet',
      at: selection.eventAt,
      rivalName: rival.name,
      rivalPersona: rival.persona,
      relation: 'fell-together',
      seriesCopy: persistentCopy,
      copyEncounters,
    }
  }

  if (selection.relation === 'copied-player') {
    return {
      kind: 'bot-rivalry',
      impact: Math.max(80, historyImpact),
      kicker: 'FLAG SHADOW',
      title: persistentCopy ? `${persistentCopy}.` : `${rival.name.toUpperCase()} COPIED YOUR AIRSPACE.`,
      detail: `Mimic pressure stayed beside your flag.${copyDetail}`,
      accent: 'violet',
      at: null,
      rivalName: rival.name,
      rivalPersona: rival.persona,
      relation: 'copied-player',
      seriesCopy: persistentCopy,
      copyEncounters,
    }
  }

  const isRanked = selection.relation === 'rank-neighbour'
  return {
    kind: 'bot-rivalry',
    impact: Math.max(isRanked ? 72 : 68, historyImpact),
    kicker: isRanked ? 'RANK DUEL' : 'NEAREST FLAG',
    title: persistentCopy
      ? `${persistentCopy}.`
      : isRanked
        ? `${rival.name.toUpperCase()} WAS ${Math.abs(selection.rivalRank - selection.playerRank)} PLACE${Math.abs(selection.rivalRank - selection.playerRank) === 1 ? '' : 'S'} AWAY.`
        : `${rival.name.toUpperCase()} PLANTED NEAREST.`,
    detail: `${rival.persona} pressure followed you to the result.${copyDetail}`,
    accent: 'violet',
    at: round.summary ? 1 : null,
    rivalName: rival.name,
    rivalPersona: rival.persona,
    relation: isRanked ? 'rank-duel' : 'nearest-placement',
    seriesCopy: persistentCopy,
    copyEncounters,
  }
}

export function detectDramaticMoments(
  round: ShareRoundInput,
  rivalry?: RivalryShareContext | null,
): DramaticMoment[] {
  const moments: DramaticMoment[] = [...clusterMoments(round)]
  const player = playerOf(round)
  if (player) {
    const candidates = [
      detectNearMiss(round, player),
      detectGreedHold(round, player),
      detectEscape(round),
      rivalryMoment(round, rivalry),
    ]
    for (const candidate of candidates) if (candidate) moments.push(candidate)
  }
  return moments.sort(
    (left, right) =>
      right.impact - left.impact ||
      KIND_ORDER[right.kind] - KIND_ORDER[left.kind] ||
      (left.at ?? 1) - (right.at ?? 1),
  )
}

export function selectPrimaryDramaticMoment(
  round: ShareRoundInput,
  rivalry?: RivalryShareContext | null,
): DramaticMoment | null {
  return detectDramaticMoments(round, rivalry)[0] ?? null
}

export function isShareableResult(round: Pick<RoundState, 'phase' | 'summary'>): boolean {
  return round.phase === 'result' && round.summary !== null
}
