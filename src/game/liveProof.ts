import type {
  BotDifficulty,
  BotProfile,
  DeckDefinition,
  FlagSide,
  PracticeBotCount,
  RoundState,
} from './types'
import {
  activeEngineMatches,
  initializeScoringEngine,
  type ScoringEngineDescriptor,
} from '../engine'
import { botProfilesForPractice } from './bots'
import { selectDeckForSeed } from './decks'
import {
  ESCAPE_CLOSE_BEFORE_END_MS,
  ESCAPE_UNLOCK_MS,
  type EscapeQuote,
} from './escape'
import {
  PHASE_DURATIONS,
  PLACEMENT_INPUT_FREEZE_MS,
  createRound,
  executeEscapeCommand,
  resolveBattleStep,
  roundIdFor,
  updateBotsForPlacement,
  updatePlayerPlacement,
} from './round'
import {
  type PlayerPlacementEvent,
  type PlayerEscapeEvent,
  type ReplayBundle,
  type ReplayPath,
  type ReplaySeedMaterial,
  type ReplayVerification,
  type RoundCommitment,
  buildReplayBundle,
  createRoundCommitment,
  deriveRoundSeedMaterial,
  digestBots,
  digestDeck,
  digestPath,
  digestResult,
  resultSnapshot,
  verifyReplayBundle,
} from './replay'

export interface LiveProofContext {
  roundId: string
  deck: DeckDefinition
  engine: ScoringEngineDescriptor
  difficulty: BotDifficulty
  approachCandles: number
  battleSteps: number
  botProfiles: readonly BotProfile[]
  escapeEnabled: boolean
  seeds: ReplaySeedMaterial
  commitment: RoundCommitment
}

export interface PreparedLiveRound {
  round: RoundState
  proof: LiveProofContext
}

export interface PrepareLiveRoundOptions {
  now?: number
  deck?: DeckDefinition
  difficulty?: BotDifficulty
  approachCandles?: number
  battleSteps?: number
  botCount?: PracticeBotCount
  escapeEnabled?: boolean
  salt?: string
}

export interface AppliedLivePlacement {
  round: RoundState
  event: PlayerPlacementEvent | null
}

export interface AppliedLiveEscape {
  round: RoundState
  event: PlayerEscapeEvent | null
  quote: EscapeQuote | null
  rejection: string | null
}

export interface FinalizedLiveProof {
  bundle: ReplayBundle
  verification: ReplayVerification
}

export interface ProofSessionIdentity {
  generation: number
  roundId: string
}

export function isCurrentProofSession(
  expected: ProofSessionIdentity,
  active: ProofSessionIdentity | null,
): boolean {
  return (
    active !== null &&
    expected.generation === active.generation &&
    expected.roundId === active.roundId
  )
}

export async function prepareLiveRound(
  masterSeed: string,
  options: PrepareLiveRoundOptions = {},
): Promise<PreparedLiveRound> {
  const deck = options.deck ?? selectDeckForSeed(masterSeed)
  const engineStatus = await initializeScoringEngine({
    id: deck.id,
    name: deck.name,
    version: deck.version,
    monitoringConvention: deck.monitoringConvention,
    variance: deck.variance,
    openingRunway: deck.openingRunway,
  })
  if (engineStatus.status !== 'ready') throw new Error(engineStatus.message)
  const engine = engineStatus.descriptor
  const roundId = roundIdFor(masterSeed, deck)
  const seeds = await deriveRoundSeedMaterial(masterSeed, roundId, options.salt)
  const difficulty = options.difficulty ?? 'normal'
  const botProfiles = botProfilesForPractice(options.botCount ?? 19)
  const escapeEnabled = options.escapeEnabled ?? true
  const round = createRound(masterSeed, deck, {
    now: options.now ?? 0,
    roundId,
    pathSeed: seeds.pathSeed,
    botSeed: seeds.botSeed,
    difficulty,
    approachCandles: options.approachCandles,
    battleSteps: options.battleSteps,
    botProfiles,
    escapeEnabled,
    engine,
  })
  const path: ReplayPath = {
    approach: round.approach,
    battlePath: round.battlePath,
    battleExtrema: round.battleExtrema,
  }
  const commitment = await createRoundCommitment({
    roundId,
    engine,
    deck,
    path,
    botSeed: seeds.botSeed,
    botProfiles,
    salt: seeds.salt,
    escapeEnabled,
  })
  return {
    round,
    proof: {
      roundId,
      deck,
      engine,
      difficulty,
      approachCandles: round.approach.length,
      battleSteps: round.battlePath.length,
      botProfiles,
      escapeEnabled,
      seeds,
      commitment,
    },
  }
}

/**
 * Applies the same public event ordering used by replay regeneration. Inputs
 * in the final 750 ms are ignored, making the progressive lock authoritative.
 */
