import type {
  BotDifficulty,
  BotProfile,
  Candle,
  Contender,
  DeckDefinition,
  FeedEvent,
  FlagSide,
  RoundState,
  RoundSummary,
} from './types'
import {
  assertActiveEngine,
  ensureScoringEngineForDeck,
  scoringEngineDescriptorIsValid,
  type ScoringEngineDescriptor,
  type ScoringEngineMode,
} from '../engine'
import { BOT_PROFILES, isCanonicalPracticeBotRoster } from './bots'
import { canonicalDigest, canonicalStringify } from './canonical'
import { randomHex, sha256Hex } from './crypto'
import { ESCAPE_CLOSE_BEFORE_END_MS, ESCAPE_UNLOCK_MS } from './escape'
import {
  PHASE_DURATIONS,
  PLACEMENT_INPUT_FREEZE_MS,
  beginBattle,
  createRound,
  executeEscapeCommand,
  lockPlacements,
  playBattleToEnd,
  resolveBattleStep,
  roundIdFor,
  startPlacement,
  updateBotsForPlacement,
  updatePlayerPlacement,
} from './round'

export const REPLAY_PROTOCOL_VERSION = 'strikefall/replay/v4'
export const COMMITMENT_ALGORITHM = 'SHA-256'
export const ROUND_AUTHORITY = 'local-practice/v1'

export interface ReplayPath {
  approach: Candle[]
  battlePath: number[]
  battleExtrema: RoundState['battleExtrema']
}

export interface ReplaySeedMaterial {
  masterSeed: string
  pathSeed: string
  botSeed: string
  salt: string
}

export interface PlayerPlacementEvent {
  /** Milliseconds after placement opens. Equal timestamps resolve in sequence order. */
  at: number
  sequence: number
  side: FlagSide
  distance: number
}

export interface PlayerEscapeEvent {
  /** Milliseconds after battle opens. Only accepted commands are recorded. */
  at: number
  sequence: number
}

export interface ReplayRecipe {
  difficulty: BotDifficulty
  approachCandles: number
  battleSteps: number
  escapeEnabled: boolean
  playerPlacements: PlayerPlacementEvent[]
  /** Exactly zero or one irreversible player command. */
  playerEscape: PlayerEscapeEvent | null
}

export interface ReplayResultSnapshot {
  roundId: string
  engine: ScoringEngineDescriptor
  lineValue: number
  battleIndex: number
  contenders: Contender[]
  feed: FeedEvent[]
  nextEventSequence: number
  summary: RoundSummary | null
  playerEliminated: boolean
  escapeEnabled: boolean
}

export interface ReplayDigests {
  engine: string
  deck: string
  path: string
  botRoot: string
  bots: string
  recipe: string
  result: string
}

export interface RoundCommitment {
  protocolVersion: typeof REPLAY_PROTOCOL_VERSION
  algorithm: typeof COMMITMENT_ALGORITHM
  roundId: string
  roundAuthority: typeof ROUND_AUTHORITY
  engineMode: ScoringEngineMode
  engineVersion: string
  engineDigest: string
  engineRankable: boolean
  deckDigest: string
  pathDigest: string
  botRootDigest: string
  escapeEnabled: boolean
  value: string
}

export interface CommitmentReveal {
  roundId: string
  engine: ScoringEngineDescriptor
  deck: DeckDefinition
  path: ReplayPath
  botSeed: string
  botProfiles: readonly BotProfile[]
  salt: string
  escapeEnabled: boolean
}

export interface ReplayBundle {
  protocolVersion: typeof REPLAY_PROTOCOL_VERSION
  roundId: string
  roundAuthority: typeof ROUND_AUTHORITY
  engine: ScoringEngineDescriptor
  deck: DeckDefinition
  botProfiles: BotProfile[]
  recipe: ReplayRecipe
  reveal: ReplaySeedMaterial
  path: ReplayPath
  lockedContenders: Contender[]
  result: ReplayResultSnapshot
  digests: ReplayDigests
  commitment: RoundCommitment
}

