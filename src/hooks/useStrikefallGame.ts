import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyLivePlayerPlacement,
  applyLivePlayerEscape,
  canContenderEscape,
  createHomeRound,
  enterPhase,
  finalizeLiveRoundProof,
  isCurrentProofSession,
  makeRoundSeed,
  prepareLiveRound,
  resumeRoundAfterPause,
  getContenderEscapeQuote,
  tickRound,
} from '../game'
import type {
  FlagSide,
  GamePhase,
  EscapeQuote,
  LiveProofContext,
  PlayerEscapeEvent,
  PlayerPlacementEvent,
  ReplayBundle,
  RoundState,
  DeckDefinition,
  BotDifficulty,
  PracticeBotCount,
} from '../game'
import { track } from '../telemetry'
import {
  getScoringEngineStatus,
  type ScoringEngineMode,
  type ScoringEngineStatus,
} from '../engine'

const FRAME_INTERVAL = 1000 / 30

export type StrikefallProofStatus =
  | 'precommitted'
  | 'verifying'
  | 'verified'
  | 'unranked'
  | 'failed'

export interface StrikefallProofState {
  status: StrikefallProofStatus
  commitmentPrefix: string
  errors: string[]
  rankable: boolean
  engineMode: ScoringEngineMode
  engineVersion: string
  engineDigest: string
  replay?: ReplayBundle
}

export interface StrikefallGameController {
  round: RoundState
  proof: StrikefallProofState | null
  engineStatus: ScoringEngineStatus
  /** The active local roster. New runs default to the full 19-bot cast. */
  botCount: PracticeBotCount
  /** The active public-information bot policy. New runs default to normal. */
  difficulty: BotDifficulty
  startRound: (
    deck?: DeckDefinition,
    botCount?: PracticeBotCount,
    difficulty?: BotDifficulty,
  ) => Promise<void>
  /** Omitting botCount or difficulty preserves both active Practice settings. */
  rematch: (
    deck?: DeckDefinition,
    botCount?: PracticeBotCount,
    difficulty?: BotDifficulty,
  ) => Promise<void>
  isPaused: boolean
  canPause: boolean
  togglePause: () => void
  placePlayerFlag: (side: FlagSide, distance: number) => void
  /** Accepts at most once and returns the analytics payload synchronously. */
  escapePlayer: () => PlayerEscapeTelemetry | null
  /** Live model value, including while the midpoint lock is still closed. */
  escapeQuote: EscapeQuote | null
  canEscape: boolean
  escapeTelemetry: PlayerEscapeTelemetry | null
}

export interface PlayerEscapeTelemetry {
  roundId: string
  atMs: number
  frame: number
  commandSequence: number
  survivalProbability: number
  terminalScore: number
  bankedScore: number
  percentOfMaximum: number
  activeContendersBefore: number
}

export interface UseStrikefallGameOptions {
  onEscape?: (data: PlayerEscapeTelemetry) => void
}

interface ActiveProofSession {
  context: LiveProofContext
  placements: PlayerPlacementEvent[]
  escape: PlayerEscapeEvent | null
  nextSequence: number
  verificationStarted: boolean
}

export interface PracticeRoundSettings {
  botCount: PracticeBotCount
  difficulty: BotDifficulty
}

/** Keeps rematches on the same disclosed bot field unless the player changes it. */
export function resolvePracticeRoundSettings(
  isRematch: boolean,
  active: PracticeRoundSettings,
  requestedBotCount?: PracticeBotCount,
  requestedDifficulty?: BotDifficulty,
): PracticeRoundSettings {
  return {
    botCount: requestedBotCount ?? (isRematch ? active.botCount : 19),
    difficulty: requestedDifficulty ?? (isRematch ? active.difficulty : 'normal'),
  }
}