export function applyLivePlayerPlacement(
  round: RoundState,
  side: FlagSide,
  distance: number,
  elapsedMs: number,
  sequence: number,
  difficulty: BotDifficulty = 'normal',
): AppliedLivePlacement {
  const deadline = PHASE_DURATIONS.placement - PLACEMENT_INPUT_FREEZE_MS
  if (
    round.phase !== 'placement' ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > deadline ||
    !Number.isInteger(sequence) ||
    sequence < 0
  ) {
    return { round, event: null }
  }

  let next = updateBotsForPlacement(round, Math.max(0, elapsedMs - 0.000_001), difficulty)
  next = updatePlayerPlacement(next, side, distance)
  next = updateBotsForPlacement(next, elapsedMs, difficulty)
  const player = next.contenders.find((contender) => contender.isPlayer)
  if (!player) return { round, event: null }
  return {
    round: next,
    event: {
      at: elapsedMs,
      sequence,
      side: player.side,
      distance: player.distance,
    },
  }
}

/** Resolves hits/bot decisions first, then records the player's one command. */
export function applyLivePlayerEscape(
  round: RoundState,
  elapsedMs: number,
  sequence: number,
): AppliedLiveEscape {
  if (
    round.phase !== 'battle' ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < ESCAPE_UNLOCK_MS ||
    elapsedMs >= PHASE_DURATIONS.battle - ESCAPE_CLOSE_BEFORE_END_MS ||
    !Number.isInteger(sequence) ||
    sequence < 0
  ) {
    return {
      round,
      event: null,
      quote: null,
      rejection: 'invalid-command',
    }
  }

  const targetFrame = Math.floor(
    (elapsedMs / PHASE_DURATIONS.battle) *
    Math.max(0, round.battlePath.length - 1),
  )
  const resolved = resolveBattleStep(round, targetFrame)
  const escaped = executeEscapeCommand(resolved, 'player', 'Player command accepted.')
  if (!escaped.accepted) {
    return {
      round: escaped.round,
      event: null,
      quote: escaped.quote,
      rejection: escaped.rejection,
    }
  }
  return {
    round: escaped.round,
    event: { at: elapsedMs, sequence },
    quote: escaped.quote,
    rejection: null,
  }
}

function addMismatch(errors: string[], label: string, actual: string, expected: string): void {
  if (actual !== expected) errors.push(label)
}

/** Builds the replay from captured inputs, verifies it, then binds it to the live result. */
export async function finalizeLiveRoundProof(
  context: LiveProofContext,
  playerPlacements: readonly PlayerPlacementEvent[],
  liveResult: RoundState,
  playerEscape: PlayerEscapeEvent | null = null,
): Promise<FinalizedLiveProof> {
  const bundle = await buildReplayBundle({
    masterSeed: context.seeds.masterSeed,
    deck: context.deck,
    engine: context.engine,
    salt: context.seeds.salt,
    roundId: context.roundId,
    difficulty: context.difficulty,
    approachCandles: context.approachCandles,
    battleSteps: context.battleSteps,
    botProfiles: context.botProfiles,
    escapeEnabled: context.escapeEnabled,
    playerPlacements,
    playerEscape: playerEscape ?? undefined,
  })
  const base = await verifyReplayBundle(bundle, context.commitment.value)
  const errors = [...base.errors]
  if (bundle.commitment.value !== context.commitment.value) {
    errors.push('live:commitment')
  }
  if (liveResult.roundId !== context.roundId) errors.push('live:round-id')
  if (liveResult.pathSeed !== context.seeds.pathSeed) errors.push('live:path-seed')
  if (liveResult.botSeed !== context.seeds.botSeed) errors.push('live:bot-seed')
  if (liveResult.escapeEnabled !== context.escapeEnabled) errors.push('live:escape-rule')
  if (
    liveResult.engine.digest !== context.engine.digest ||
    !activeEngineMatches(context.engine)
  ) {
    errors.push('live:engine')
  }
  if (liveResult.phase !== 'result') errors.push('live:not-finished')

  const livePath: ReplayPath = {
    approach: liveResult.approach,
    battlePath: liveResult.battlePath,
    battleExtrema: liveResult.battleExtrema,
  }
  const [liveDeckDigest, livePathDigest, liveBotsDigest, liveResultDigest] = await Promise.all([
    digestDeck(liveResult.deck),
    digestPath(livePath),
    digestBots(liveResult.contenders),
    digestResult(resultSnapshot(liveResult)),
  ])
  addMismatch(errors, 'live:deck', liveDeckDigest, bundle.digests.deck)
  addMismatch(errors, 'live:path', livePathDigest, bundle.digests.path)
  addMismatch(errors, 'live:bots', liveBotsDigest, bundle.digests.bots)
  addMismatch(errors, 'live:result', liveResultDigest, bundle.digests.result)

  return {
    bundle,
    verification: {
      ...base,
      valid: errors.length === 0,
      rankable: errors.length === 0 && base.rankable,
      errors: [...new Set(errors)],
    },
  }
}
