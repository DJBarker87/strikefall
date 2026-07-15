import type {
  BotDifficulty,
  Contender,
  CreateRoundOptions,
  DeckDefinition,
  FeedEvent,
  GamePhase,
  RoundPacing,
  RoundState,
  RoundSummary,
} from './types'
import {
  assertActiveEngine,
  canonicalUnsignedFixed,
  ensureScoringEngineForDeck,
  fixedToRoundedPoints,
} from '../engine'
import {
  advanceBotPlacements,
  createBotContenders,
  decideBotEscapes,
} from './bots'
import { DECKS, getDeck, selectDeck, selectDeckForSeed } from './decks'
import {
  canContenderEscape,
  escapeRecordFromQuote,
  getContenderEscapeQuote,
  type EscapeQuote,
} from './escape'
import { markSurvivors, resolveHitsAtValue } from './hits'
import { clamp, roundTo } from './math'
import { generateRoundPaths } from './path'
import { hashSeed } from './rng'
import {
  barrierForPlacement,
  clampDistance,
  distanceForSurvivalProbability,
  scoreContenders,
} from './scoring'

export const PHASE_DURATIONS: Readonly<Record<GamePhase, number>> = {
  home: 0,
  deck: 5_000,
  approach: 15_000,
  placement: 6_000,
  lock: 2_000,
  battle: 60_000,
  result: 10_000,
}

export const PLACEMENT_INPUT_FREEZE_MS = 750
export const CLUSTER_WINDOW_PROGRESS = 0.5 / 60

type FeedEventInput = Omit<FeedEvent, 'sequence'>

function appendFeedEvents(
  feed: readonly FeedEvent[],
  nextSequence: number,
  events: readonly FeedEventInput[],
): { feed: FeedEvent[]; nextSequence: number; events: FeedEvent[] } {
  const ordered = events.map((event, index) => ({
    ...event,
    sequence: nextSequence + index,
  }))
  return {
    feed: [...feed, ...ordered],
    nextSequence: nextSequence + ordered.length,
    events: ordered,
  }
}

function resolveDeck(seed: string, requested?: DeckDefinition | number | string): DeckDefinition {
  if (typeof requested === 'number') return selectDeck(requested)
  if (typeof requested === 'string') return getDeck(requested) ?? selectDeckForSeed(requested)
  return requested ?? selectDeckForSeed(seed)
}

function exactPracticeLine(
  state: Pick<RoundState, 'engine' | 'battlePathFixed' | 'lineValueFixed'>,
  index = 0,
): string | undefined {
  const fixed = state.battlePathFixed?.[index] ?? state.lineValueFixed
  if (state.engine.pathSource === 'rust-wasm-bridge-extrema/v1' && fixed === undefined) {
    throw new Error('Canonical Practice path is missing its fixed line value')
  }
  return fixed
}

function assertCanonicalPracticeBattle(state: RoundState): void {
  if (state.engine.pathSource !== 'rust-wasm-bridge-extrema/v1') return
  if (
    state.battlePathFixed?.length !== state.battlePath.length
    || state.battleExtrema.length !== state.battlePath.length
    || state.battleExtremaFixed?.length !== state.battlePath.length
    || state.lineValueFixed === undefined
    || state.battlePathFixed[state.battleIndex] !== state.lineValueFixed
  ) {
    throw new Error('Canonical Practice battle is missing exact path/extrema data')
  }
  for (let index = 0; index < state.battlePath.length; index += 1) {
    const point = state.battlePathFixed[index]
    const extrema = state.battleExtremaFixed[index]
    if (point === undefined || extrema === undefined) {
      throw new Error('Canonical Practice battle has a sparse exact path/extrema entry')
    }
    canonicalUnsignedFixed(point, `battlePathFixed[${index}]`)
    canonicalUnsignedFixed(extrema.high, `battleExtremaFixed[${index}].high`)
    canonicalUnsignedFixed(extrema.low, `battleExtremaFixed[${index}].low`)
  }
  const incomplete = state.contenders.find((contender) => (
    contender.barrierFixed === undefined
    || contender.fixedScore === undefined
    || contender.closestApproachFixed === undefined
    || contender.closestApproachStep === undefined
  ))
  if (incomplete) {
    throw new Error(
      `Canonical Practice contender ${incomplete.id} is missing exact lock data (including closest approach)`,
    )
  }
}

