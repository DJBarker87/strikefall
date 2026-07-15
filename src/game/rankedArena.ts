import { scoringEngineDigest } from '../engine'
import type {
  ContenderPlacement as RankedPlacement,
  CreateRoundResponse,
  Deck as RankedDeck,
  EscapeRecord as RankedEscape,
  LockedScore,
  ReplayBundle as RankedReplayBundle,
  RoundEventKind,
  SignedRoundEvent,
} from '../ranked'
import { RANKED_LOCK_PHASE_MS } from '../ranked'
import { getDeck } from './decks'
import type {
  BotMove,
  Candle,
  Contender,
  DeckDefinition,
  EscapeRecord,
  FeedEvent,
  Persona,
  RoundState,
  RoundSummary,
} from './types'

const FIXED_SCALE = 1_000_000_000_000n
export const RANKED_INTERACTIVE_PLACEMENT_MS = 12_000
export const RANKED_DECK_REVEAL_MS = 5_000
const BOT_COLORS = [
  '#74d7ff', '#ffb55e', '#c792ff', '#7ce6ad', '#ff7f9f', '#ffe078', '#8fbcff',
  '#e890ff', '#67e8dc', '#ff9d75', '#adc6ff', '#c8f56f', '#f89fe1', '#80c7a3',
  '#ffcf91', '#9ea8ff', '#f5a0a0', '#86d8ff', '#d5a6ff',
] as const

const PERSONAS: Readonly<Record<string, Persona>> = {
  turtle: 'Turtle',
  wick_watcher: 'Sniper',
  late_bidder: 'Late Bidder',
  mimic: 'Mimic',
  chaos: 'Chaos',
  range_reader: 'Momentum',
  crowd_avoider: 'Contrarian',
  score_hunter: 'Greedlord',
}