export interface BuildReplayOptions {
  masterSeed: string
  deck: DeckDefinition
  engine?: ScoringEngineDescriptor
  salt?: string
  roundId?: string
  difficulty?: BotDifficulty
  approachCandles?: number
  battleSteps?: number
  /** Canonical roster committed into this local practice proof. */
  botProfiles?: readonly BotProfile[]
  escapeEnabled?: boolean
  playerPlacements?: ReadonlyArray<Omit<PlayerPlacementEvent, 'sequence'> & { sequence?: number }>
  playerEscape?: Omit<PlayerEscapeEvent, 'sequence'> & { sequence?: number }
}

export interface ReplayRegeneration {
  locked: RoundState
  result: RoundState
}

export interface VerificationResult {
  valid: boolean
  errors: string[]
}

export interface ReplayVerification extends VerificationResult {
  /** Local Practice is always unranked even though its scorer is exact WASM. */
  rankable: boolean
  regenerated: ReplayRegeneration | null
}

function enginePayload(engine: ScoringEngineDescriptor) {
  return {
    mode: engine.mode,
    engineVersion: engine.engineVersion,
    digest: engine.digest,
    rankable: engine.rankable,
    rustDeckId: engine.rustDeckId,
    rustDeckVersion: engine.rustDeckVersion,
    pricingVarianceFixed: engine.pricingVarianceFixed,
    driftPerVarianceFixed: engine.driftPerVarianceFixed,
    pathSource: engine.pathSource,
  }
}

function deckPayload(deck: DeckDefinition) {
  return {
    id: deck.id,
    version: deck.version,
    monitoringConvention: deck.monitoringConvention,
    name: deck.name,
    kicker: deck.kicker,
    description: deck.description,
    tacticalHint: deck.tacticalHint,
    variance: [...deck.variance],
    openingRunway: deck.openingRunway ? { ...deck.openingRunway } : undefined,
    hue: deck.hue,
    tempo: deck.tempo,
  }
}

function pathPayload(path: ReplayPath) {
  return {
    approach: path.approach.map((candle) => ({
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })),
    battlePath: [...path.battlePath],
    battleExtrema: path.battleExtrema.map((extrema) => ({ ...extrema })),
  }
}

function profilePayload(profile: BotProfile) {
  return {
    id: profile.id,
    name: profile.name,
    persona: profile.persona,
    color: profile.color,
    riskRange: [...profile.riskRange],
    latencyRange: [...profile.latencyRange],
    moveRange: [...profile.moveRange],
    riskAversion: profile.riskAversion,
    hysteresis: profile.hysteresis,
    escapePolicy: { ...profile.escapePolicy },
  }
}

function movePayload(move: Contender['moves'][number]) {
  return {
    at: move.at,
    completed: move.completed,
    targetSide: move.targetSide,
    targetDistance: move.targetDistance,
    reason: move.reason,
  }
}

/** Replay v4 regenerates fixed values; keep its committed wire shape stable. */
function escapePayload(escape: NonNullable<Contender['escape']>) {
  return {
    frame: escape.frame,
    at: escape.at,
    survivalProbability: escape.survivalProbability,
    terminalScore: escape.terminalScore,
    bankedScore: escape.bankedScore,
    holdOutcome: escape.holdOutcome,
    holdHitAt: escape.holdHitAt,
  }
}

function contenderPayload(contender: Contender) {
  return {
    id: contender.id,
    name: contender.name,
    persona: contender.persona,
    isPlayer: contender.isPlayer,
    side: contender.side,
    distance: contender.distance,
    barrier: contender.barrier,
    risk: contender.risk,
    crowd: contender.crowd,
    potential: contender.potential,
    color: contender.color,
    outcome: contender.outcome,
    hitAt: contender.hitAt,
    closestApproach: contender.closestApproach,
    escape: contender.escape ? escapePayload(contender.escape) : null,
    moves: contender.moves.map(movePayload),
  }
}

function botPlacementPayload(contender: Contender) {
  return {
    id: contender.id,
    persona: contender.persona,
    side: contender.side,
    distance: contender.distance,
    barrier: contender.barrier,
    risk: contender.risk,
    crowd: contender.crowd,
    potential: contender.potential,
    moves: contender.moves.map(movePayload),
  }
}