function makePlayer(
  lineValue: number,
  side: 'upper' | 'lower',
  requestedDistance?: number,
  lineValueFixed?: string,
): Contender {
  const distance = clampDistance(
    requestedDistance
      ?? distanceForSurvivalProbability(0.43, lineValue, side, lineValueFixed),
    lineValue,
    side,
    lineValueFixed,
  )
  return {
    id: 'player',
    name: 'YOU',
    persona: 'Player',
    isPlayer: true,
    side,
    distance,
    barrier: barrierForPlacement(lineValue, side, distance),
    risk: 1,
    crowd: 1,
    potential: 100,
    color: '#F7F4E9',
    outcome: 'active',
    hitAt: null,
    closestApproach: distance,
    closestApproachStep: 0,
    escape: null,
    moves: [],
  }
}

function resetClosestApproach(
  contender: Contender,
  lineValueFixed?: string,
): Contender {
  const closestApproachFixed = contender.barrierFixed !== undefined && lineValueFixed !== undefined
    ? (
        BigInt(contender.barrierFixed) >= BigInt(lineValueFixed)
          ? BigInt(contender.barrierFixed) - BigInt(lineValueFixed)
          : BigInt(lineValueFixed) - BigInt(contender.barrierFixed)
      ).toString()
    : undefined
  return {
    ...contender,
    closestApproach: contender.distance,
    closestApproachStep: 0,
    closestApproachFixed,
  }
}

export function roundIdFor(seed: string, deck: DeckDefinition): string {
  return `sf-${hashSeed(`${deck.id}:${seed}`).toString(36)}`
}

export function createRound(
  seed: string,
  requestedDeck?: DeckDefinition | number | string,
  options: CreateRoundOptions = {},
): RoundState {
  if (!seed.trim()) throw new RangeError('A round seed is required')
  const deck = resolveDeck(seed, requestedDeck)
  const engine = ensureScoringEngineForDeck(
    {
      id: deck.id,
      name: deck.name,
      version: deck.version,
      monitoringConvention: deck.monitoringConvention,
      variance: deck.variance,
      openingRunway: deck.openingRunway,
    },
    options.engine,
  )
  assertActiveEngine(engine)
  const now = options.now ?? 0
  const pathSeed = options.pathSeed ?? seed
  const botSeed = options.botSeed ?? seed
  const paths = generateRoundPaths(
    pathSeed,
    deck,
    options.approachCandles,
    options.battleSteps,
  )
  const player = makePlayer(
    paths.lineValue,
    options.playerSide ?? 'upper',
    options.playerDistance,
    paths.lineValueFixed,
  )
  const bots = createBotContenders(
    botSeed,
    deck,
    paths.approach,
    paths.lineValue,
    options.difficulty,
    [player],
    options.botProfiles,
    paths.lineValueFixed,
  )
  const contenders = scoreContenders(
    [player, ...bots],
    paths.lineValue,
    paths.lineValueFixed,
  ).map((contender) => resetClosestApproach(contender, paths.lineValueFixed))

  return {
    roundId: options.roundId ?? roundIdFor(seed, deck),
    seed,
    pathSeed,
    botSeed,
    phase: 'deck',
    phaseStartedAt: now,
    phaseDuration: PHASE_DURATIONS.deck,
    phaseProgress: 0,
    timeRemaining: PHASE_DURATIONS.deck,
    deck,
    engine,
    approach: paths.approach,
    battlePath: paths.battlePath,
    battlePathFixed: paths.battlePathFixed,
    battleExtrema: paths.battleExtrema,
    battleExtremaFixed: paths.battleExtremaFixed,
    battleIndex: 0,
    lineValue: paths.lineValue,
    lineValueFixed: paths.lineValueFixed,
    contenders,
    feed: [
      {
        id: `deck-${hashSeed(seed).toString(36)}`,
        sequence: 0,
        type: 'system',
        title: deck.name.toUpperCase(),
        detail: `${deck.kicker} · ${bots.length} disclosed bots online`,
        contenderIds: [],
        at: 0,
      },
    ],
    nextEventSequence: 1,
    summary: null,
    playerEliminated: false,
    escapeEnabled: options.escapeEnabled ?? false,
  }
}