function requireFixed(value: string, field: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${field} must be a canonical unsigned fixed-point integer`)
  }
  return BigInt(value)
}

/** Presentation-only conversion. Proof and scoring always retain decimal strings. */
export function rankedFixedToNumber(value: string, field = 'fixed value'): number {
  const fixed = requireFixed(value, field)
  const whole = fixed / FIXED_SCALE
  const fraction = fixed % FIXED_SCALE
  return Number(whole) + Number(fraction) / Number(FIXED_SCALE)
}

export function rankedFixedToPoints(value: string, field = 'score'): number {
  const fixed = requireFixed(value, field)
  return Number((fixed + FIXED_SCALE / 2n) / FIXED_SCALE)
}

function signedFixedLabel(value: string): string {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(value) || value === '-0') return 'invalid'
  const fixed = BigInt(value)
  const negative = fixed < 0n
  const absolute = negative ? -fixed : fixed
  const tenths = (absolute + FIXED_SCALE / 20n) / (FIXED_SCALE / 10n)
  return `${negative ? '-' : ''}${tenths / 10n}.${tenths % 10n}`
}

export function rankedDeckId(id: string): string {
  return id.replaceAll('_', '-')
}

export function rankedDeckToGame(deck: RankedDeck): DeckDefinition {
  const local = getDeck(rankedDeckId(deck.id))
  const weights = deck.varianceWeights.map(Number)
  const maximum = Math.max(...weights, 1)
  return {
    id: rankedDeckId(deck.id),
    version: deck.version,
    monitoringConvention: 'strikefall/brownian-bridge-extrema/v1',
    name: deck.displayName,
    kicker: local?.kicker ?? 'Signed server deck',
    description: local?.description ?? 'A versioned volatility schedule committed before battle.',
    tacticalHint: local?.tacticalHint ?? 'Read the room before you plant.',
    variance: [
      weights[0] / maximum,
      weights[1] / maximum,
      weights[2] / maximum,
      weights[3] / maximum,
    ],
    openingRunway: deck.openingRunway ? { ...deck.openingRunway } : undefined,
    hue: local?.hue ?? 184,
    tempo: local?.tempo ?? 1,
  }
}

function approachCandles(created: CreateRoundResponse): Candle[] {
  let previous = 100
  return created.approach.map((point) => {
    const close = rankedFixedToNumber(point.price, 'approach.price')
    const candle = {
      open: previous,
      high: rankedFixedToNumber(point.intervalHigh, 'approach.intervalHigh'),
      low: rankedFixedToNumber(point.intervalLow, 'approach.intervalLow'),
      close,
    }
    previous = close
    return candle
  })
}

function persona(value: string | null, isPlayer: boolean): Persona | 'Player' {
  if (isPlayer) return 'Player'
  return PERSONAS[value ?? ''] ?? 'Momentum'
}

function scoreFor(
  contenderId: number,
  scores: readonly LockedScore[] = [],
): LockedScore | undefined {
  return scores.find((entry) => entry.contenderId === contenderId)
}

function contenderFromPlacement(
  placement: RankedPlacement,
  lineValue: number,
  scores: readonly LockedScore[] = [],
  moves: readonly BotMove[] = [],
  lineValueFixed?: string,
): Contender {
  const barrier = rankedFixedToNumber(placement.barrier, 'placement.barrier')
  const locked = scoreFor(placement.contenderId, scores)
  const distance = Math.abs(barrier - lineValue)
  const distanceFixed = lineValueFixed === undefined
    ? undefined
    : (
        requireFixed(placement.barrier, 'placement.barrier') >= requireFixed(lineValueFixed, 'lineValue')
          ? requireFixed(placement.barrier, 'placement.barrier') - requireFixed(lineValueFixed, 'lineValue')
          : requireFixed(lineValueFixed, 'lineValue') - requireFixed(placement.barrier, 'placement.barrier')
      ).toString()
  return {
    id: placement.contenderId === 0 ? 'player' : `bot-${placement.contenderId}`,
    name: placement.contenderId === 0 ? 'YOU' : placement.name,
    persona: persona(placement.persona, placement.contenderId === 0),
    isPlayer: placement.contenderId === 0,
    side: placement.side,
    distance,
    barrier,
    barrierFixed: placement.barrier,
    risk: locked ? rankedFixedToNumber(locked.riskMultiplier, 'riskMultiplier') : 1,
    crowd: locked ? rankedFixedToNumber(locked.crowdFactor, 'crowdFactor') : 1,
    potential: locked ? rankedFixedToPoints(locked.terminalScore, 'terminalScore') : 100,
    color: placement.contenderId === 0
      ? '#f7f4e9'
      : BOT_COLORS[(placement.contenderId - 1) % BOT_COLORS.length] ?? '#74d7ff',
    outcome: 'active',
    hitAt: null,
    closestApproach: distance,
    closestApproachStep: 0,
    closestApproachFixed: distanceFixed,
    escape: null,
    moves: [...moves],
  }
}

function rankedEngineDescriptor(deck: RankedDeck) {
  const identity = {
    mode: 'wasm-solmath' as const,
    engineVersion: 'solmath/0.2.0+strikefall-ranked/v3',
    rankable: true,
    rustDeckId: deck.id,
    rustDeckVersion: deck.version,
    pricingVarianceFixed: deck.totalIntegratedVariance,
    driftPerVarianceFixed: deck.driftPerVariance,
    pathSource: 'rust-server-bridge-extrema/v3' as const,
  }
  return {
    ...identity,
    digest: scoringEngineDigest(identity),
    reason: null,
  }
}

function appendFeed(state: RoundState, event: Omit<FeedEvent, 'sequence'>): RoundState {
  if (state.feed.some((entry) => entry.id === event.id)) return state
  return {
    ...state,
    feed: [...state.feed, { ...event, sequence: state.nextEventSequence }],
    nextEventSequence: state.nextEventSequence + 1,
  }
}

export function createRankedArenaRound(created: CreateRoundResponse, now = performance.now()): RoundState {
  const deck = rankedDeckToGame(created.deck)
  const approach = approachCandles(created)
  const lineValue = approach.at(-1)?.close
    ?? rankedFixedToNumber(created.playerPlacement.barrier, 'playerPlacement.barrier')
  const lineValueFixed = created.approach.at(-1)?.price ?? created.playerPlacement.barrier
  const placements = [created.playerPlacement, ...created.bots]
  const totalBeforeLock = Math.max(0, created.placementDeadlineMs - created.createdAtMs)
  const presentationLead = Math.max(0, totalBeforeLock - RANKED_INTERACTIVE_PLACEMENT_MS)
  const deckDuration = presentationLead >= RANKED_DECK_REVEAL_MS
    ? RANKED_DECK_REVEAL_MS
    : 0
  const initialPhase = deckDuration > 0 ? 'deck' as const : 'placement' as const
  const duration = deckDuration || totalBeforeLock
  return {
    roundId: created.roundId,
    seed: 'server-hidden-until-reveal',
    pathSeed: 'server-hidden-until-reveal',
    botSeed: 'server-isolated',
    phase: initialPhase,
    phaseStartedAt: now,
    phaseDuration: duration,
    phaseProgress: 0,
    timeRemaining: duration,
    deck,
    engine: rankedEngineDescriptor(created.deck),
    approach,
    battlePath: Array.from({ length: created.deck.battleSteps }, () => lineValue),
    battleExtrema: Array.from({ length: created.deck.battleSteps }, () => ({
      high: lineValue,
      low: lineValue,
    })),
    battleIndex: 0,
    lineValue,
    lineValueFixed,
    contenders: placements.map((placement) => contenderFromPlacement(
      placement,
      lineValue,
      [],
      [],
      lineValueFixed,
    )),
    feed: [{
      id: `${created.roundId}-ranked-created`,
      sequence: 0,
      type: 'system',
      title: 'SIGNED LOBBY OPEN',
      detail: `${created.deck.displayName} v${created.deck.version} · 19 disclosed bots`,
      contenderIds: [],
      at: 0,
    }],
    nextEventSequence: 1,
    summary: null,
    playerEliminated: false,
    escapeEnabled: created.experimentAssignments['escape:v2'] === 'midpoint',
  }
}

/** Applies provisional WASM scores while preserving the server's exact placement DTOs. */
export function previewRankedArenaPlacements(
  state: RoundState,
  placements: readonly RankedPlacement[],
  scores: readonly LockedScore[],
): RoundState {
  const existing = new Map(state.contenders.map((contender) => [contender.id, contender]))
  return {
    ...state,
    contenders: placements.map((placement) => {
      const id = placement.contenderId === 0 ? 'player' : `bot-${placement.contenderId}`
      const previous = existing.get(id)
      const contender = contenderFromPlacement(
        placement,
        state.battlePath[0] ?? state.lineValue,
        scores,
        previous?.moves,
        state.lineValueFixed,
      )
      return previous
        ? { ...contender, outcome: previous.outcome, hitAt: previous.hitAt, escape: previous.escape }
        : contender
    }),
  }
}

function replacePlacement(
  state: RoundState,
  placement: RankedPlacement,
  scores: readonly LockedScore[] = [],
  move?: BotMove,
): RoundState {
  const id = placement.contenderId === 0 ? 'player' : `bot-${placement.contenderId}`
  const existing = state.contenders.find((entry) => entry.id === id)
  const moves = move ? [...(existing?.moves ?? []), move] : existing?.moves ?? []
  const next = contenderFromPlacement(
    placement,
    state.battlePath[0] ?? state.lineValue,
    scores,
    moves,
    state.lineValueFixed,
  )
  return {
    ...state,
    contenders: state.contenders.some((entry) => entry.id === id)
      ? state.contenders.map((entry) => entry.id === id ? { ...next, outcome: entry.outcome, escape: entry.escape } : entry)
      : [...state.contenders, next],
  }
}

function applyLockedScores(
  state: RoundState,
  scores: readonly LockedScore[],
  now: number,
  lockDurationMs: number,
): RoundState {
  const updated = state.contenders.map((contender) => {
    const id = contender.isPlayer ? 0 : Number(contender.id.replace('bot-', ''))
    const locked = scoreFor(id, scores)
    if (!locked) return contender
    return {
      ...contender,
      risk: rankedFixedToNumber(locked.riskMultiplier, 'riskMultiplier'),
      crowd: rankedFixedToNumber(locked.crowdFactor, 'crowdFactor'),
      potential: rankedFixedToPoints(locked.terminalScore, 'terminalScore'),
      closestApproach: contender.distance,
      closestApproachStep: 0,
      closestApproachFixed: contender.closestApproachFixed,
    }
  })
  const player = updated.find((entry) => entry.isPlayer)
  return appendFeed({
    ...state,
    phase: 'lock',
    phaseStartedAt: now,
    phaseDuration: lockDurationMs,
    phaseProgress: 0,
    timeRemaining: lockDurationMs,
    contenders: updated,
  }, {
    id: `${state.roundId}-ranked-lock`,
    type: 'lock',
    title: 'AUTHORITATIVE LOCK',
    detail: player
      ? `${player.risk.toFixed(2)}× risk · ${player.crowd.toFixed(2)}× crowd · ${player.potential} points`
      : 'All signed placements locked.',
    contenderIds: updated.map((entry) => entry.id),
    at: 0,
  })
}

function acceptedEscape(state: RoundState, contenderId: number, escape: RankedEscape): RoundState {
  const id = contenderId === 0 ? 'player' : `bot-${contenderId}`
  const step = escape.step
  const at = step / Math.max(1, state.battlePath.length - 1)
  let accepted: Contender | undefined
  const contenders = state.contenders.map((contender) => {
    if (contender.id !== id || contender.outcome !== 'active') return contender
    const bankedScore = rankedFixedToPoints(escape.bankedScore, 'escape.bankedScore')
    const survivalProbability = contender.potential > 0
      ? Math.min(1, bankedScore / contender.potential)
      : 0
    accepted = {
      ...contender,
      outcome: 'escaped',
      escape: {
        frame: step,
        at,
        survivalProbability,
        terminalScore: contender.potential,
        bankedScore,
        holdOutcome: 'pending',
        holdHitAt: null,
      },
    }
    return accepted
  })
  if (!accepted) return state
  return appendFeed({ ...state, contenders }, {
    id: `${state.roundId}-ranked-escape-${contenderId}-${step}`,
    type: 'escape',
    title: contenderId === 0 ? 'YOU ESCAPED' : `${accepted.name} escaped`,
    detail: `${accepted.escape?.bankedScore ?? 0} authoritative points banked`,
    contenderIds: [id],
    at,
  })
}

function eventProgress(state: RoundState, step: number): number {
  return step / Math.max(1, state.battlePath.length - 1)
}

export function applyRankedArenaEvent(
  state: RoundState,
  event: SignedRoundEvent,
  now = performance.now(),
): RoundState {
  const kind: RoundEventKind = event.kind
  switch (kind.type) {
    case 'round_created':
      return replacePlacement(state, kind.data.playerPlacement)
    case 'approach_frame':
    case 'placement_opened':
    case 'bot_escape_evaluated':
    case 'round_ended':
    case 'seed_revealed':
    case 'replay_verified':
      return state
    case 'bot_placement_decision': {
      const decision = kind.data.decision
      const placement = decision.placement
      const moved = replacePlacement(state, placement, [], {
        at: decision.decisionTimeMs,
        completed: true,
        targetSide: placement.side,
        targetDistance: Math.abs(
          rankedFixedToNumber(placement.barrier, 'decision.placement.barrier') - state.lineValue,
        ),
        reason: decision.reasonCode.replaceAll('_', ' '),
      })
      return appendFeed(moved, {
        id: `${state.roundId}-ranked-bot-move-${decision.contenderId}-${decision.decisionNumber}`,
        type: 'system',
        title: `${placement.name} · BOT jockeyed`,
        detail: `Move ${decision.decisionNumber} observed at ${(decision.observationTimeMs / 1_000).toFixed(1)}s, acted at ${(decision.decisionTimeMs / 1_000).toFixed(1)}s · ${decision.candidateCount} candidates · utility ${signedFixedLabel(decision.selectedUtility)}`,
        contenderIds: [`bot-${decision.contenderId}`],
        at: Math.min(1, decision.decisionTimeMs / RANKED_INTERACTIVE_PLACEMENT_MS),
      })
    }
    case 'flag_moved':
      return replacePlacement(state, kind.data.placement)
    case 'placement_locked':
      if (kind.data.battleStartsAtMs - event.serverTimeMs !== RANKED_LOCK_PHASE_MS) {
        throw new RangeError('Ranked placement lock has a non-canonical battle start')
      }
      return applyLockedScores(state, kind.data.lockedScores, now, RANKED_LOCK_PHASE_MS)
    case 'battle_frame': {
      const point = kind.data.point
      const lineValue = rankedFixedToNumber(point.price, 'battle.price')
      const battlePath = [...state.battlePath]
      const battleExtrema = [...state.battleExtrema]
      battlePath[point.step] = lineValue
      battleExtrema[point.step] = {
        high: rankedFixedToNumber(point.intervalHigh, 'battle.intervalHigh'),
        low: rankedFixedToNumber(point.intervalLow, 'battle.intervalLow'),
      }
      const progress = eventProgress(state, point.step)
      const duration = state.battlePath.length * 250
      const contenders = state.contenders.map((contender) => {
        if (contender.outcome !== 'active') return contender
        if (contender.barrierFixed === undefined || contender.closestApproachFixed === undefined) {
          throw new Error(`Ranked contender ${contender.id} is missing exact closest-approach state`)
        }
        const barrier = requireFixed(contender.barrierFixed, 'contender.barrier')
        const nearest = requireFixed(
          contender.side === 'upper' ? point.intervalHigh : point.intervalLow,
          'battle.nearest-extrema',
        )
        const signedDistance = contender.side === 'upper'
          ? barrier - nearest
          : nearest - barrier
        const distanceFixed = signedDistance > 0n ? signedDistance : 0n
        const improved = contender.closestApproachFixed !== undefined
          ? distanceFixed < requireFixed(contender.closestApproachFixed, 'contender.closestApproach')
          : rankedFixedToNumber(distanceFixed.toString()) < contender.closestApproach
        if (!improved) return contender
        return {
          ...contender,
          closestApproach: rankedFixedToNumber(distanceFixed.toString(), 'closestApproach'),
          closestApproachFixed: distanceFixed.toString(),
          closestApproachStep: point.step,
        }
      })
      return {
        ...state,
        phase: 'battle',
        phaseStartedAt: point.step === 0 ? now : state.phaseStartedAt,
        phaseDuration: duration,
        phaseProgress: progress,
        timeRemaining: Math.max(0, duration * (1 - progress)),
        battlePath,
        battleExtrema,
        battleIndex: point.step,
        lineValue,
        lineValueFixed: point.price,
        contenders,
      }
    }
    case 'flag_hit': {
      const touch = kind.data.touch
      const id = touch.contenderId === 0 ? 'player' : `bot-${touch.contenderId}`
      const progress = eventProgress(state, touch.step)
      const contenders = state.contenders.map((contender) => contender.id === id
        ? {
            ...contender,
            outcome: 'hit' as const,
            hitAt: progress,
            closestApproach: 0,
            closestApproachFixed: '0',
            closestApproachStep: touch.step,
          }
        : contender)
      const hit = contenders.find((entry) => entry.id === id)
      return appendFeed({
        ...state,
        contenders,
        playerEliminated: state.playerEliminated || touch.contenderId === 0,
      }, {
        id: `${state.roundId}-ranked-hit-${touch.contenderId}-${touch.step}`,
        type: 'hit',
        title: touch.contenderId === 0 ? 'YOUR FLAG EXPLODED' : `${hit?.name ?? 'Bot'} wiped`,
        detail: `Signed touch at ${Math.round(progress * 60)}s`,
        contenderIds: [id],
        at: progress,
      })
    }
    case 'flag_cluster': {
      const cluster = kind.data.cluster
      const ids = cluster.contenderIds.map((id) => id === 0 ? 'player' : `bot-${id}`)
      return appendFeed(state, {
        id: `${state.roundId}-ranked-cluster-${cluster.step}-${ids.join('-')}`,
        type: 'cluster',
        title: `CLUSTER WIPE ×${ids.length}`,
        detail: 'One signed frame cleared the neighbourhood.',
        contenderIds: ids,
        at: eventProgress(state, cluster.step),
      })
    }
    case 'escape_accepted':
      return acceptedEscape(state, kind.data.contenderId, kind.data.escape)
  }
}

function escapeById(bundle: RankedReplayBundle, contenderId: number): RankedEscape | null {
  if (contenderId === 0) return bundle.escape
  return bundle.botEscapes.find((entry) => entry.contenderId === contenderId)?.escape ?? null
}

function settleEscape(
  escape: EscapeRecord,
  contender: Contender,
  battlePath: readonly number[],
  battleExtrema: RoundState['battleExtrema'],
): EscapeRecord {
  for (let step = escape.frame + 1; step < battlePath.length; step += 1) {
    const previous = battlePath[step - 1] ?? battlePath[step] ?? 0
    const current = battlePath[step] ?? previous
    const extrema = battleExtrema[step] ?? {
      high: Math.max(previous, current),
      low: Math.min(previous, current),
    }
    const hit = contender.side === 'upper'
      ? extrema.high >= contender.barrier
      : extrema.low <= contender.barrier
    if (hit) {
      return {
        ...escape,
        holdOutcome: 'would-hit',
        holdHitAt: step / Math.max(1, battlePath.length - 1),
      }
    }
  }
  return { ...escape, holdOutcome: 'would-survive', holdHitAt: null }
}

function rankedHeadline(summary: Pick<RoundSummary, 'outcome' | 'rank' | 'survived'>): string {
  if (summary.outcome === 'escaped') return 'SCORE BANKED. PROOF SEALED.'
  if (summary.outcome === 'survived' && summary.rank === 1) return 'YOU OWNED THE SIGNED SKYLINE.'
  if (summary.outcome === 'survived' && summary.survived <= 3) return 'LAST FLAGS STANDING.'
  if (summary.outcome === 'survived') return 'UNTOUCHED. VERIFIED.'
  return 'THE LINE FOUND YOU.'
}

function rankedClosestApproachStep(
  placement: RankedPlacement,
  battle: RankedReplayBundle['path']['battle'],
  closestApproach: string,
): number {
  const barrier = requireFixed(placement.barrier, 'placement.barrier')
  const target = requireFixed(closestApproach, 'result.closestApproach')
  let bestStep = 0
  let bestDistance: bigint | null = null

  for (const point of battle) {
    const nearest = requireFixed(
      placement.side === 'upper' ? point.intervalHigh : point.intervalLow,
      'path.battle.nearest-extrema',
    )
    const signedDistance = placement.side === 'upper'
      ? barrier - nearest
      : nearest - barrier
    const distance = signedDistance > 0n ? signedDistance : 0n
    if (distance === target) return point.step
    if (bestDistance === null || distance < bestDistance) {
      bestDistance = distance
      bestStep = point.step
    }
  }
  return bestStep
}

export function finalizeRankedArenaRound(
  state: RoundState,
  bundle: RankedReplayBundle,
  now = performance.now(),
): RoundState {
  const battlePath = bundle.path.battle.map((point) => rankedFixedToNumber(point.price, 'path.battle.price'))
  const battleExtrema = bundle.path.battle.map((point) => ({
    high: rankedFixedToNumber(point.intervalHigh, 'path.battle.intervalHigh'),
    low: rankedFixedToNumber(point.intervalLow, 'path.battle.intervalLow'),
  }))
  const locked = new Map(bundle.lockedScores.map((score) => [score.contenderId, score]))
  const resolved = new Map(bundle.result.contenders.map((result) => [result.contenderId, result]))
  const contenders = bundle.placements.map((placement) => {
    const score = locked.get(placement.contenderId)
    const result = resolved.get(placement.contenderId)
    let contender = contenderFromPlacement(
      placement,
      battlePath[0] ?? state.lineValue,
      score ? [score] : [],
      [],
      bundle.path.battle[0]?.price,
    )
    if (!result) return contender
    const outcome = result.outcome === 'eliminated' ? 'hit' : result.outcome
    const rankedEscape = escapeById(bundle, placement.contenderId)
    const escape = rankedEscape
      ? {
          frame: rankedEscape.step,
          at: rankedEscape.step / Math.max(1, battlePath.length - 1),
          survivalProbability: contender.potential > 0
            ? Math.min(1, rankedFixedToPoints(rankedEscape.bankedScore) / contender.potential)
            : 0,
          terminalScore: contender.potential,
          bankedScore: rankedFixedToPoints(rankedEscape.bankedScore),
          holdOutcome: 'pending' as const,
          holdHitAt: null,
        }
      : null
    contender = {
      ...contender,
      outcome,
      hitAt: result.touchStep === null
        ? null
        : result.touchStep / Math.max(1, battlePath.length - 1),
      closestApproach: rankedFixedToNumber(result.closestApproach, 'closestApproach'),
      closestApproachFixed: result.closestApproach,
      closestApproachStep: result.touchStep
        ?? rankedClosestApproachStep(placement, bundle.path.battle, result.closestApproach),
      potential: outcome === 'survived'
        ? rankedFixedToPoints(result.score, 'result.score')
        : contender.potential,
      escape,
    }
    return escape
      ? { ...contender, escape: settleEscape(escape, contender, battlePath, battleExtrema) }
      : contender
  })
  const player = contenders.find((entry) => entry.isPlayer)
  if (!player) throw new Error('Authoritative replay omitted the player')
  const escaped = contenders.filter((entry) => entry.outcome === 'escaped').length
  const summaryBase = {
    outcome: bundle.result.outcome === 'eliminated' ? 'eliminated' as const : bundle.result.outcome,
    score: rankedFixedToPoints(bundle.result.score, 'result.score'),
    rank: bundle.result.rank,
    survived: bundle.result.survivors,
  }
  const summary: RoundSummary = {
    ...summaryBase,
    escaped,
    closestApproach: rankedFixedToNumber(bundle.result.closestApproach, 'result.closestApproach'),
    multiplier: player.risk,
    crowd: player.crowd,
    headline: rankedHeadline(summaryBase),
    escape: player.escape,
  }
  const resultState: RoundState = {
    ...state,
    seed: bundle.reveal.pathSeed,
    pathSeed: bundle.reveal.pathSeed,
    phase: 'result',
    phaseStartedAt: now,
    phaseDuration: 10_000,
    phaseProgress: 0,
    timeRemaining: 10_000,
    battlePath,
    battleExtrema,
    battleIndex: Math.max(0, battlePath.length - 1),
    lineValue: battlePath.at(-1) ?? state.lineValue,
    contenders,
    summary,
    playerEliminated: player.outcome === 'hit',
  }
  return appendFeed(resultState, {
    id: `${state.roundId}-ranked-resolved`,
    type: 'survivor',
    title: `${summary.survived} SURVIVED · ${summary.escaped} ESCAPED`,
    detail: 'Rust replay regenerated and every signed event verified.',
    contenderIds: contenders.filter((entry) => entry.outcome === 'survived').map((entry) => entry.id),
    at: 1,
  })
}