export function useStrikefallGame(
  options: UseStrikefallGameOptions = {},
): StrikefallGameController {
  const [round, setRound] = useState<RoundState>(() =>
    createHomeRound('strikefall-home-preview', { now: performance.now() }),
  )
  const [proof, setProof] = useState<StrikefallProofState | null>(null)
  const [engineStatus, setEngineStatus] = useState<ScoringEngineStatus>(
    getScoringEngineStatus,
  )
  const [escapeTelemetry, setEscapeTelemetry] = useState<PlayerEscapeTelemetry | null>(null)
  const [isPaused, setIsPaused] = useState(false)
  const [botCount, setBotCount] = useState<PracticeBotCount>(19)
  const [difficulty, setDifficulty] = useState<BotDifficulty>('normal')
  const roundRef = useRef(round)
  const lastFrame = useRef(0)
  const lastFlagTelemetry = useRef(0)
  const previousSide = useRef<FlagSide>('upper')
  const previousPhase = useRef<{ roundId: string; phase: GamePhase }>({
    roundId: round.roundId,
    phase: round.phase,
  })
  const seenFeedIds = useRef(new Set(round.feed.map((event) => event.id)))
  const botMoveCount = useRef(0)
  const proofGeneration = useRef(0)
  const proofSession = useRef<ActiveProofSession | null>(null)
  const paused = useRef(false)
  const pausedAt = useRef<number | null>(null)
  const activeBotCount = useRef<PracticeBotCount>(19)
  const activeDifficulty = useRef<BotDifficulty>('normal')
  const mounted = useRef(true)
  const onEscapeRef = useRef(options.onEscape)
  onEscapeRef.current = options.onEscape

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      proofGeneration.current += 1
    }
  }, [])

  useEffect(() => {
    let frame = 0
    const animate = (now: number) => {
      if (paused.current) {
        lastFrame.current = now
        frame = window.requestAnimationFrame(animate)
        return
      }
      if (now - lastFrame.current >= FRAME_INTERVAL) {
        lastFrame.current = now
        setRound((current) => {
          if (current.phase === 'home' || current.phase === 'result') return current
          const next = tickRound(current, now, activeDifficulty.current)
          roundRef.current = next
          return next
        })
      }
      frame = window.requestAnimationFrame(animate)
    }

    frame = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const previous = previousPhase.current
    if (previous.roundId === round.roundId && previous.phase === round.phase) return

    if (previous.roundId !== round.roundId) {
      seenFeedIds.current = new Set(round.feed.map((event) => event.id))
      botMoveCount.current = 0
      const player = round.contenders.find((contender) => contender.isPlayer)
      if (player) previousSide.current = player.side
    }

    if (round.phase === 'approach') {
      track('approach_viewed', { deck: round.deck.id }, round.roundId)
    } else if (round.phase === 'lock') {
      const player = round.contenders.find((contender) => contender.isPlayer)
      const placementBands = new Set(round.contenders.map((contender) => {
        const normalized = (Math.min(8, Math.max(1, contender.risk)) - 1) / 7
        return Math.min(9, Math.floor(normalized * 10))
      }))
      track('placement_locked', {
        side: player?.side ?? 'unknown',
        risk: player?.risk ?? 0,
        crowd: player?.crowd ?? 0,
        potential: player?.potential ?? 0,
        lobbyUpper: round.contenders.filter((contender) => contender.side === 'upper').length,
        lobbyLower: round.contenders.filter((contender) => contender.side === 'lower').length,
        lobbyRiskBands: placementBands.size,
        contenders: round.contenders.length,
      }, round.roundId)
    } else if (round.phase === 'result' && round.summary) {
      track('round_completed', {
        outcome: round.summary.outcome,
        score: round.summary.score,
        rank: round.summary.rank,
        survivors: round.summary.survived,
        escaped: round.summary.escaped,
        eliminated: round.contenders.filter((contender) => contender.outcome === 'hit').length,
        contenders: round.contenders.length,
        escapeAt: round.summary.escape?.at ?? null,
        escapeProbability: round.summary.escape?.survivalProbability ?? null,
        escapeHoldOutcome: round.summary.escape?.holdOutcome ?? 'none',
      }, round.roundId)
    }

    previousPhase.current = { roundId: round.roundId, phase: round.phase }
  }, [round])

  useEffect(() => {
    for (const event of round.feed) {
      if (seenFeedIds.current.has(event.id)) continue
      seenFeedIds.current.add(event.id)
      if (event.type === 'hit') {
        const playerHit = event.contenderIds.includes('player')
        track('flag_hit', { player: playerHit, progress: event.at }, round.roundId)
        if (playerHit) track('player_eliminated', { progress: event.at }, round.roundId)
      } else if (event.type === 'cluster') {
        track('cluster_wipe', { size: event.contenderIds.length, progress: event.at }, round.roundId)
      }
    }
  }, [round.feed, round.roundId])

  useEffect(() => {
    if (round.phase !== 'placement') return
    const completedMoves = round.contenders.reduce(
      (count, contender) => count + contender.moves.filter((move) => move.completed).length,
      0,
    )
    if (completedMoves > botMoveCount.current) {
      track('bot_move_seen', { moves: completedMoves - botMoveCount.current }, round.roundId)
      botMoveCount.current = completedMoves
    }
  }, [round.contenders, round.phase, round.roundId])

  useEffect(() => {
    if (round.phase !== 'result') return
    const session = proofSession.current
    if (
      !session ||
      session.context.roundId !== round.roundId ||
      session.verificationStarted
    ) {
      return
    }

    session.verificationStarted = true
    const generation = proofGeneration.current
    const commitmentPrefix = session.context.commitment.value.slice(0, 12)
    setProof({
      status: 'verifying',
      commitmentPrefix,
      errors: [],
      rankable: false,
      engineMode: session.context.engine.mode,
      engineVersion: session.context.engine.engineVersion,
      engineDigest: session.context.engine.digest,
    })

    void finalizeLiveRoundProof(
      session.context,
      session.placements,
      round,
      session.escape,
    )
      .then(({ bundle, verification }) => {
        if (
          !mounted.current ||
          !isCurrentProofSession(
            { generation, roundId: round.roundId },
            proofSession.current
              ? {
                  generation: proofGeneration.current,
                  roundId: proofSession.current.context.roundId,
                }
              : null,
          )
        ) {
          return
        }
        setProof({
          status: verification.valid
            ? verification.rankable
              ? 'verified'
              : 'unranked'
            : 'failed',
          commitmentPrefix,
          errors: verification.errors,
          rankable: verification.rankable,
          engineMode: session.context.engine.mode,
          engineVersion: session.context.engine.engineVersion,
          engineDigest: session.context.engine.digest,
          replay: bundle,
        })
        track('replay_verified', {
          success: verification.valid,
          rankable: verification.rankable,
          errors: verification.errors.length,
          commitment: commitmentPrefix,
        }, round.roundId)
      })
      .catch((error: unknown) => {
        if (
          !mounted.current ||
          !isCurrentProofSession(
            { generation, roundId: round.roundId },
            proofSession.current
              ? {
                  generation: proofGeneration.current,
                  roundId: proofSession.current.context.roundId,
                }
              : null,
          )
        ) {
          return
        }
        const message = error instanceof Error ? error.message : 'Unknown replay verification error'
        setProof({
          status: 'failed',
          commitmentPrefix,
          errors: [`verification:${message}`],
          rankable: false,
          engineMode: session.context.engine.mode,
          engineVersion: session.context.engine.engineVersion,
          engineDigest: session.context.engine.digest,
        })
      })
  }, [round])

  const begin = useCallback(async (
    isRematch: boolean,
    deck?: DeckDefinition,
    requestedBotCount?: PracticeBotCount,
    requestedDifficulty?: BotDifficulty,
  ) => {
    const nextSettings = resolvePracticeRoundSettings(
      isRematch,
      {
        botCount: activeBotCount.current,
        difficulty: activeDifficulty.current,
      },
      requestedBotCount,
      requestedDifficulty,
    )
    const generation = proofGeneration.current + 1
    proofGeneration.current = generation
    proofSession.current = null
    setProof(null)
    setEscapeTelemetry(null)
    paused.current = false
    pausedAt.current = null
    setIsPaused(false)
    const loadingEngine = getScoringEngineStatus()
    setEngineStatus({
      ...loadingEngine,
      status: 'loading',
      message: 'Loading the SolMath WASM scoring engine…',
    })
    const seed = makeRoundSeed()
    try {
      const prepared = await prepareLiveRound(seed, {
        now: 0,
        deck,
        botCount: nextSettings.botCount,
        difficulty: nextSettings.difficulty,
      })
      if (!mounted.current || generation !== proofGeneration.current) return
      setEngineStatus(getScoringEngineStatus())
      const now = performance.now()
      const next = enterPhase(prepared.round, 'deck', now)
      proofSession.current = {
        context: prepared.proof,
        placements: [],
        escape: null,
        nextSequence: 0,
        verificationStarted: false,
      }
      roundRef.current = next
      activeBotCount.current = nextSettings.botCount
      activeDifficulty.current = nextSettings.difficulty
      setBotCount(nextSettings.botCount)
      setDifficulty(nextSettings.difficulty)
      setRound(next)
      setProof({
        status: 'precommitted',
        commitmentPrefix: prepared.proof.commitment.value.slice(0, 12),
        errors: [],
        rankable: false,
        engineMode: prepared.proof.engine.mode,
        engineVersion: prepared.proof.engine.engineVersion,
        engineDigest: prepared.proof.engine.digest,
      })
      seenFeedIds.current = new Set(next.feed.map((event) => event.id))
      botMoveCount.current = 0
      lastFrame.current = now
      track(isRematch ? 'rematch_started' : 'session_started', {
        deck: next.deck.id,
        contenders: next.contenders.length,
        botDifficulty: nextSettings.difficulty,
      }, next.roundId)
      track('deck_revealed', {
        deck: next.deck.id,
        seed: seed.slice(0, 8),
        commitment: prepared.proof.commitment.value.slice(0, 12),
      }, next.roundId)
    } catch (error) {
      if (!mounted.current || generation !== proofGeneration.current) return
      const failedEngine = getScoringEngineStatus()
      setEngineStatus(failedEngine)
      const message = error instanceof Error ? error.message : 'Unable to prepare round proof'
      setProof({
        status: 'failed',
        commitmentPrefix: '',
        errors: [`precommit:${message}`],
        rankable: false,
        engineMode: failedEngine.descriptor.mode,
        engineVersion: failedEngine.descriptor.engineVersion,
        engineDigest: failedEngine.descriptor.digest,
      })
    }
  }, [])

  const startRound = useCallback(
    (
      deck?: DeckDefinition,
      requestedBotCount?: PracticeBotCount,
      requestedDifficulty?: BotDifficulty,
    ) => begin(false, deck, requestedBotCount, requestedDifficulty),
    [begin],
  )
  const rematch = useCallback(
    (
      deck?: DeckDefinition,
      requestedBotCount?: PracticeBotCount,
      requestedDifficulty?: BotDifficulty,
    ) => begin(true, deck, requestedBotCount, requestedDifficulty),
    [begin],
  )

  const togglePause = useCallback(() => {
    const now = performance.now()
    if (paused.current) {
      const start = pausedAt.current
      if (start === null) return
      const resumed = resumeRoundAfterPause(roundRef.current, Math.max(0, now - start))
      paused.current = false
      pausedAt.current = null
      lastFrame.current = now
      roundRef.current = resumed
      setRound(resumed)
      setIsPaused(false)
      track('practice_resumed', { phase: resumed.phase }, resumed.roundId)
      return
    }

    const current = roundRef.current
    if (current.phase === 'home' || current.phase === 'result') return
    const session = proofSession.current
    const frozen = tickRound(current, now, session?.context.difficulty ?? 'normal')
    if (frozen.phase === 'result') {
      roundRef.current = frozen
      setRound(frozen)
      return
    }
    paused.current = true
    pausedAt.current = now
    roundRef.current = frozen
    setRound(frozen)
    setIsPaused(true)
    track('practice_paused', { phase: frozen.phase }, frozen.roundId)
  }, [])

  const placePlayerFlag = useCallback((side: FlagSide, distance: number) => {
    if (paused.current) return
    const now = performance.now()
    const current = roundRef.current
    const session = proofSession.current
    if (!session || session.context.roundId !== current.roundId) return
    const elapsed = now - current.phaseStartedAt
    const applied = applyLivePlayerPlacement(
      current,
      side,
      distance,
      elapsed,
      session.nextSequence,
      session.context.difficulty,
    )
    if (!applied.event) return
    session.placements.push(applied.event)
    session.nextSequence += 1
    roundRef.current = applied.round
    setRound(applied.round)
    const player = applied.round.contenders.find((contender) => contender.isPlayer)
    const actualSide = player?.side ?? side
    const sideChanged = previousSide.current !== actualSide
    if (sideChanged) {
      track('flag_side_changed', { from: previousSide.current, to: actualSide }, current.roundId)
      previousSide.current = actualSide
    }
    if (now - lastFlagTelemetry.current > 150) {
      track('flag_move', {
        side: actualSide,
        distance: player?.distance ?? distance,
        risk: player?.risk ?? 0,
        crowd: player?.crowd ?? 0,
      }, current.roundId)
      lastFlagTelemetry.current = now
    }
  }, [])

  const escapePlayer = useCallback((): PlayerEscapeTelemetry | null => {
    if (paused.current) return null
    const session = proofSession.current
    if (!session || session.escape) return null
    const now = performance.now()
    const current = tickRound(roundRef.current, now, session.context.difficulty)
    if (session.context.roundId !== current.roundId) return null
    const elapsedMs = now - current.phaseStartedAt
    const activeContendersBefore = current.contenders.filter(
      (contender) => contender.outcome === 'active',
    ).length
    const applied = applyLivePlayerEscape(
      current,
      elapsedMs,
      session.nextSequence,
    )
    roundRef.current = applied.round
    setRound(applied.round)
    if (!applied.event || !applied.quote) return null

    session.escape = applied.event
    session.nextSequence += 1
    const data: PlayerEscapeTelemetry = {
      roundId: current.roundId,
      atMs: applied.event.at,
      frame: applied.quote.frame,
      commandSequence: applied.event.sequence,
      survivalProbability: applied.quote.survivalProbability,
      terminalScore: applied.quote.terminalScore,
      bankedScore: applied.quote.bankedScore,
      percentOfMaximum: applied.quote.percentOfMaximum,
      activeContendersBefore,
    }
    setEscapeTelemetry(data)
    onEscapeRef.current?.(data)
    return data
  }, [])

  const escapeQuote = getContenderEscapeQuote(round, 'player')
  const canEscape = canContenderEscape(round, 'player')
  const canPause = round.phase !== 'home' && round.phase !== 'result'

  return {
    round,
    proof,
    engineStatus,
    botCount,
    difficulty,
    startRound,
    rematch,
    isPaused,
    canPause,
    togglePause,
    placePlayerFlag,
    escapePlayer,
    escapeQuote,
    canEscape,
    escapeTelemetry,
  }
}