export function createRandomRound(
  seed: string,
  options: CreateRoundOptions = {},
): RoundState {
  return createRound(seed, selectDeckForSeed(seed), options)
}

export function createHomeRound(
  seed = 'strikefall-home-preview',
  options: CreateRoundOptions = {},
): RoundState {
  const round = createRound(seed, selectDeckForSeed(seed), options)
  return enterPhase(round, 'home', options.now ?? 0)
}

export function getPlayer(state: Pick<RoundState, 'contenders'>): Contender {
  const player = state.contenders.find((contender) => contender.isPlayer)
  if (!player) throw new Error('Round does not contain a player')
  return player
}

export function enterPhase(state: RoundState, phase: GamePhase, now: number): RoundState {
  return {
    ...state,
    phase,
    phaseStartedAt: now,
    phaseDuration: PHASE_DURATIONS[phase],
    phaseProgress: 0,
    timeRemaining: PHASE_DURATIONS[phase],
  }
}

/**
 * Re-anchors a frozen phase after a local pause. Because only the wall-clock
 * origin moves, replay command times and every visible countdown stay exact.
 */
export function resumeRoundAfterPause(
  state: RoundState,
  pausedForMs: number,
): RoundState {
  if (!Number.isFinite(pausedForMs) || pausedForMs < 0) {
    throw new RangeError('Paused duration must be a non-negative finite number')
  }
  if (pausedForMs === 0 || state.phase === 'home' || state.phase === 'result') {
    return state
  }
  return {
    ...state,
    phaseStartedAt: state.phaseStartedAt + pausedForMs,
  }
}

export function startPlacement(state: RoundState, now: number): RoundState {
  return enterPhase(state, 'placement', now)
}

export function updatePlayerPlacement(
  state: RoundState,
  side: 'upper' | 'lower',
  distance: number,
): RoundState {
  if (state.phase !== 'placement') return state
  const boundedDistance = clampDistance(
    distance,
    state.battlePath[0] ?? state.lineValue,
    side,
    exactPracticeLine(state),
  )
  const contenders = state.contenders.map((contender) =>
    contender.isPlayer
      ? {
          ...contender,
          side,
          distance: boundedDistance,
          barrier: barrierForPlacement(state.battlePath[0] ?? state.lineValue, side, boundedDistance),
          closestApproach: boundedDistance,
        }
      : contender,
  )
  return {
    ...state,
    contenders: scoreContenders(
      contenders,
      state.battlePath[0] ?? state.lineValue,
      exactPracticeLine(state),
    ).map((contender) => resetClosestApproach(contender, exactPracticeLine(state))),
  }
}

export function updateBotsForPlacement(
  state: RoundState,
  elapsedMs: number,
  difficulty: BotDifficulty = 'normal',
): RoundState {
  if (state.phase !== 'placement') return state
  const lineValue = state.battlePath[0] ?? state.lineValue
  const result = advanceBotPlacements(state.contenders, elapsedMs, {
    seed: state.botSeed,
    deck: state.deck,
    approach: state.approach,
    lineValue,
    lineValueFixed: exactPracticeLine(state),
    difficulty,
  })
  return { ...state, contenders: result.contenders }
}

export function lockPlacements(state: RoundState, now: number): RoundState {
  const lineValue = state.battlePath[0] ?? state.lineValue
  const lineValueFixed = exactPracticeLine(state)
  const contenders = scoreContenders(state.contenders, lineValue, lineValueFixed)
    .map((contender) => resetClosestApproach(contender, lineValueFixed))
  const player = contenders.find((contender) => contender.isPlayer)
  const lockEvent: FeedEventInput = {
    id: `${state.roundId}-lock`,
    type: 'lock',
    title: 'FLAGS LOCKED',
    detail: player
      ? `${player.risk.toFixed(2)}× risk · ${player.crowd.toFixed(2)}× crowd · ${player.potential} potential`
      : 'The lobby is committed.',
    contenderIds: contenders.map((contender) => contender.id),
    at: 0,
  }
  const existing = state.feed.filter((event) => event.id !== lockEvent.id)
  const appended = appendFeedEvents(
    existing,
    state.nextEventSequence,
    [lockEvent],
  )
  return {
    ...enterPhase(state, 'lock', now),
    lineValue,
    lineValueFixed,
    contenders,
    feed: appended.feed,
    nextEventSequence: appended.nextSequence,
  }
}