function feedPayload(event: FeedEvent) {
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    title: event.title,
    detail: event.detail,
    contenderIds: [...event.contenderIds],
    at: event.at,
  }
}

function summaryPayload(summary: RoundSummary | null) {
  if (!summary) return null
  return {
    outcome: summary.outcome,
    score: summary.score,
    rank: summary.rank,
    survived: summary.survived,
    escaped: summary.escaped,
    closestApproach: summary.closestApproach,
    multiplier: summary.multiplier,
    crowd: summary.crowd,
    headline: summary.headline,
    escape: summary.escape ? escapePayload(summary.escape) : null,
  }
}

export async function digestDeck(deck: DeckDefinition): Promise<string> {
  return canonicalDigest({ domain: 'strikefall/deck/v2', deck: deckPayload(deck) })
}

export async function digestScoringEngine(
  engine: ScoringEngineDescriptor,
): Promise<string> {
  return canonicalDigest({
    domain: 'strikefall/scoring-engine/v1',
    engine: enginePayload(engine),
  })
}

export async function digestPath(path: ReplayPath): Promise<string> {
  return canonicalDigest({ domain: 'strikefall/path/v2', path: pathPayload(path) })
}

/** Digest committed before placement; it proves both bot code parameters and seed root. */
export async function digestBotRoot(
  botSeed: string,
  profiles: readonly BotProfile[] = BOT_PROFILES,
): Promise<string> {
  return canonicalDigest({
    domain: 'strikefall/bot-root/v2',
    botSeed,
    profiles: [...profiles]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(profilePayload),
  })
}

/** Digest of the actual locked bot decisions, independent of battle outcomes. */
export async function digestBots(contenders: readonly Contender[]): Promise<string> {
  return canonicalDigest({
    domain: 'strikefall/bot-decisions/v1',
    bots: contenders
      .filter((contender) => !contender.isPlayer)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(botPlacementPayload),
  })
}

export async function digestReplayRecipe(recipe: ReplayRecipe): Promise<string> {
  return canonicalDigest({
    domain: 'strikefall/replay-recipe/v2',
    difficulty: recipe.difficulty,
    approachCandles: recipe.approachCandles,
    battleSteps: recipe.battleSteps,
    escapeEnabled: recipe.escapeEnabled,
    playerPlacements: recipe.playerPlacements.map((event) => ({ ...event })),
    playerEscape: recipe.playerEscape ? { ...recipe.playerEscape } : null,
  })
}

export function resultSnapshot(state: RoundState): ReplayResultSnapshot {
  return {
    roundId: state.roundId,
    engine: { ...state.engine },
    lineValue: state.lineValue,
    battleIndex: state.battleIndex,
    contenders: state.contenders.map((contender) => ({
      ...contender,
      barrierFixed: undefined,
      hitFrameExact: undefined,
      // Live capture metadata is regenerated from the committed path. Keeping
      // it off the wire preserves replay-v4 JSON and digest compatibility.
      closestApproachStep: undefined,
      closestApproachFixed: undefined,
      escape: contender.escape ? escapePayload(contender.escape) : null,
      moves: contender.moves.map((move) => ({ ...move })),
    })),
    feed: state.feed.map((event) => ({ ...event, contenderIds: [...event.contenderIds] })),
    nextEventSequence: state.nextEventSequence,
    summary: state.summary
      ? {
          ...state.summary,
          escape: state.summary.escape ? escapePayload(state.summary.escape) : null,
        }
      : null,
    playerEliminated: state.playerEliminated,
    escapeEnabled: state.escapeEnabled,
  }
}

export async function digestResult(result: ReplayResultSnapshot): Promise<string> {
  return canonicalDigest({
    domain: 'strikefall/result/v3',
    roundId: result.roundId,
    engine: enginePayload(result.engine),
    lineValue: result.lineValue,
    battleIndex: result.battleIndex,
    contenders: [...result.contenders]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(contenderPayload),
    feed: result.feed.map(feedPayload),
    nextEventSequence: result.nextEventSequence,
    summary: summaryPayload(result.summary),
    playerEliminated: result.playerEliminated,
    escapeEnabled: result.escapeEnabled,
  })
}

