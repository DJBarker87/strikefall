import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { displayNumberToFixed, fixedToDisplayNumber, fixedToRoundedPoints } from '../engine/fixed'
import {
  applyRankedArenaEvent,
  createHomeRound,
  createRankedArenaRound,
  finalizeRankedArenaRound,
  previewRankedArenaPlacements,
  RANKED_DECK_REVEAL_MS,
  RANKED_INTERACTIVE_PLACEMENT_MS,
} from '../game'
import type { EscapeQuote, FlagSide, RoundState } from '../game'
import {
  createRankedRoundController,
  createWasmRankedRegenerationAdapter,
  reportRankedReplayVerificationFailure,
  RankedHttpError,
  RANKED_LOCK_PHASE_MS,
  type ContenderPlacement,
  type CreateRoundRequest,
  type CreateRoundResponse,
  type EventSourceFactory,
  type LockedScore,
  type RankedApiClient,
  type RankedAttemptState,
  type RankedRoundController,
  type SignedRoundEvent,
} from '../ranked'
import { loadStrikefallWasm, type StrikefallWasmClient } from '../wasm'
import type {
  PlayerEscapeTelemetry,
  StrikefallProofState,
} from './useStrikefallGame'

const SEND_INTERVAL_MS = 130
const FIXED_SCALE = 1_000_000_000_000n
// The server validates the final fixed-point quote inclusively. The UI edits
// barriers as JavaScript display numbers, so exact solver endpoints can round
// a few fixed units outside the accepted band when converted back. Keep the
// slider imperceptibly inside both protocol boundaries.
const RANKED_SURVIVAL_BOUNDARY_INSET = 1_000_000n
const VERIFIER_VERSION = 'strikefall-browser-rust-wasm/v2'

export interface RankedGameStatus {
  available: boolean
  active: boolean
  connection: RankedAttemptState['connection']
  reason: string | null
}

export interface RankedPlacementBounds {
  minimum: number
  maximum: number
}

export type RankedStartOutcome =
  | {
      started: true
      connection: RankedAttemptState['connection']
      reason: null
    }
  | {
      started: false
      connection: RankedAttemptState['connection']
      reason: string
    }

export interface RankedStrikefallGameController {
  round: RoundState
  proof: StrikefallProofState | null
  status: RankedGameStatus
  starting: boolean
  startRound(request?: CreateRoundRequest): Promise<RankedStartOutcome>
  rematch(): Promise<RankedStartOutcome>
  placePlayerFlag(side: FlagSide, distance: number): void
  escapePlayer(): Promise<PlayerEscapeTelemetry | null>
  escapeQuote: EscapeQuote | null
  canEscape: boolean
  escapeTelemetry: PlayerEscapeTelemetry | null
  replayReceipt: 'idle' | 'pending' | 'recorded' | 'failed'
  placementBounds: RankedPlacementBounds | null
  /** Exact SolMath no-touch quote for the current ranked placement. */
  placementSurvivalProbability: number | null
  experimentAssignments: Readonly<Record<string, string>> | null
  close(): void
}

export interface UseRankedStrikefallGameOptions {
  client: RankedApiClient | null
  eventSource?: EventSourceFactory
}