export function beginBattle(state: RoundState, now: number): RoundState {
  return {
    ...enterPhase(state, 'battle', now),
    battleIndex: 0,
    lineValue: state.battlePath[0] ?? state.lineValue,
    lineValueFixed: exactPracticeLine(state),
  }
}

function hitFeedEvents(
  state: RoundState,
  hits: readonly Contender[],
  index: number,
  progress: number,
): FeedEventInput[] {
  return hits.map((contender, hitIndex) => ({
    id: `${state.roundId}-hit-${index}-${contender.id}`,
    type: 'hit',
    title: contender.isPlayer ? 'YOUR FLAG EXPLODED' : `${contender.name} wiped`,
    detail: contender.isPlayer
      ? `Touched at ${Math.round(progress * 60)}s into the run.`
      : `${contender.persona} · ${contender.risk.toFixed(2)}× flag`,
    contenderIds: [contender.id],
    at: clamp(progress + hitIndex * 0.00035, 0, 1),
  }))
}

function maybeClusterEvent(
  state: RoundState,
  hitEvents: readonly FeedEventInput[],
  index: number,
  progress: number,
): FeedEventInput | null {
  if (hitEvents.length === 0) return null
  const recentIds = state.feed
    .filter(
      (event) => event.type === 'hit' && event.at >= progress - CLUSTER_WINDOW_PROGRESS,
    )
    .flatMap((event) => event.contenderIds)
  const ids = [...new Set([...recentIds, ...hitEvents.flatMap((event) => event.contenderIds)])]
  const alreadyCalled = state.feed.some(
    (event) => event.type === 'cluster' && event.at >= progress - CLUSTER_WINDOW_PROGRESS,
  )
  if (ids.length < 3 || alreadyCalled) return null
  return {
    id: `${state.roundId}-cluster-${index}`,
    type: 'cluster',
    title: `CLUSTER WIPE ×${ids.length}`,
    detail: 'One move. A whole neighbourhood gone.',
    contenderIds: ids,
    at: progress,
  }
}

export type EscapeCommandRejection =
  | 'disabled'
  | 'wrong-phase'
  | 'window-closed'
  | 'not-active'
  | 'missing-contender'

export interface EscapeCommandResult {
  round: RoundState
  accepted: boolean
  quote: EscapeQuote | null
  event: FeedEvent | null
  rejection: EscapeCommandRejection | null
}

function applyEscapeQuote(
  state: RoundState,
  contenderId: string,
  quote: EscapeQuote,
  reason: string,
): EscapeCommandResult {
  const contender = state.contenders.find((entry) => entry.id === contenderId)
  if (!contender) {
    return {
      round: state,
      accepted: false,
      quote: null,
      event: null,
      rejection: 'missing-contender',
    }
  }
  if (contender.outcome !== 'active') {
    return {
      round: state,
      accepted: false,
      quote: null,
      event: null,
      rejection: 'not-active',
    }
  }

  const contenders = state.contenders.map((entry) =>
    entry.id === contenderId
      ? {
          ...entry,
          outcome: 'escaped' as const,
          escape: escapeRecordFromQuote(quote),
        }
      : entry,
  )
  const eventInput: FeedEventInput = {
    id: `${state.roundId}-escape-${quote.frame}-${contender.id}`,
    type: 'escape',
    title: contender.isPlayer ? 'YOU ESCAPED' : `${contender.name} escaped`,
    detail: contender.isPlayer
      ? `${quote.bankedScore} banked · ${quote.percentOfMaximum.toFixed(0)}% of maximum`
      : reason,
    contenderIds: [contender.id],
    at: quote.at,
  }
  const appended = appendFeedEvents(
    state.feed,
    state.nextEventSequence,
    [eventInput],
  )
  return {
    round: {
      ...state,
      contenders,
      feed: appended.feed,
      nextEventSequence: appended.nextSequence,
    },
    accepted: true,
    quote,
    event: appended.events[0] ?? null,
    rejection: null,
  }
}