function seedMessage(domain: 'path' | 'bots', masterSeed: string, roundId: string): string {
  return canonicalStringify({
    protocolVersion: REPLAY_PROTOCOL_VERSION,
    domain: `strikefall/${domain}`,
    masterSeed,
    roundId,
  })
}

export async function deriveRoundSeedMaterial(
  masterSeed: string,
  roundId: string,
  salt = randomHex(32),
): Promise<ReplaySeedMaterial> {
  if (!masterSeed.trim()) throw new RangeError('A master seed is required')
  if (!roundId.trim()) throw new RangeError('A round id is required')
  if (salt.length < 16) throw new RangeError('Commitment salt is too short')
  const [pathSeed, botSeed] = await Promise.all([
    sha256Hex(seedMessage('path', masterSeed, roundId)),
    sha256Hex(seedMessage('bots', masterSeed, roundId)),
  ])
  return { masterSeed, pathSeed, botSeed, salt }
}

function commitmentPayload(
  roundId: string,
  deckDigest: string,
  pathDigest: string,
  botRootDigest: string,
  salt: string,
  escapeEnabled: boolean,
  engine: ScoringEngineDescriptor,
) {
  return {
    protocolVersion: REPLAY_PROTOCOL_VERSION,
    algorithm: COMMITMENT_ALGORITHM,
    roundId,
    roundAuthority: ROUND_AUTHORITY,
    deckDigest,
    pathDigest,
    botRootDigest,
    salt,
    escapeEnabled,
    engine: enginePayload(engine),
  }
}

export async function createRoundCommitment(reveal: CommitmentReveal): Promise<RoundCommitment> {
  if (!reveal.roundId.trim()) throw new RangeError('A round id is required')
  if (!reveal.botSeed.trim()) throw new RangeError('A bot seed is required')
  if (reveal.salt.length < 16) throw new RangeError('Commitment salt is too short')
  if (!scoringEngineDescriptorIsValid(reveal.engine)) {
    throw new RangeError('Scoring engine descriptor is invalid')
  }
  const [deckDigest, pathDigest, botRootDigest] = await Promise.all([
    digestDeck(reveal.deck),
    digestPath(reveal.path),
    digestBotRoot(reveal.botSeed, reveal.botProfiles),
  ])
  const value = await canonicalDigest(
    commitmentPayload(
      reveal.roundId,
      deckDigest,
      pathDigest,
      botRootDigest,
      reveal.salt,
      reveal.escapeEnabled,
      reveal.engine,
    ),
  )
  return {
    protocolVersion: REPLAY_PROTOCOL_VERSION,
    algorithm: COMMITMENT_ALGORITHM,
    roundId: reveal.roundId,
    roundAuthority: ROUND_AUTHORITY,
    engineMode: reveal.engine.mode,
    engineVersion: reveal.engine.engineVersion,
    engineDigest: reveal.engine.digest,
    engineRankable: reveal.engine.rankable,
    deckDigest,
    pathDigest,
    botRootDigest,
    escapeEnabled: reveal.escapeEnabled,
    value,
  }
}