interface PendingPlacement {
  side: FlagSide
  barrier: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function placementId(contenderId: number): string {
  return contenderId === 0 ? 'player' : `bot-${contenderId}`
}

function asLockedScores(scores: ReturnType<StrikefallWasmClient['lockLobbyScores']>): LockedScore[] {
  return scores.map((score) => ({ ...score })) as unknown as LockedScore[]
}

function distanceBoundsForSide(
  wasm: StrikefallWasmClient,
  created: CreateRoundResponse,
  spot: string,
  side: FlagSide,
): RankedPlacementBounds {
  const minimumSurvival = BigInt(created.deck.minInitialSurvival)
    + RANKED_SURVIVAL_BOUNDARY_INSET
  const maximumSurvival = BigInt(created.deck.maxInitialSurvival)
    - RANKED_SURVIVAL_BOUNDARY_INSET
  if (minimumSurvival >= maximumSurvival) {
    throw new RangeError('Ranked survival band is too narrow for safe display editing')
  }
  const minimumBarrier = wasm.barrierForSurvival({
    spot,
    targetSurvival: minimumSurvival,
    remainingVariance: created.deck.totalIntegratedVariance,
    driftPerVariance: created.deck.driftPerVariance,
    side,
  })
  const maximumBarrier = wasm.barrierForSurvival({
    spot,
    targetSurvival: maximumSurvival,
    remainingVariance: created.deck.totalIntegratedVariance,
    driftPerVariance: created.deck.driftPerVariance,
    side,
  })
  const displaySpot = fixedToDisplayNumber(spot)
  const first = Math.abs(fixedToDisplayNumber(minimumBarrier) - displaySpot)
  const second = Math.abs(fixedToDisplayNumber(maximumBarrier) - displaySpot)
  return { minimum: Math.min(first, second), maximum: Math.max(first, second) }
}

function signedEscapeEvent(
  sequence: number,
  contenderId: number,
  escape: { step: number; bankedScore: string; lineValue: string },
): SignedRoundEvent {
  return {
    sequence,
    serverTimeMs: Date.now(),
    previousDigest: '0'.repeat(64),
    kind: { type: 'escape_accepted', data: { contenderId, actor: 'player', escape } },
    digest: '0'.repeat(64),
    signature: '0'.repeat(128),
  } as SignedRoundEvent
}

export function useRankedStrikefallGame(
  options: UseRankedStrikefallGameOptions,
): RankedStrikefallGameController {
  const [round, setRound] = useState<RoundState>(() =>
    // The pre-game shell shares the eagerly initialized Practice preview. A
    // ranked server replaces it with authoritative fixed data on launch.
    createHomeRound('strikefall-home-preview', { now: performance.now() }),
  )
  const [proof, setProof] = useState<StrikefallProofState | null>(null)
  const [status, setStatus] = useState<RankedGameStatus>({
    available: options.client !== null,
    active: false,
    connection: 'idle',
    reason: null,
  })
  const [starting, setStarting] = useState(false)
  const [escapeTelemetry, setEscapeTelemetry] = useState<PlayerEscapeTelemetry | null>(null)
  const [replayReceipt, setReplayReceipt] = useState<'idle' | 'pending' | 'recorded' | 'failed'>('idle')
  const [, forceQuote] = useState(0)
  const roundRef = useRef(round)
  const controllerRef = useRef<RankedRoundController | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const createdRef = useRef<CreateRoundResponse | null>(null)
  const wasmRef = useRef<StrikefallWasmClient | null>(null)
  const placementsRef = useRef(new Map<number, ContenderPlacement>())
  const lockedScoresRef = useRef<readonly LockedScore[]>([])
  const latestPointRef = useRef<{ price: string; varianceElapsed: string; step: number } | null>(null)
  const lastEventRef = useRef(-1)
  const finalizeStartedRef = useRef(false)
  const generationRef = useRef(0)
  const clientSequenceRef = useRef(0)
  const pendingPlacementRef = useRef<PendingPlacement | null>(null)
  const placementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const placementSendingRef = useRef(false)
  const lastSendAtRef = useRef(0)
  const roundStartedAtRef = useRef(0)

  useEffect(() => {
    setStatus((current) => ({ ...current, available: options.client !== null }))
  }, [options.client])

  useEffect(() => {
    roundRef.current = round
  }, [round])

  const publishRound = useCallback((next: RoundState) => {
    roundRef.current = next
    setRound(next)
  }, [])

  const close = useCallback(() => {
    generationRef.current += 1
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    controllerRef.current?.close()
    controllerRef.current = null
    if (placementTimerRef.current !== null) clearTimeout(placementTimerRef.current)
    placementTimerRef.current = null
    pendingPlacementRef.current = null
    placementSendingRef.current = false
    setStatus((current) => ({ ...current, active: false, connection: 'closed' }))
  }, [])

  useEffect(() => close, [close])

  const previewPlacements = useCallback(() => {
    const created = createdRef.current
    const wasm = wasmRef.current
    if (!created || !wasm) return
    const placements = [...placementsRef.current.values()].sort(
      (left, right) => left.contenderId - right.contenderId,
    )
    const spot = created.approach.at(-1)?.price
    if (!spot || placements.length !== 20) return
    try {
      const scores = asLockedScores(wasm.lockLobbyScores({
        spot,
        remainingVariance: created.deck.totalIntegratedVariance,
        driftPerVariance: created.deck.driftPerVariance,
        placements: placements.map((placement) => ({
          contenderId: placement.contenderId,
          side: placement.side,
          barrier: placement.barrier,
        })),
      }))
      publishRound(previewRankedArenaPlacements(roundRef.current, placements, scores))
    } catch (error) {
      setStatus((current) => ({
        ...current,
        reason: `Ranked preview unavailable: ${errorText(error)}`,
      }))
    }
  }, [publishRound])

  const finalize = useCallback(async (
    controller: RankedRoundController,
    created: CreateRoundResponse,
    generation: number,
  ) => {
    if (finalizeStartedRef.current) return
    finalizeStartedRef.current = true
    setProof((current) => current ? { ...current, status: 'verifying', rankable: false } : current)
    try {
      const bundle = await controller.finalize({ timeoutMs: 20_000 })
      if (!bundle || generation !== generationRef.current) return
      publishRound(finalizeRankedArenaRound(roundRef.current, bundle))
      setProof({
        status: 'verified',
        commitmentPrefix: created.commitment.slice(0, 12),
        errors: [],
        rankable: true,
        engineMode: 'wasm-solmath',
        engineVersion: 'solmath/0.2.0+strikefall-ranked/v3',
        engineDigest: roundRef.current.engine.digest,
      })
      setStatus({ available: true, active: true, connection: 'resolved', reason: null })
      setReplayReceipt('pending')
      try {
        await options.client?.acknowledgeReplay(created.roundId, {
          proofDigest: bundle.result.proofDigest,
          verifierVersion: VERIFIER_VERSION,
        })
        setReplayReceipt('recorded')
      } catch (error) {
        setReplayReceipt('failed')
        setStatus((current) => ({
          ...current,
          reason: `Replay verified locally; receipt upload is pending. ${errorText(error)}`,
        }))
      }
    } catch (error) {
      if (generation !== generationRef.current) return
      reportRankedReplayVerificationFailure(error)
      setProof({
        status: 'failed',
        commitmentPrefix: created.commitment.slice(0, 12),
        errors: [errorText(error)],
        rankable: false,
        engineMode: 'wasm-solmath',
        engineVersion: 'solmath/0.2.0+strikefall-ranked/v3',
        engineDigest: roundRef.current.engine.digest,
      })
      setStatus((current) => ({
        ...current,
        active: false,
        connection: 'invalid',
        reason: `Ranked proof failed closed. ${errorText(error)}`,
      }))
    }
  }, [options.client, publishRound])

  const handleEvent = useCallback((
    event: SignedRoundEvent,
    controller: RankedRoundController,
    created: CreateRoundResponse,
    generation: number,
  ) => {
    if (event.sequence <= lastEventRef.current || generation !== generationRef.current) return
    lastEventRef.current = event.sequence
    const kind = event.kind
    if (kind.type === 'round_created') {
      placementsRef.current.set(0, kind.data.playerPlacement)
    } else if (kind.type === 'bot_placement_decision') {
      placementsRef.current.set(kind.data.decision.contenderId, kind.data.decision.placement)
    } else if (kind.type === 'flag_moved') {
      placementsRef.current.set(kind.data.placement.contenderId, kind.data.placement)
    } else if (kind.type === 'placement_locked') {
      lockedScoresRef.current = kind.data.lockedScores
    } else if (kind.type === 'battle_frame') {
      latestPointRef.current = kind.data.point
      forceQuote((value) => value + 1)
    }
    publishRound(applyRankedArenaEvent(roundRef.current, event))
    if (kind.type === 'round_ended') void finalize(controller, created, generation)
  }, [finalize, publishRound])

  const startRound = useCallback(async (request: CreateRoundRequest = {}) => {
    const client = options.client
    if (!client) {
      return {
        started: false,
        connection: 'offline',
        reason: 'Ranked networking is not configured for this session.',
      } as const
    }
    if (starting) {
      return {
        started: false,
        connection: 'connecting',
        reason: 'A ranked round is already being prepared.',
      } as const
    }
    const generation = generationRef.current + 1
    generationRef.current = generation
    setStarting(true)
    unsubscribeRef.current?.()
    controllerRef.current?.close()
    unsubscribeRef.current = null
    controllerRef.current = null
    lastEventRef.current = -1
    finalizeStartedRef.current = false
    clientSequenceRef.current = 0
    placementsRef.current.clear()
    lockedScoresRef.current = []
    latestPointRef.current = null
    setEscapeTelemetry(null)
    setReplayReceipt('idle')
    setProof(null)
    setStatus({ available: true, active: false, connection: 'connecting', reason: null })
    try {
      const loaded = await loadStrikefallWasm({ retry: true })
      if (loaded.status !== 'ready') {
        throw new Error(loaded.status === 'unsupported' ? loaded.reason : loaded.error.message)
      }
      if (generation !== generationRef.current) {
        return {
          started: false,
          connection: 'closed',
          reason: 'Ranked startup was cancelled before the round was created.',
        } as const
      }
      wasmRef.current = loaded.client
      const controller = createRankedRoundController({
        client,
        eventSource: options.eventSource,
        replayRegenerator: createWasmRankedRegenerationAdapter(loaded.client),
        subtleCrypto: globalThis.crypto?.subtle ?? null,
        streamOfflineAfterMs: 6_000,
        streamGapAfterMs: 2_500,
      })
      controllerRef.current = controller
      const created = await controller.start(request, { timeoutMs: 12_000 })
      if (!created || generation !== generationRef.current) {
        const snapshot = controller.state()
        const reason = snapshot.reason ?? 'Ranked service unavailable.'
        setStatus({
          available: true,
          active: false,
          connection: snapshot.connection,
          reason,
        })
        return { started: false, connection: snapshot.connection, reason } as const
      }
      createdRef.current = created
      roundStartedAtRef.current = performance.now()
      placementsRef.current.set(0, created.playerPlacement)
      for (const bot of created.bots) placementsRef.current.set(bot.contenderId, bot)
      publishRound(createRankedArenaRound(created))
      setProof({
        status: 'precommitted',
        commitmentPrefix: created.commitment.slice(0, 12),
        errors: [],
        rankable: true,
        engineMode: 'wasm-solmath',
        engineVersion: 'solmath/0.2.0+strikefall-ranked/v3',
        engineDigest: roundRef.current.engine.digest,
      })
      setStatus({ available: true, active: true, connection: 'connecting', reason: null })
      previewPlacements()
      unsubscribeRef.current = controller.subscribe((snapshot) => {
        if (generation !== generationRef.current) return
        setStatus({
          available: true,
          active: snapshot.mode === 'ranked',
          connection: snapshot.connection,
          reason: snapshot.reason,
        })
        if (snapshot.lastEvent) handleEvent(snapshot.lastEvent, controller, created, generation)
      })
      return { started: true, connection: 'connecting', reason: null } as const
    } catch (error) {
      const reason = `Ranked service unavailable. ${errorText(error)}`
      if (generation === generationRef.current) {
        setStatus({
          available: true,
          active: false,
          connection: 'offline',
          reason,
        })
      }
      return { started: false, connection: 'offline', reason } as const
    } finally {
      if (generation === generationRef.current) setStarting(false)
    }
  }, [handleEvent, options.client, options.eventSource, previewPlacements, publishRound, starting])

  const rematch = useCallback(() => {
    const deck = createdRef.current?.deck
    return startRound(deck ? { deckId: deck.id, deckVersion: deck.version } : {})
  }, [startRound])

  const sendPendingPlacement = useCallback(async () => {
    const controller = controllerRef.current
    const created = createdRef.current
    const pending = pendingPlacementRef.current
    if (!controller || !created || !pending || placementSendingRef.current) return
    const elapsedSinceCreate = performance.now() - roundStartedAtRef.current
    if (elapsedSinceCreate >= created.inputFreezeAtMs - created.createdAtMs) {
      pendingPlacementRef.current = null
      return
    }
    const elapsed = performance.now() - lastSendAtRef.current
    if (elapsed < SEND_INTERVAL_MS) {
      placementTimerRef.current = setTimeout(
        () => void sendPendingPlacement(),
        SEND_INTERVAL_MS - elapsed,
      )
      return
    }
    pendingPlacementRef.current = null
    placementSendingRef.current = true
    const sequence = clientSequenceRef.current + 1
    try {
      const response = await controller.updateFlag({
        side: pending.side,
        barrier: pending.barrier as never,
        clientSequence: sequence,
      })
      clientSequenceRef.current = sequence
      lastSendAtRef.current = performance.now()
      placementsRef.current.set(0, response.placement)
      previewPlacements()
    } catch (error) {
      if (error instanceof RankedHttpError && error.status === 429) {
        pendingPlacementRef.current = pendingPlacementRef.current ?? pending
        placementTimerRef.current = setTimeout(
          () => void sendPendingPlacement(),
          Math.max(SEND_INTERVAL_MS, error.retryAfterMs ?? 0),
        )
      } else {
        setStatus((current) => ({ ...current, reason: errorText(error) }))
      }
    } finally {
      placementSendingRef.current = false
      if (pendingPlacementRef.current && placementTimerRef.current === null) {
        placementTimerRef.current = setTimeout(() => void sendPendingPlacement(), SEND_INTERVAL_MS)
      }
    }
  }, [previewPlacements])

  const placePlayerFlag = useCallback((side: FlagSide, distance: number) => {
    const created = createdRef.current
    const wasm = wasmRef.current
    const elapsedSinceCreate = performance.now() - roundStartedAtRef.current
    if (
      !created
      || !wasm
      || roundRef.current.phase !== 'placement'
      || !Number.isFinite(distance)
      || elapsedSinceCreate >= created.inputFreezeAtMs - created.createdAtMs
    ) return
    const fixedSpot = created.approach.at(-1)?.price ?? '100000000000000'
    const spot = fixedToDisplayNumber(fixedSpot)
    let legalDistance: number
    try {
      const bounds = distanceBoundsForSide(wasm, created, fixedSpot, side)
      legalDistance = Math.min(bounds.maximum, Math.max(bounds.minimum, distance))
    } catch {
      return
    }
    const barrierValue = side === 'upper' ? spot + legalDistance : spot - legalDistance
    if (!(barrierValue > 0)) return
    const barrier = displayNumberToFixed(barrierValue, 'ranked barrier')
    const placement: ContenderPlacement = {
      ...created.playerPlacement,
      side,
      barrier: barrier as ContenderPlacement['barrier'],
    }
    placementsRef.current.set(0, placement)
    previewPlacements()
    pendingPlacementRef.current = { side, barrier }
    if (placementTimerRef.current === null && !placementSendingRef.current) {
      placementTimerRef.current = setTimeout(() => {
        placementTimerRef.current = null
        void sendPendingPlacement()
      }, 0)
    }
  }, [previewPlacements, sendPendingPlacement])

  const escapeQuote = useMemo((): EscapeQuote | null => {
    const created = createdRef.current
    const wasm = wasmRef.current
    const point = latestPointRef.current
    const player = placementsRef.current.get(0)
    const locked = lockedScoresRef.current.find((score) => score.contenderId === 0)
    if (!created || !wasm || !point || !player || !locked || round.phase !== 'battle') return null
    const remaining = BigInt(created.deck.totalIntegratedVariance) - BigInt(point.varianceElapsed)
    if (remaining < 0n) return null
    try {
      const quote = wasm.quoteNoTouch({
        spot: point.price,
        barrier: player.barrier,
        remainingVariance: remaining,
        driftPerVariance: created.deck.driftPerVariance,
        side: player.side,
        alreadyBreached: false,
      })
      const survival = BigInt(quote.survivalProbability)
      const terminal = BigInt(locked.terminalScore)
      const banked = terminal * survival / FIXED_SCALE
      return {
        contenderId: placementId(0),
        frame: point.step,
        at: point.step / Math.max(1, created.deck.battleSteps - 1),
        remainingVariance: fixedToDisplayNumber(remaining.toString()),
        remainingVarianceFixed: remaining.toString(),
        survivalProbability: fixedToDisplayNumber(quote.survivalProbability),
        terminalScore: fixedToRoundedPoints(locked.terminalScore),
        bankedScore: fixedToRoundedPoints(banked.toString()),
        survivalProbabilityFixed: quote.survivalProbability,
        terminalScoreFixed: locked.terminalScore,
        bankedScoreFixed: banked.toString(),
        percentOfMaximum: fixedToDisplayNumber(quote.survivalProbability) * 100,
      }
    } catch {
      return null
    }
  }, [round.phase, round.battleIndex])

  const canEscape = Boolean(
    escapeQuote
    && round.escapeEnabled
    && createdRef.current
    && escapeQuote.frame >= Math.floor(createdRef.current.deck.battleSteps / 2)
    && escapeQuote.frame < createdRef.current.deck.battleSteps
      - Math.ceil(3_000 / createdRef.current.deck.stepMs)
    && round.contenders.find((entry) => entry.isPlayer)?.outcome === 'active',
  )

  const escapePlayer = useCallback(async (): Promise<PlayerEscapeTelemetry | null> => {
    const controller = controllerRef.current
    const created = createdRef.current
    const quote = escapeQuote
    if (!controller || !created || !quote || !canEscape) return null
    const sequence = clientSequenceRef.current + 1
    try {
      const response = await controller.escape({ clientSequence: sequence })
      clientSequenceRef.current = sequence
      publishRound(applyRankedArenaEvent(
        roundRef.current,
        signedEscapeEvent(response.eventSequence, 0, response.escape),
      ))
      const telemetry: PlayerEscapeTelemetry = {
        roundId: created.roundId,
        atMs: Date.now(),
        frame: response.escape.step,
        commandSequence: sequence,
        survivalProbability: quote.survivalProbability,
        terminalScore: quote.terminalScore,
        bankedScore: fixedToRoundedPoints(response.escape.bankedScore),
        percentOfMaximum: quote.percentOfMaximum,
        activeContendersBefore: roundRef.current.contenders.filter(
          (contender) => contender.outcome === 'active',
        ).length,
      }
      setEscapeTelemetry(telemetry)
      return telemetry
    } catch (error) {
      setStatus((current) => ({ ...current, reason: errorText(error) }))
      return null
    }
  }, [canEscape, escapeQuote, publishRound])

  const placementBounds = useMemo((): RankedPlacementBounds | null => {
    const created = createdRef.current
    const wasm = wasmRef.current
    const player = placementsRef.current.get(0)
    const spot = created?.approach.at(-1)?.price
    if (!created || !wasm || !player || !spot) return null
    try {
      return distanceBoundsForSide(wasm, created, spot, player.side)
    } catch {
      return null
    }
  }, [round.contenders, round.roundId])

  const placementSurvivalProbability = useMemo((): number | null => {
    const created = createdRef.current
    const wasm = wasmRef.current
    const player = placementsRef.current.get(0)
    const spot = created?.approach.at(-1)?.price
    if (!created || !wasm || !player || !spot) return null
    try {
      const quote = wasm.quoteNoTouch({
        spot,
        barrier: player.barrier,
        remainingVariance: created.deck.totalIntegratedVariance,
        driftPerVariance: created.deck.driftPerVariance,
        side: player.side,
        alreadyBreached: false,
      })
      return fixedToDisplayNumber(quote.survivalProbability)
    } catch {
      return null
    }
  }, [round.contenders, round.roundId])

  useEffect(() => {
    if (!status.active || round.phase === 'home' || round.phase === 'result') return
    const timer = window.setInterval(() => {
      const created = createdRef.current
      if (!created || !['deck', 'approach', 'placement', 'lock'].includes(roundRef.current.phase)) return
      const totalBeforeLock = Math.max(0, created.placementDeadlineMs - created.createdAtMs)
      const lead = Math.max(0, totalBeforeLock - RANKED_INTERACTIVE_PLACEMENT_MS)
      const deckDuration = lead >= RANKED_DECK_REVEAL_MS ? RANKED_DECK_REVEAL_MS : 0
      const approachDuration = Math.max(0, lead - deckDuration)
      const elapsed = Math.max(0, performance.now() - roundStartedAtRef.current)
      let phase: RoundState['phase'] = 'placement'
      let phaseStart = deckDuration + approachDuration
      const freezeAt = Math.max(phaseStart, created.inputFreezeAtMs - created.createdAtMs)
      let duration = Math.max(1, freezeAt - phaseStart)
      if (deckDuration > 0 && elapsed < deckDuration) {
        phase = 'deck'
        phaseStart = 0
        duration = deckDuration
      } else if (approachDuration > 0 && elapsed < deckDuration + approachDuration) {
        phase = 'approach'
        phaseStart = deckDuration
        duration = approachDuration
      } else if (elapsed >= freezeAt) {
        phase = 'lock'
        phaseStart = freezeAt
        duration = Math.max(1, totalBeforeLock - freezeAt + RANKED_LOCK_PHASE_MS)
      }
      const phaseElapsed = Math.max(0, elapsed - phaseStart)
      const remaining = Math.max(0, duration - phaseElapsed)
      publishRound({
        ...roundRef.current,
        phase,
        phaseStartedAt: roundStartedAtRef.current + phaseStart,
        phaseDuration: duration,
        timeRemaining: remaining,
        phaseProgress: Math.min(1, phaseElapsed / duration),
      })
    }, 100)
    return () => window.clearInterval(timer)
  }, [publishRound, round.phase, status.active])

  return {
    round,
    proof,
    status,
    starting,
    startRound,
    rematch,
    placePlayerFlag,
    escapePlayer,
    escapeQuote,
    canEscape,
    escapeTelemetry,
    replayReceipt,
    placementBounds,
    placementSurvivalProbability,
    experimentAssignments: createdRef.current?.experimentAssignments ?? null,
    close,
  }
}