/** Applies one irreversible Escape command at the currently resolved frame. */
export function executeEscapeCommand(
  state: RoundState,
  contenderId: string,
  reason = 'Model value banked.',
): EscapeCommandResult {
  const contender = state.contenders.find((entry) => entry.id === contenderId)
  if (!contender) {
    return {
      round: state,
      accepted: false,
      quote: null,
      event: null,
      rejection: 'missing-contender',
    }
  }
  if (contender.outcome !== 'active') {
    return {
      round: state,
      accepted: false,
      quote: null,
      event: null,
      rejection: 'not-active',
    }
  }
  if (!state.escapeEnabled) {
    return {
      round: state,
      accepted: false,
      quote: null,
      event: null,
      rejection: 'disabled',
    }
  }
  if (state.phase !== 'battle') {
    return {
      round: state,
      accepted: false,
      quote: null,
      event: null,
      rejection: 'wrong-phase',
    }
  }
  if (!canContenderEscape(state, contenderId)) {
    return {
      round: state,
      accepted: false,
      quote: getContenderEscapeQuote(state, contenderId),
      event: null,
      rejection: 'window-closed',
    }
  }
  const quote = getContenderEscapeQuote(state, contenderId)
  if (!quote) {
    return {
      round: state,
      accepted: false,
      quote: null,
      event: null,
      rejection: 'window-closed',
    }
  }
  return applyEscapeQuote(state, contenderId, quote, reason)
}

export function resolveBattleStep(state: RoundState, targetIndex: number): RoundState {
  if (state.phase !== 'battle' || state.battlePath.length < 2) return state
  assertCanonicalPracticeBattle(state)
  const boundedTarget = Math.floor(clamp(targetIndex, state.battleIndex, state.battlePath.length - 1))
  let contenders = state.contenders
  let feed = state.feed
  let nextEventSequence = state.nextEventSequence
  let playerEliminated = state.playerEliminated
  let lineValue = state.lineValue
  let lineValueFixed = exactPracticeLine(state, state.battleIndex)

  for (let index = state.battleIndex + 1; index <= boundedTarget; index += 1) {
    const previous = state.battlePath[index - 1] as number
    const current = state.battlePath[index] as number
    const extrema = state.battleExtrema[index] ?? {
      high: Math.max(previous, current),
      low: Math.min(previous, current),
    }
    const progress = index / (state.battlePath.length - 1)
    const resolution = resolveHitsAtValue(
      contenders,
      previous,
      current,
      progress,
      extrema,
      state.battleExtremaFixed?.[index],
      index.toString(),
    )
    contenders = resolution.contenders
    lineValue = current
    lineValueFixed = state.battlePathFixed?.[index] ?? lineValueFixed
    if (resolution.hits.length > 0) {
      const currentState = { ...state, feed }
      const events = hitFeedEvents(currentState, resolution.hits, index, progress)
      const cluster = maybeClusterEvent(currentState, events, index, progress)
      const appended = appendFeedEvents(
        feed,
        nextEventSequence,
        cluster ? [...events, cluster] : events,
      )
      feed = appended.feed
      nextEventSequence = appended.nextSequence
      if (resolution.hits.some((contender) => contender.isPlayer)) {
        playerEliminated = true
      }
    }

    if (state.escapeEnabled) {
      const publicState = {
        seed: state.botSeed,
        deck: state.deck,
        lineValue,
        lineValueFixed,
        battleFrame: index,
        battleSteps: state.battlePath.length,
        contenders,
      }
      const decisions = decideBotEscapes(publicState)
      for (const decision of decisions) {
        const currentState: RoundState = {
          ...state,
          battleIndex: index,
          lineValue,
          lineValueFixed,
          contenders,
          feed,
          nextEventSequence,
          playerEliminated,
        }
        const escaped = applyEscapeQuote(
          currentState,
          decision.botId,
          decision.quote,
          decision.reason,
        )
        if (!escaped.accepted) continue
        contenders = escaped.round.contenders
        feed = escaped.round.feed
        nextEventSequence = escaped.round.nextEventSequence
      }
    }
  }

  return {
    ...state,
    battleIndex: boundedTarget,
    lineValue,
    lineValueFixed,
    contenders,
    feed,
    nextEventSequence,
    playerEliminated,
  }
}