export async function verifyRoundCommitment(
  commitment: RoundCommitment,
  reveal: CommitmentReveal,
  expectedValue = commitment.value,
): Promise<VerificationResult> {
  const errors: string[] = []
  if (commitment.protocolVersion !== REPLAY_PROTOCOL_VERSION) errors.push('commitment:protocol')
  if (commitment.algorithm !== COMMITMENT_ALGORITHM) errors.push('commitment:algorithm')
  if (commitment.roundId !== reveal.roundId) errors.push('commitment:round-id')
  if (commitment.roundAuthority !== ROUND_AUTHORITY) {
    errors.push('commitment:round-authority')
  }
  if (
    commitment.engineMode !== reveal.engine.mode ||
    commitment.engineVersion !== reveal.engine.engineVersion ||
    commitment.engineDigest !== reveal.engine.digest ||
    commitment.engineRankable !== reveal.engine.rankable
  ) {
    errors.push('commitment:engine')
  }
  if (commitment.escapeEnabled !== reveal.escapeEnabled) errors.push('commitment:escape-rule')
  if (commitment.value !== expectedValue) errors.push('commitment:external-value')

  const rebuilt = await createRoundCommitment(reveal)
  if (commitment.deckDigest !== rebuilt.deckDigest) errors.push('commitment:deck')
  if (commitment.pathDigest !== rebuilt.pathDigest) errors.push('commitment:path')
  if (commitment.botRootDigest !== rebuilt.botRootDigest) errors.push('commitment:bot-root')
  if (
    commitment.engineMode !== rebuilt.engineMode ||
    commitment.engineVersion !== rebuilt.engineVersion ||
    commitment.engineDigest !== rebuilt.engineDigest ||
    commitment.engineRankable !== rebuilt.engineRankable
  ) {
    errors.push('commitment:engine')
  }
  if (commitment.value !== rebuilt.value) errors.push('commitment:value')
  return { valid: errors.length === 0, errors }
}

function normalizeRecipe(options: BuildReplayOptions): ReplayRecipe {
  const placementDeadline = PHASE_DURATIONS.placement - PLACEMENT_INPUT_FREEZE_MS
  const playerPlacements = (options.playerPlacements ?? []).map((event, index) => {
    if (!Number.isFinite(event.at) || event.at < 0 || event.at > placementDeadline) {
      throw new RangeError(`Player placement ${index} is outside the placement window`)
    }
    if (!Number.isFinite(event.distance)) {
      throw new RangeError(`Player placement ${index} has an invalid distance`)
    }
    return {
      at: event.at,
      sequence: event.sequence ?? index,
      side: event.side,
      distance: event.distance,
    }
  })
  playerPlacements.sort((left, right) => left.at - right.at || left.sequence - right.sequence)
  const playerEscape = options.playerEscape
    ? {
        at: options.playerEscape.at,
        sequence:
          options.playerEscape.sequence ??
          playerPlacements.reduce(
            (next, event) => Math.max(next, event.sequence + 1),
            0,
          ),
      }
    : null
  const recipe: ReplayRecipe = {
    difficulty: options.difficulty ?? 'normal',
    approachCandles: options.approachCandles ?? 18,
    battleSteps: options.battleSteps ?? 241,
    escapeEnabled: options.escapeEnabled ?? true,
    playerPlacements,
    playerEscape,
  }
  validateRecipe(recipe)
  return recipe
}

function validateRecipe(recipe: ReplayRecipe): void {
  if (!['easy', 'normal', 'hard'].includes(recipe.difficulty)) {
    throw new RangeError('Replay difficulty is invalid')
  }
  if (!Number.isInteger(recipe.approachCandles) || recipe.approachCandles < 1) {
    throw new RangeError('Replay approach candle count is invalid')
  }
  if (!Number.isInteger(recipe.battleSteps) || recipe.battleSteps < 2) {
    throw new RangeError('Replay battle step count is invalid')
  }
  if (typeof recipe.escapeEnabled !== 'boolean') {
    throw new RangeError('Replay Escape rule is invalid')
  }
  const placementDeadline = PHASE_DURATIONS.placement - PLACEMENT_INPUT_FREEZE_MS
  const placementSequences = new Set<number>()
  for (const [index, event] of recipe.playerPlacements.entries()) {
    if (!Number.isFinite(event.at) || event.at < 0 || event.at > placementDeadline) {
      throw new RangeError(`Replay placement ${index} is outside the placement window`)
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 0) {
      throw new RangeError(`Replay placement ${index} has an invalid sequence`)
    }
    if (placementSequences.has(event.sequence)) {
      throw new RangeError(`Replay placement ${index} repeats a command sequence`)
    }
    placementSequences.add(event.sequence)
    if (event.side !== 'upper' && event.side !== 'lower') {
      throw new RangeError(`Replay placement ${index} has an invalid side`)
    }
    if (!Number.isFinite(event.distance)) {
      throw new RangeError(`Replay placement ${index} has an invalid distance`)
    }
  }
  if (recipe.playerEscape) {
    if (!recipe.escapeEnabled) {
      throw new RangeError('Replay Escape command requires the Escape rule')
    }
    if (
      !Number.isFinite(recipe.playerEscape.at) ||
      recipe.playerEscape.at < ESCAPE_UNLOCK_MS ||
      recipe.playerEscape.at >= PHASE_DURATIONS.battle - ESCAPE_CLOSE_BEFORE_END_MS
    ) {
      throw new RangeError('Replay Escape command is outside the Escape window')
    }
    if (!Number.isInteger(recipe.playerEscape.sequence) || recipe.playerEscape.sequence < 0) {
      throw new RangeError('Replay Escape command has an invalid sequence')
    }
    const lastPlacementSequence = recipe.playerPlacements.reduce(
      (latest, event) => Math.max(latest, event.sequence),
      -1,
    )
    if (recipe.playerEscape.sequence <= lastPlacementSequence) {
      throw new RangeError('Replay Escape command is out of sequence')
    }
  }
}

function simulateRecipe(
  roundId: string,
  deck: DeckDefinition,
  recipe: ReplayRecipe,
  seeds: ReplaySeedMaterial,
  engine: ScoringEngineDescriptor,
  botProfiles: readonly BotProfile[],
): ReplayRegeneration {
  validateRecipe(recipe)
  ensureScoringEngineForDeck({
    id: deck.id,
    name: deck.name,
    version: deck.version,
    monitoringConvention: deck.monitoringConvention,
    variance: deck.variance,
    openingRunway: deck.openingRunway,
  }, engine)
  assertActiveEngine(engine)
  let placement = startPlacement(
    createRound(seeds.masterSeed, deck, {
      now: 0,
      roundId,
      pathSeed: seeds.pathSeed,
      botSeed: seeds.botSeed,
      difficulty: recipe.difficulty,
      approachCandles: recipe.approachCandles,
      battleSteps: recipe.battleSteps,
      botProfiles,
      escapeEnabled: recipe.escapeEnabled,
      engine,
    }),
    0,
  )

  const groups = new Map<number, PlayerPlacementEvent[]>()
  for (const event of recipe.playerPlacements) {
    const group = groups.get(event.at) ?? []
    group.push(event)
    groups.set(event.at, group)
  }

  for (const [at, events] of [...groups.entries()].sort((left, right) => left[0] - right[0])) {
    placement = updateBotsForPlacement(placement, Math.max(0, at - 0.000_001), recipe.difficulty)
    for (const event of events.sort((left, right) => left.sequence - right.sequence)) {
      placement = updatePlayerPlacement(placement, event.side, event.distance)
    }
    placement = updateBotsForPlacement(placement, at, recipe.difficulty)
  }

  placement = updateBotsForPlacement(
    placement,
    PHASE_DURATIONS.placement - PLACEMENT_INPUT_FREEZE_MS,
    recipe.difficulty,
  )
  const locked = lockPlacements(placement, PHASE_DURATIONS.placement)
  let battle = beginBattle(
    locked,
    PHASE_DURATIONS.placement + PHASE_DURATIONS.lock,
  )
  if (recipe.playerEscape) {
    const targetFrame = Math.floor(
      (recipe.playerEscape.at / PHASE_DURATIONS.battle) *
      Math.max(0, battle.battlePath.length - 1),
    )
    battle = resolveBattleStep(battle, targetFrame)
    const escaped = executeEscapeCommand(battle, 'player', 'Player command replayed.')
    if (!escaped.accepted) {
      throw new RangeError(
        `Replay Escape command could not resolve: ${escaped.rejection ?? 'unknown'}`,
      )
    }
    battle = escaped.round
  }
  const result = playBattleToEnd(
    battle,
    PHASE_DURATIONS.placement + PHASE_DURATIONS.lock + PHASE_DURATIONS.battle,
  )
  return { locked, result }
}