export function contenderScore(contender: Contender): number {
  if (contender.outcome === 'survived') {
    return contender.fixedScore?.terminalScore
      ? fixedToRoundedPoints(contender.fixedScore.terminalScore, 'terminalScore')
      : contender.potential
  }
  if (contender.outcome === 'escaped') {
    return contender.escape?.bankedScoreFixed
      ? fixedToRoundedPoints(contender.escape.bankedScoreFixed, 'bankedScore')
      : contender.escape?.bankedScore ?? 0
  }
  return 0
}

function contenderScoreFixed(contender: Contender): bigint | null {
  if (contender.outcome === 'survived' && contender.fixedScore?.terminalScore) {
    return BigInt(contender.fixedScore.terminalScore)
  }
  if (contender.outcome === 'escaped' && contender.escape?.bankedScoreFixed) {
    return BigInt(contender.escape.bankedScoreFixed)
  }
  if (contender.outcome === 'hit') return 0n
  return null
}

function compareDescendingFixed(left: bigint, right: bigint): number {
  if (right > left) return 1
  if (right < left) return -1
  return 0
}

function rankContenders(contenders: readonly Contender[]): Contender[] {
  const exactMode = contenders.some((contender) => (
    contender.barrierFixed !== undefined
    || contender.fixedScore !== undefined
    || contender.escape?.bankedScoreFixed !== undefined
    || contender.hitFrameExact !== undefined
  ))
  if (exactMode) {
    for (const contender of contenders) {
      if (!contender.fixedScore || contenderScoreFixed(contender) === null) {
        throw new Error(`Exact Practice rank is missing ${contender.id}'s canonical score`)
      }
      if (
        contender.outcome === 'hit'
        && !/^(0|[1-9][0-9]*)$/.test(contender.hitFrameExact ?? '')
      ) {
        throw new Error(`Exact Practice rank is missing ${contender.id}'s canonical hit frame`)
      }
    }
  }
  const outcomePriority: Record<Contender['outcome'], number> = {
    survived: 3,
    escaped: 2,
    active: 1,
    hit: 0,
  }
  return [...contenders].sort((left, right) => {
    const leftScoreFixed = contenderScoreFixed(left)
    const rightScoreFixed = contenderScoreFixed(right)
    if (exactMode) {
      const exactOrder = compareDescendingFixed(
        leftScoreFixed as bigint,
        rightScoreFixed as bigint,
      )
      if (exactOrder !== 0) return exactOrder
    } else if (leftScoreFixed !== null && rightScoreFixed !== null) {
      const exactOrder = compareDescendingFixed(leftScoreFixed, rightScoreFixed)
      if (exactOrder !== 0) return exactOrder
    } else {
      const leftScore = contenderScore(left)
      const rightScore = contenderScore(right)
      if (rightScore !== leftScore) return rightScore - leftScore
    }
    if (left.outcome !== right.outcome) {
      return outcomePriority[right.outcome] - outcomePriority[left.outcome]
    }
    if (left.outcome === 'hit' && right.outcome === 'hit') {
      if (exactMode) {
        const leftFrame = BigInt(left.hitFrameExact as string)
        const rightFrame = BigInt(right.hitFrameExact as string)
        if (rightFrame > leftFrame) return 1
        if (rightFrame < leftFrame) return -1
      } else if ((right.hitAt ?? 1) !== (left.hitAt ?? 1)) {
        return (right.hitAt ?? 1) - (left.hitAt ?? 1)
      }
    }
    const leftPotentialFixed = left.fixedScore?.terminalScore
    const rightPotentialFixed = right.fixedScore?.terminalScore
    if (exactMode) {
      const exactPotentialOrder = compareDescendingFixed(
        BigInt(leftPotentialFixed as string),
        BigInt(rightPotentialFixed as string),
      )
      if (exactPotentialOrder !== 0) return exactPotentialOrder
    } else if (leftPotentialFixed && rightPotentialFixed) {
      const exactPotentialOrder = compareDescendingFixed(
        BigInt(leftPotentialFixed),
        BigInt(rightPotentialFixed),
      )
      if (exactPotentialOrder !== 0) return exactPotentialOrder
    } else if (right.potential !== left.potential) {
      return right.potential - left.potential
    }
    return left.id.localeCompare(right.id)
  })
}

function summaryHeadline(player: Contender, rank: number, survivors: number): string {
  if (player.outcome === 'escaped') {
    if (player.escape?.holdOutcome === 'would-hit') {
      const gap = (player.escape.holdHitAt ?? 1) - player.escape.at
      if (gap <= 1 / 60) return 'PERFECT ESCAPE. ONE SECOND TO SPARE.'
      return 'BANKED BEFORE THE STRIKE.'
    }
    return 'SAFE SCORE. POINTS LEFT ON THE LINE.'
  }
  if (player.outcome === 'survived' && player.risk >= 5) return 'GREED FLAG. ICE-COLD HOLD.'
  if (player.outcome === 'survived' && rank === 1) return 'YOU OWNED THE SKYLINE.'
  if (player.outcome === 'survived' && survivors <= 3) return 'LAST FLAGS STANDING.'
  if (player.outcome === 'survived') return 'UNTOUCHED. RUN IT BACK.'
  if ((player.hitAt ?? 0) >= 0.9) return 'SECONDS FROM GLORY.'
  if (player.crowd <= 0.86) return 'THE CROWD FELL TOGETHER.'
  return 'THE LINE FOUND YOU.'
}

export function buildRoundSummary(contenders: readonly Contender[]): RoundSummary {
  const ranked = rankContenders(contenders)
  const player = ranked.find((contender) => contender.isPlayer)
  if (!player) throw new Error('Cannot summarize a round without a player')
  const survivors = contenders.filter((contender) => contender.outcome === 'survived').length
  const escaped = contenders.filter((contender) => contender.outcome === 'escaped').length
  const rank = ranked.findIndex((contender) => contender.id === player.id) + 1
  const survived = player.outcome === 'survived'
  const playerEscaped = player.outcome === 'escaped'
  return {
    outcome: survived ? 'survived' : playerEscaped ? 'escaped' : 'eliminated',
    score: contenderScore(player),
    rank,
    survived: survivors,
    escaped,
    closestApproach: roundTo(player.closestApproach, 3),
    multiplier: player.risk,
    crowd: player.crowd,
    headline: summaryHeadline(player, rank, survivors),
    escape: player.escape ? { ...player.escape } : null,
  }
}

function settleEscapeCounterfactuals(
  contenders: readonly Contender[],
  battlePath: readonly number[],
  battleExtrema: RoundState['battleExtrema'],
  battleExtremaFixed?: RoundState['battleExtremaFixed'],
): Contender[] {
  return contenders.map((contender) => {
    if (contender.outcome !== 'escaped' || !contender.escape) return contender
    let holdHitAt: number | null = null
    const firstFrame = Math.max(1, contender.escape.frame + 1)
    for (let index = firstFrame; index < battlePath.length; index += 1) {
      const previous = battlePath[index - 1] as number
      const current = battlePath[index] as number
      const extrema = battleExtrema[index] ?? {
        high: Math.max(previous, current),
        low: Math.min(previous, current),
      }
      const exactExtrema = battleExtremaFixed?.[index]
      if (exactExtrema && !contender.barrierFixed) {
        throw new Error(`Exact escape counterfactual is missing ${contender.id}'s fixed barrier`)
      }
      const touched = exactExtrema
        ? contender.side === 'upper'
          ? BigInt(exactExtrema.high) >= BigInt(contender.barrierFixed as string)
          : BigInt(exactExtrema.low) <= BigInt(contender.barrierFixed as string)
        : contender.side === 'upper'
          ? extrema.high >= contender.barrier
          : extrema.low <= contender.barrier
      if (!touched) continue
      holdHitAt = index / (battlePath.length - 1)
      break
    }
    return {
      ...contender,
      escape: {
        ...contender.escape,
        holdOutcome: holdHitAt === null ? 'would-survive' : 'would-hit',
        holdHitAt,
      },
    }
  })
}