export function regenerateReplay(bundle: ReplayBundle): ReplayRegeneration {
  return simulateRecipe(
    bundle.roundId,
    bundle.deck,
    bundle.recipe,
    bundle.reveal,
    bundle.engine,
    bundle.botProfiles,
  )
}

export async function buildReplayBundle(options: BuildReplayOptions): Promise<ReplayBundle> {
  const roundId = options.roundId ?? roundIdFor(options.masterSeed, options.deck)
  const engine = ensureScoringEngineForDeck(
    {
      id: options.deck.id,
      name: options.deck.name,
      version: options.deck.version,
      monitoringConvention: options.deck.monitoringConvention,
      variance: options.deck.variance,
      openingRunway: options.deck.openingRunway,
    },
    options.engine,
  )
  assertActiveEngine(engine)
  const recipe = normalizeRecipe(options)
  const selectedProfiles = options.botProfiles ?? BOT_PROFILES
  if (!isCanonicalPracticeBotRoster(selectedProfiles)) {
    throw new RangeError('Local practice replay requires a canonical 9- or 19-bot roster')
  }
  const reveal = await deriveRoundSeedMaterial(options.masterSeed, roundId, options.salt)
  const regenerated = simulateRecipe(
    roundId,
    options.deck,
    recipe,
    reveal,
    engine,
    selectedProfiles,
  )
  const path: ReplayPath = {
    approach: regenerated.result.approach.map((candle) => ({ ...candle })),
    battlePath: [...regenerated.result.battlePath],
    battleExtrema: regenerated.result.battleExtrema.map((extrema) => ({ ...extrema })),
  }
  const botProfiles = selectedProfiles.map((profile) => ({
    ...profile,
    riskRange: [...profile.riskRange] as [number, number],
    latencyRange: [...profile.latencyRange] as [number, number],
    moveRange: [...profile.moveRange] as [number, number],
    escapePolicy: { ...profile.escapePolicy },
  }))
  const result = resultSnapshot(regenerated.result)
  const [engineDigest, deckDigest, pathDigest, botRootDigest, botsDigest, recipeDigest, resultDigest] = await Promise.all([
    digestScoringEngine(engine),
    digestDeck(options.deck),
    digestPath(path),
    digestBotRoot(reveal.botSeed, botProfiles),
    digestBots(regenerated.locked.contenders),
    digestReplayRecipe(recipe),
    digestResult(result),
  ])
  const commitment = await createRoundCommitment({
    roundId,
    engine,
    deck: options.deck,
    path,
    botSeed: reveal.botSeed,
    botProfiles,
    salt: reveal.salt,
    escapeEnabled: recipe.escapeEnabled,
  })

  return {
    protocolVersion: REPLAY_PROTOCOL_VERSION,
    roundId,
    roundAuthority: ROUND_AUTHORITY,
    engine: { ...engine },
    deck: {
      ...options.deck,
      variance: [...options.deck.variance] as [number, number, number, number],
      openingRunway: options.deck.openingRunway ? { ...options.deck.openingRunway } : undefined,
    },
    botProfiles,
    recipe,
    reveal,
    path,
    lockedContenders: regenerated.locked.contenders.map((contender) => ({
      ...contender,
      // Exact lock terms are regenerated from the committed scorer; keep the
      // public replay payload compatible with v4 instead of adding an
      // uncommitted convenience field.
      fixedScore: undefined,
      barrierFixed: undefined,
      hitFrameExact: undefined,
      closestApproachStep: undefined,
      closestApproachFixed: undefined,
      escape: contender.escape ? escapePayload(contender.escape) : null,
      moves: contender.moves.map((move) => ({ ...move })),
    })),
    result,
    digests: {
      engine: engineDigest,
      deck: deckDigest,
      path: pathDigest,
      botRoot: botRootDigest,
      bots: botsDigest,
      recipe: recipeDigest,
      result: resultDigest,
    },
    commitment,
  }
}

function mismatch(errors: string[], label: string, actual: string, expected: string): void {
  if (actual !== expected) errors.push(label)
}