export function finishRound(state: RoundState, now: number): RoundState {
  if (state.phase === 'battle') assertCanonicalPracticeBattle(state)
  const contenders = markSurvivors(
    settleEscapeCounterfactuals(
      state.contenders,
      state.battlePath,
      state.battleExtrema,
      state.battleExtremaFixed,
    ),
  )
  const summary = buildRoundSummary(contenders)
  const survivors = contenders.filter((contender) => contender.outcome === 'survived')
  const escaped = contenders.filter((contender) => contender.outcome === 'escaped')
  const survivorEvent: FeedEventInput = {
    id: `${state.roundId}-survivors`,
    type: 'survivor',
    title: `${survivors.length} SURVIVED · ${escaped.length} ESCAPED`,
    detail:
      survivors.length > 0
        ? survivors.slice(0, 3).map((contender) => contender.name).join(' · ')
        : escaped.length > 0
          ? 'No untouched flags remained.'
          : 'The line cleared the arena.',
    contenderIds: survivors.map((contender) => contender.id),
    at: 1,
  }
  const existing = state.feed.filter((event) => event.id !== survivorEvent.id)
  const appended = appendFeedEvents(
    existing,
    state.nextEventSequence,
    [survivorEvent],
  )
  return {
    ...enterPhase(state, 'result', now),
    battleIndex: Math.max(0, state.battlePath.length - 1),
    lineValue: state.battlePath[state.battlePath.length - 1] ?? state.lineValue,
    lineValueFixed: state.battlePathFixed?.[state.battlePath.length - 1]
      ?? state.lineValueFixed,
    contenders,
    feed: appended.feed,
    nextEventSequence: appended.nextSequence,
    summary,
    playerEliminated: getPlayer({ contenders }).outcome === 'hit',
  }
}

export function playBattleToEnd(
  state: RoundState,
  now = state.phaseStartedAt + PHASE_DURATIONS.battle,
): RoundState {
  const battleState = state.phase === 'battle' ? state : beginBattle(state, state.phaseStartedAt)
  return finishRound(resolveBattleStep(battleState, battleState.battlePath.length - 1), now)
}

function updatePhaseClock(state: RoundState, now: number): RoundState {
  if (state.phaseDuration <= 0) return state
  const elapsed = Math.max(0, now - state.phaseStartedAt)
  const progress = clamp(elapsed / state.phaseDuration, 0, 1)
  return {
    ...state,
    phaseProgress: progress,
    timeRemaining: Math.max(0, state.phaseDuration - elapsed),
  }
}

/** Advances animation, bot decisions, hits and phase transitions from one wall-clock tick. */
export function tickRound(
  state: RoundState,
  now: number,
  difficulty: BotDifficulty = 'normal',
): RoundState {
  let next = state
  let transitions = 0

  while (transitions < 8) {
    next = updatePhaseClock(next, now)
    const elapsed = Math.max(0, now - next.phaseStartedAt)

    if (next.phase === 'placement') {
      next = updateBotsForPlacement(next, Math.min(elapsed, PHASE_DURATIONS.placement), difficulty)
    }
    if (next.phase === 'battle') {
      const progress = clamp(elapsed / PHASE_DURATIONS.battle, 0, 1)
      const index = Math.floor(progress * Math.max(0, next.battlePath.length - 1))
      next = resolveBattleStep(next, index)
    }
    if (next.phaseDuration <= 0 || elapsed < next.phaseDuration) return next

    const boundary = next.phaseStartedAt + next.phaseDuration
    switch (next.phase) {
      case 'home':
        return next
      case 'deck':
        next = enterPhase(next, 'approach', boundary)
        break
      case 'approach':
        next = startPlacement(next, boundary)
        break
      case 'placement':
        next = lockPlacements(next, boundary)
        break
      case 'lock':
        next = beginBattle(next, boundary)
        break
      case 'battle':
        return finishRound(resolveBattleStep(next, next.battlePath.length - 1), boundary)
      case 'result':
        return next
    }
    transitions += 1
  }

  return next
}

export function roundPacing(state: RoundState): RoundPacing {
  const hitEvents = state.feed.filter((event) => event.type === 'hit')
  const clusterEvents = state.feed.filter((event) => event.type === 'cluster')
  return {
    survivors: state.contenders.filter((contender) => contender.outcome === 'survived').length,
    escaped: state.contenders.filter((contender) => contender.outcome === 'escaped').length,
    firstHitAt: hitEvents.length > 0 ? Math.min(...hitEvents.map((event) => event.at)) : null,
    largestCluster: clusterEvents.reduce(
      (largest, event) => Math.max(largest, event.contenderIds.length),
      0,
    ),
    clusterWipes: clusterEvents.length,
  }
}

export function availableDecks(): readonly DeckDefinition[] {
  return DECKS
}