/**
 * `expectedCommitment` should come from the value published before placement.
 * Omitting it still detects accidental corruption, but cannot prove publication time.
 */
export async function verifyReplayBundle(
  bundle: ReplayBundle,
  expectedCommitment = bundle.commitment.value,
): Promise<ReplayVerification> {
  const errors: string[] = []
  let regenerated: ReplayRegeneration | null = null

  try {
    if (bundle.protocolVersion !== REPLAY_PROTOCOL_VERSION) errors.push('bundle:protocol')
    if (bundle.roundId !== bundle.commitment.roundId) errors.push('bundle:round-id')
    if (bundle.roundAuthority !== ROUND_AUTHORITY) errors.push('bundle:round-authority')
    if (!scoringEngineDescriptorIsValid(bundle.engine)) errors.push('bundle:engine')
    if (!isCanonicalPracticeBotRoster(bundle.botProfiles)) errors.push('bundle:bot-roster')

    const derived = await deriveRoundSeedMaterial(
      bundle.reveal.masterSeed,
      bundle.roundId,
      bundle.reveal.salt,
    )
    mismatch(errors, 'seed:path', bundle.reveal.pathSeed, derived.pathSeed)
    mismatch(errors, 'seed:bots', bundle.reveal.botSeed, derived.botSeed)

    const [engineDigest, deckDigest, pathDigest, botRootDigest, botsDigest, recipeDigest, resultDigest] = await Promise.all([
      digestScoringEngine(bundle.engine),
      digestDeck(bundle.deck),
      digestPath(bundle.path),
      digestBotRoot(bundle.reveal.botSeed, bundle.botProfiles),
      digestBots(bundle.lockedContenders),
      digestReplayRecipe(bundle.recipe),
      digestResult(bundle.result),
    ])
    mismatch(errors, 'digest:engine', bundle.digests.engine, engineDigest)
    mismatch(errors, 'digest:deck', bundle.digests.deck, deckDigest)
    mismatch(errors, 'digest:path', bundle.digests.path, pathDigest)
    mismatch(errors, 'digest:bot-root', bundle.digests.botRoot, botRootDigest)
    mismatch(errors, 'digest:bots', bundle.digests.bots, botsDigest)
    mismatch(errors, 'digest:recipe', bundle.digests.recipe, recipeDigest)
    mismatch(errors, 'digest:result', bundle.digests.result, resultDigest)

    const commitmentCheck = await verifyRoundCommitment(
      bundle.commitment,
      {
        roundId: bundle.roundId,
        engine: bundle.engine,
        deck: bundle.deck,
        path: bundle.path,
        botSeed: bundle.reveal.botSeed,
        botProfiles: bundle.botProfiles,
        salt: bundle.reveal.salt,
        escapeEnabled: bundle.recipe.escapeEnabled,
      },
      expectedCommitment,
    )
    errors.push(...commitmentCheck.errors)

    regenerated = regenerateReplay(bundle)
    const regeneratedPath: ReplayPath = {
      approach: regenerated.result.approach,
      battlePath: regenerated.result.battlePath,
      battleExtrema: regenerated.result.battleExtrema,
    }
    const regeneratedResult = resultSnapshot(regenerated.result)
    const [replayedPath, replayedBots, replayedResult] = await Promise.all([
      digestPath(regeneratedPath),
      digestBots(regenerated.locked.contenders),
      digestResult(regeneratedResult),
    ])
    mismatch(errors, 'replay:path', bundle.digests.path, replayedPath)
    mismatch(errors, 'replay:bots', bundle.digests.bots, replayedBots)
    mismatch(errors, 'replay:result', bundle.digests.result, replayedResult)
  } catch (error) {
    errors.push(`bundle:malformed:${error instanceof Error ? error.message : 'unknown error'}`)
  }

  const uniqueErrors = [...new Set(errors)]
  const valid = uniqueErrors.length === 0
  return {
    valid,
    // WASM is scorer eligibility, not round authority. V3 paths and seeds are
    // client-held practice material, so only a later server protocol may rank.
    rankable: false,
    errors: uniqueErrors,
    regenerated,
  }
}
