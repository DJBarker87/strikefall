import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bot,
  Check,
  Eye,
  FlagTriangleRight,
  HelpCircle,
  Lock,
  LogOut,
  Radio,
  RotateCcw,
  Settings,
  Share2,
  ShieldCheck,
  Skull,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react'
import {
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
} from 'react'
import { ArenaCanvas } from './components/ArenaCanvas'
import {
  PracticeDifficultySelector,
  PracticeLobbySelector,
  PracticePauseButton,
} from './components/PracticeControls'
import { ResultStoryStrip } from './components/ResultStoryStrip'
import {
  LeaderboardPanel,
  sendRankedInteractionTelemetry,
  useClosedAlphaSession,
  useClientErrorTelemetry,
  useRankedAlphaTelemetry,
  type RankedInteractionTelemetryInput,
} from './alpha'
import {
  countdownAnnouncement,
  countdownCueSecond,
  createClusterHitCues,
} from './audio/cues'
import { createSoundController } from './audio/sound'
import { useStrikefallGame } from './hooks/useStrikefallGame'
import { useRankedStrikefallGame } from './hooks/useRankedStrikefallGame'
import {
  createAuthenticatedFetchEventSourceFactory,
  createRankedClient,
} from './ranked'
import {
  ESCAPE_CLOSE_PROGRESS,
  ESCAPE_UNLOCK_MS,
  ESCAPE_UNLOCK_PROGRESS,
  estimateSurvivalProbability,
  legalDistanceBounds,
  riskBand,
} from './game'
import type {
  BotDifficulty,
  Contender,
  GamePhase,
  PracticeBotCount,
  RoundState,
} from './game/types'
import { readLocalTelemetry, track } from './telemetry'
import {
  DailyChallengeLaunch,
  DeckMasteryPanel,
  WeeklyChallengeLaunch,
  createProfileRoundRival,
  createRivalryShareContext,
  deriveResultStories,
  authoritativeExperimentVariant,
  loadPreferences,
  selectRelevantRoundRival,
  selectQuickRunDeck,
  shouldReduceMotion as resolveReducedMotion,
  shouldShowBreakReminder,
  useStrikefallProductState,
  weeklyChallengeForMode,
  type DailyChallenge,
  type ChartStylePreference,
  type MotionPreference,
  type TelemetryPreference,
  type WeeklyChallenge,
} from './product'
import {
  createCompositedShareRecorder,
  createShareArtifact,
  createShareFile,
  ESCAPE_CAPTURE_KEY,
  battleMomentClockTime,
  battleStepClockTime,
  clusterWipeCaptureKey,
  exportShareCard,
  nearMissCaptureKey,
  shareFilename,
  shareMomentCaptureKey,
  shareMomentCaptureLabel,
  shareMomentSupportsClip,
  shareStrikefallFile,
  type CompositedShareRecorder,
  type ShareCardFormat,
  type ShareClipFormat,
} from './share'
import {
  createPublicRankedReplayLoader,
} from './replay/publicLoader'
import { createRankedReplayShareUrl } from './replay/shareUrl'
import { canOpenRanked, defaultPlayMode, usePracticeAvailability } from './pwa'

const AlphaMetricsDashboard = lazy(async () => {
  const module = await import('./analytics/AlphaMetricsDashboard')
  return { default: module.AlphaMetricsDashboard }
})
const AuthoritativeMetricsPanel = lazy(async () => {
  const module = await import('./analytics/AuthoritativeMetricsPanel')
  return { default: module.AuthoritativeMetricsPanel }
})
const LocalReplayViewer = lazy(async () => {
  const module = await import('./replay/LocalReplayViewer')
  return { default: module.LocalReplayViewer }
})
const RankedReplayViewer = lazy(async () => {
  const module = await import('./replay/RankedReplayViewer')
  return { default: module.RankedReplayViewer }
})

const ROUND_API_URL = (import.meta.env.VITE_ROUND_API_URL as string | undefined)?.trim() || null

type PlayMode = 'practice' | 'ranked'

const PHASE_LABELS: Record<GamePhase, string> = {
  home: 'Solo survival',
  deck: 'Deck incoming',
  approach: 'Read the tape',
  placement: 'Plant your flag',
  lock: 'Positions locked',
  battle: 'Line is live',
  result: 'Round complete',
}

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const whole = Math.ceil(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function downloadShareBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function scoreSort(left: Contender, right: Contender) {
  if (left.outcome === 'active' && right.outcome !== 'active') return -1
  if (right.outcome === 'active' && left.outcome !== 'active') return 1
  const leftScore = left.outcome === 'escaped' ? left.escape?.bankedScore ?? 0 : left.potential
  const rightScore = right.outcome === 'escaped' ? right.escape?.bankedScore ?? 0 : right.potential
  if (left.outcome !== 'hit' && right.outcome !== 'hit' && rightScore !== leftScore) {
    return rightScore - leftScore
  }
  if (left.outcome !== 'hit' && right.outcome === 'hit') return -1
  if (right.outcome !== 'hit' && left.outcome === 'hit') return 1
  if (left.outcome === 'hit' && right.outcome === 'hit') {
    return (right.hitAt ?? 0) - (left.hitAt ?? 0)
  }
  return right.potential - left.potential
}

function navigateInApp(pathname: string) {
  window.history.pushState({}, '', pathname)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function replayIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/replay/')) return null
  const segment = pathname.slice('/replay/'.length).replace(/\/$/, '')
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function StrikefallGameApp({ autoStartFresh = false }: { autoStartFresh?: boolean }) {
  const practiceGame = useStrikefallGame()
  const practiceAvailability = usePracticeAvailability()
  const [playMode, setPlayMode] = useState<PlayMode>(() =>
    defaultPlayMode(ROUND_API_URL, practiceAvailability.online))
  const [practiceBotCount, setPracticeBotCount] = useState<PracticeBotCount>(19)
  const [practiceDifficulty, setPracticeDifficulty] = useState<BotDifficulty>('normal')
  const rankedAvailable = canOpenRanked(ROUND_API_URL, practiceAvailability.online)
  const {
    profile,
    dailyChallenge,
    dailyProgress,
    weeklyChallenge,
    weeklyProgress,
    deckMastery,
    preferences,
    experiments,
    variant,
    reducedMotion,
    updatePreferences,
    recordRound,
    setCallsign,
    resetLocalData,
  } = useStrikefallProductState()
  const alpha = useClosedAlphaSession({
    baseUrl: playMode === 'ranked' ? ROUND_API_URL : null,
    telemetryConsent: preferences.telemetry === 'shared',
  })
  const alphaToken = useRef(alpha.token)
  alphaToken.current = alpha.token
  const rankedClient = useMemo(() => (
    alpha.baseUrl
      ? createRankedClient({
          baseUrl: alpha.baseUrl,
          bearerToken: () => alphaToken.current ?? '',
        })
      : null
  ), [alpha.baseUrl])
  const rankedEventSource = useMemo(() => (
    alpha.baseUrl
      ? createAuthenticatedFetchEventSourceFactory({
          bearerToken: () => alphaToken.current ?? '',
        })
      : undefined
  ), [alpha.baseUrl])
  const rankedGame = useRankedStrikefallGame({
    client: rankedClient,
    eventSource: rankedEventSource,
  })
  const rankedActive = playMode === 'ranked' && rankedGame.status.active
  const activeGame = rankedActive ? rankedGame : practiceGame
  const {
    round,
    proof,
    placePlayerFlag,
    escapePlayer,
    escapeQuote,
    canEscape,
    escapeTelemetry,
  } = activeGame
  const engineStatus = rankedActive
    ? {
        status: 'ready' as const,
        descriptor: round.engine,
        message: 'Authoritative Rust round · SolMath WASM replay verification',
      }
    : practiceGame.engineStatus
  const [muted, setMuted] = useState(false)
  const [starting, setStarting] = useState(false)
  const [spectating, setSpectating] = useState(false)
  const [shareState, setShareState] = useState<'idle' | 'preparing' | 'shared' | 'saved' | 'error'>('idle')
  const [shareFormat, setShareFormat] = useState<ShareCardFormat>('portrait-9x16')
  const [clipFormats, setClipFormats] = useState<Record<ShareClipFormat, boolean>>({
    'portrait-9x16': false,
    'square-1x1': false,
    'landscape-16x9': false,
  })
  const [arenaCanvas, setArenaCanvas] = useState<HTMLCanvasElement | null>(null)
  const [callsignDraft, setCallsignDraft] = useState(profile.handle)
  const [callsignError, setCallsignError] = useState('')
  const [callsignBusy, setCallsignBusy] = useState(false)
  const [callsignSaved, setCallsignSaved] = useState(false)
  const [resetArmed, setResetArmed] = useState(false)
  const [breakReminderRound, setBreakReminderRound] = useState<string | null>(null)
  const [metricsOpen, setMetricsOpen] = useState(false)
  const [inviteDraft, setInviteDraft] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [rankedFallbackMessage, setRankedFallbackMessage] = useState<string | null>(null)
  const [killcamSnapshot, setKillcamSnapshot] = useState<RoundState | null>(null)
  const [killcamReadyRound, setKillcamReadyRound] = useState<string | null>(null)
  const [localReplayOpen, setLocalReplayOpen] = useState(false)
  const helpDialog = useRef<HTMLDialogElement>(null)
  const helpTrigger = useRef<HTMLButtonElement>(null)
  const helpReturnFocus = useRef<HTMLButtonElement | null>(null)
  const lobbyDialog = useRef<HTMLDialogElement>(null)
  const lobbyTrigger = useRef<HTMLButtonElement>(null)
  const settingsDialog = useRef<HTMLDialogElement>(null)
  const settingsTrigger = useRef<HTMLButtonElement>(null)
  const metricsDialog = useRef<HTMLDialogElement>(null)
  const metricsTrigger = useRef<HTMLButtonElement>(null)
  const localReplayDialog = useRef<HTMLDialogElement>(null)
  const localReplayTrigger = useRef<HTMLButtonElement>(null)
  const shareDialog = useRef<HTMLDialogElement>(null)
  const shareTrigger = useRef<HTMLButtonElement>(null)
  const sound = useMemo(() => createSoundController({ muted }), [])
  const audioRound = useRef(round.roundId)
  const audioFeedIds = useRef(new Set(round.feed.map((event) => event.id)))
  const audioCascadeTimers = useRef(new Set<number>())
  const pendingHitTimers = useRef(new Map<string, number>())
  const soundDisposeTimer = useRef<number | null>(null)
  const escapeUnlockRound = useRef<string | null>(null)
  const recordedRounds = useRef(new Set<string>())
  const degradedRounds = useRef(new Set<string>())
  const respondedEliminationRounds = useRef(new Set<string>())
  const activeChallenge = useRef<DailyChallenge | WeeklyChallenge | null>(null)
  const arenaRecorder = useRef<CompositedShareRecorder | null>(null)
  const heldNearMissCandidate = useRef<{ roundId: string; key: string } | null>(null)
  const freshRunHandled = useRef(false)

  const rankedTelemetryEnabled = preferences.telemetry === 'shared'
    && alpha.status === 'ready'
    && alpha.session?.telemetryConsent === true

  useClientErrorTelemetry({
    enabled: rankedTelemetryEnabled,
    api: alpha.status === 'ready' ? alpha.api : null,
  })

  useRankedAlphaTelemetry({
    enabled: rankedTelemetryEnabled,
    api: alpha.status === 'ready' ? alpha.api : null,
    active: playMode === 'ranked' && rankedGame.status.active,
    round: rankedGame.round,
    escape: rankedGame.escapeTelemetry,
    replayReceipt: rankedGame.replayReceipt,
  })

  const displayHandle = playMode === 'ranked' && alpha.session
    ? alpha.session.handle
    : profile.handle
  const player = round.contenders.find((contender) => contender.isPlayer)
  const alive = round.contenders.filter((contender) => contender.outcome === 'active').length
  const totalContenders = round.contenders.length
  const activeBotCount = Math.max(0, totalContenders - 1)
  const standings = useMemo(
    () => [...round.contenders].sort(scoreSort),
    [round.contenders],
  )
  const relevantRival = useMemo(
    () => selectRelevantRoundRival(round, standings),
    [round, standings],
  )
  const rivalryShare = useMemo(
    () => createRivalryShareContext(profile.rivals, relevantRival),
    [profile.rivals, relevantRival],
  )
  const shareArtifact = useMemo(
    () => createShareArtifact(round, { rivalry: rivalryShare }),
    [round, rivalryShare],
  )
  const shareCaptureKey = shareMomentCaptureKey(shareArtifact.moment)
  const shareCaptureLabel = shareMomentCaptureLabel(shareArtifact.moment)
  const shareClipEligible = shareMomentSupportsClip(shareArtifact.moment)
  const distanceBounds = rankedActive && rankedGame.placementBounds
    ? rankedGame.placementBounds
    : legalDistanceBounds(round.lineValue, player?.side ?? 'upper')
  const survival = rankedActive && rankedGame.placementSurvivalProbability !== null
    ? rankedGame.placementSurvivalProbability
    : player
      ? estimateSurvivalProbability(player.distance, round.lineValue, player.side)
      : 0.5
  const deckStructureVariant = variant('deck-structure')
  const riskDisplayVariant = variant('risk-display')
  const presentedWeeklyChallenge = useMemo(
    () => weeklyChallengeForMode(weeklyChallenge, playMode),
    [playMode, weeklyChallenge],
  )
  const rankedExperimentAssignments = rankedGame.experimentAssignments
    ?? alpha.session?.experiments
    ?? null
  const rankedEscapeVariant = authoritativeExperimentVariant(
    rankedExperimentAssignments,
    'escape',
  )
  const rankedRiskDisplayVariant = authoritativeExperimentVariant(
    rankedExperimentAssignments,
    'risk-display',
  )
  // Escape is core to practice scoring, so it is always on locally; only the
  // ranked service still assigns the escape experiment.
  const escapeExperimentEnabled = rankedActive
    ? rankedEscapeVariant === 'midpoint'
    : true
  const effectiveCanEscape = canEscape && escapeExperimentEnabled
  const showProbabilityRisk = rankedActive
    ? rankedRiskDisplayVariant === 'probability'
    : riskDisplayVariant === 'probability'
  const resultStories = round.phase === 'result'
    ? deriveResultStories(round, standings)
    : null
  const currentMastery = deckMastery.find((mastery) => mastery.deck.id === round.deck.id)
  const masteryLevel = currentMastery?.tier.level ?? 0
  const killcamActive = round.phase === 'battle'
    && round.playerEliminated
    && killcamReadyRound !== round.roundId
    && killcamSnapshot?.roundId === round.roundId
  const arenaRound = killcamActive ? killcamSnapshot : round
  // Display-only option-premium view of the live escape quote; exact scoring
  // still settles through the fixed-point banked score.
  const livePremium = escapeQuote
    ? (escapeQuote.survivalProbability * escapeQuote.terminalScore).toFixed(2)
    : null
  const escapeClosed = round.phase === 'battle' && round.phaseProgress >= ESCAPE_CLOSE_PROGRESS
  const escapeOpensIn = round.phase === 'battle'
    ? Math.max(0, Math.ceil((ESCAPE_UNLOCK_PROGRESS - round.phaseProgress) * 60))
    : ESCAPE_UNLOCK_MS / 1_000
  const shareAsClip = !reducedMotion
    && clipFormats[shareFormat]
    && shareClipEligible
  const publicReplayUrl = rankedActive
    && proof?.status === 'verified'
    && proof.rankable
    && rankedGame.replayReceipt === 'recorded'
    ? createRankedReplayShareUrl(round.roundId, window.location.origin)
    : undefined

  useEffect(() => {
    if (!round.playerEliminated) setSpectating(false)
  }, [round.playerEliminated, round.roundId])

  useEffect(() => {
    if (practiceAvailability.online || playMode !== 'ranked' || round.phase !== 'home') return
    rankedGame.close()
    setPlayMode('practice')
    setRankedFallbackMessage('Ranked needs a connection. Practice remains fully playable offline.')
  }, [playMode, practiceAvailability.online, rankedGame, round.phase])

  useEffect(() => {
    if (round.phase !== 'battle' || !round.playerEliminated) {
      setKillcamSnapshot(null)
      setKillcamReadyRound(null)
      return
    }
    setKillcamSnapshot(round)
    setKillcamReadyRound(null)
    const timer = window.setTimeout(() => {
      setKillcamReadyRound(round.roundId)
      setKillcamSnapshot(null)
    }, 2_000)
    return () => window.clearTimeout(timer)
    // The effect deliberately keys the first elimination transition, not each
    // animation tick in the immutable round snapshot.
  }, [round.phase, round.playerEliminated, round.roundId])

  useEffect(() => {
    if (
      playMode !== 'ranked'
      || rankedGame.starting
      || rankedGame.status.active
      || rankedGame.round.phase === 'home'
      || rankedGame.status.connection === 'idle'
      || degradedRounds.current.has(rankedGame.round.roundId)
    ) return
    degradedRounds.current.add(rankedGame.round.roundId)
    setRankedFallbackMessage(
      `${rankedGame.status.reason ?? 'The verified connection ended.'} This run is local practice and will not enter the leaderboard.`,
    )
    setPlayMode('practice')
    track('ranked_degraded_to_practice', {
      connection: rankedGame.status.connection,
      reason: rankedGame.status.reason ? 'service_unavailable' : 'unknown',
    }, rankedGame.round.roundId)
    void practiceGame.startRound(
      activeChallenge.current?.deck ?? rankedGame.round.deck,
      practiceBotCount,
      practiceDifficulty,
    )
  }, [
    playMode,
    practiceBotCount,
    practiceDifficulty,
    practiceGame.startRound,
    rankedGame.round.phase,
    rankedGame.round.deck,
    rankedGame.round.roundId,
    rankedGame.starting,
    rankedGame.status.active,
    rankedGame.status.connection,
    rankedGame.status.reason,
  ])

  useEffect(() => {
    setShareState('idle')
    setClipFormats({
      'portrait-9x16': false,
      'square-1x1': false,
      'landscape-16x9': false,
    })
    escapeUnlockRound.current = null
    heldNearMissCandidate.current = null
  }, [round.roundId])

  useEffect(() => {
    if (!arenaCanvas) return
    const recorder = createCompositedShareRecorder(
      arenaCanvas,
      shareArtifact.card,
      { recorder: { reducedMotion } },
    )
    arenaRecorder.current = recorder
    return () => {
      if (arenaRecorder.current === recorder) arenaRecorder.current = null
      recorder.dispose()
    }
  }, [arenaCanvas, reducedMotion, round.roundId])

  useEffect(() => {
    arenaRecorder.current?.update(shareArtifact.card)
  }, [shareArtifact])

  useEffect(() => {
    if (round.phase !== 'battle') return
    const report = arenaRecorder.current?.start()
    setClipFormats({
      'portrait-9x16': report?.['portrait-9x16'].status === 'recording',
      'square-1x1': report?.['square-1x1'].status === 'recording',
      'landscape-16x9': report?.['landscape-16x9'].status === 'recording',
    })
  }, [round.phase, round.roundId])

  useEffect(() => {
    if (round.phase !== 'battle') return
    const recorder = arenaRecorder.current
    if (!recorder) return
    for (const event of round.feed) {
      if (event.type !== 'cluster' || event.contenderIds.length < 3) continue
      const priority = Math.min(
        99,
        Math.max(
          80,
          72 + event.contenderIds.length * 4 + (event.contenderIds.includes('player') ? 5 : 0),
        ),
      )
      void recorder.retainMoment(clusterWipeCaptureKey(event.sequence), {
        occurredAtMs: battleMomentClockTime({
          phase: 'battle',
          phaseStartedAt: round.phaseStartedAt,
          phaseDuration: round.phaseDuration,
          at: event.at,
        }),
        priority,
      })
    }
    const playerHitAt = player?.outcome === 'hit' ? player.hitAt : null
    if (playerHitAt !== null && playerHitAt >= 0.9) {
      void recorder.retainMoment(nearMissCaptureKey('late-hit'), {
        occurredAtMs: battleMomentClockTime({
          phase: 'battle',
          phaseStartedAt: round.phaseStartedAt,
          phaseDuration: round.phaseDuration,
          at: playerHitAt,
        }),
        priority: Math.round(84 + playerHitAt * 10),
      })
    }
    const closestStep = player?.outcome === 'active' ? player.closestApproachStep : undefined
    if (
      Number.isInteger(closestStep)
      && (closestStep ?? 0) > 0
      && player
      && player.closestApproach > 0
    ) {
      const key = nearMissCaptureKey('held', closestStep as number)
      if (
        heldNearMissCandidate.current?.roundId !== round.roundId
        || heldNearMissCandidate.current.key !== key
      ) {
        heldNearMissCandidate.current = { roundId: round.roundId, key }
        const reference = Math.max(1, Math.abs(player.barrier), Math.abs(round.lineValue))
        const basisPoints = player.closestApproach / reference * 10_000
        const priority = Math.round(Math.min(94, Math.max(82, 92 - basisPoints * 0.2)))
        void recorder.retainLatestMoment('held-near-miss', key, {
          occurredAtMs: battleStepClockTime({
            phaseStartedAt: round.phaseStartedAt,
            phaseDuration: round.phaseDuration,
            step: closestStep as number,
            battleSteps: Math.max(1, round.battlePath.length - 1),
          }),
          priority,
        })
      }
    }
  }, [
    player?.barrier,
    player?.closestApproach,
    player?.closestApproachStep,
    player?.hitAt,
    player?.outcome,
    round.battlePath.length,
    round.feed,
    round.lineValue,
    round.phase,
    round.phaseDuration,
    round.phaseStartedAt,
    round.roundId,
  ])

  useEffect(() => {
    if (round.phase !== 'result') return
    const recorder = arenaRecorder.current
    if (!recorder) return
    const freezeSelectedMoment = async () => {
      if (shareCaptureKey && shareArtifact.moment?.at !== null && shareArtifact.moment?.at !== undefined) {
        await recorder.retainMoment(shareCaptureKey, {
          occurredAtMs: battleMomentClockTime({
            phase: 'result',
            phaseStartedAt: round.phaseStartedAt,
            phaseDuration: round.phaseDuration,
            at: shareArtifact.moment.at,
          }),
          tailMs: 0,
          priority: shareCaptureKey === ESCAPE_CAPTURE_KEY
            ? 100
            : shareArtifact.moment.impact,
        })
      }
      await recorder.freeze(shareCaptureKey ? 0 : 700)
    }
    void freezeSelectedMoment()
  }, [round.phase, round.phaseDuration, round.phaseStartedAt, round.roundId, shareArtifact, shareCaptureKey])

  useEffect(() => {
    if (round.phase !== 'result' || !round.summary || recordedRounds.current.has(round.roundId)) return
    recordedRounds.current.add(round.roundId)
    recordRound({
      deckId: round.deck.id,
      outcome: round.summary.outcome,
      score: round.summary.score,
      multiplier: round.summary.multiplier,
      dailyChallengeId: activeChallenge.current && !('weekStart' in activeChallenge.current)
        ? activeChallenge.current.id
        : undefined,
      weeklyChallengeId: activeChallenge.current && 'weekStart' in activeChallenge.current
        ? activeChallenge.current.id
        : undefined,
      rank: round.summary.rank,
      escapeLeadSeconds: round.summary.escape?.holdOutcome === 'would-hit'
        && round.summary.escape.holdHitAt !== null
        ? Math.max(0, (round.summary.escape.holdHitAt - round.summary.escape.at) * 60)
        : undefined,
      opponents: standings.flatMap((contender, index) => contender.isPlayer
        ? []
        : [{
            botId: contender.id,
            botName: contender.name,
            persona: contender.persona,
            rank: index + 1,
          }]),
      rival: createProfileRoundRival(relevantRival),
    })
    const completedRounds = profile.rounds + 1
    if (shouldShowBreakReminder(preferences, completedRounds)) {
      setBreakReminderRound(round.roundId)
      track('break_reminder_shown', { completedRounds }, round.roundId)
    }
  }, [preferences, profile.rounds, recordRound, relevantRival, round, standings])

  useEffect(() => {
    if (!effectiveCanEscape || escapeUnlockRound.current === round.roundId) return
    escapeUnlockRound.current = round.roundId
    track('escape_unlocked', {
      progress: round.phaseProgress,
      bankedScore: escapeQuote?.bankedScore ?? 0,
      percentOfMaximum: escapeQuote?.percentOfMaximum ?? 0,
    }, round.roundId)
  }, [effectiveCanEscape, escapeQuote, round.phaseProgress, round.roundId])

  useEffect(() => {
    sound.setMuted(muted)
  }, [muted, sound])

  useEffect(() => {
    sound.playPhase(round.phase, round.deck)
    if (round.phase === 'result' && round.summary) sound.playResult(round.summary)
  }, [round.phase, round.deck, round.summary, sound])

  useEffect(() => {
    if (round.phase !== 'result' || window.innerWidth > 500) return
    const frame = window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }))
    return () => window.cancelAnimationFrame(frame)
  }, [round.phase, round.roundId])

  useEffect(() => {
    if (audioRound.current !== round.roundId) {
      for (const timer of audioCascadeTimers.current) window.clearTimeout(timer)
      audioCascadeTimers.current.clear()
      pendingHitTimers.current.clear()
      audioRound.current = round.roundId
      audioFeedIds.current = new Set(round.feed.map((event) => event.id))
      return
    }
    for (const event of round.feed) {
      if (audioFeedIds.current.has(event.id)) continue
      audioFeedIds.current.add(event.id)
      if (event.type === 'hit') {
        const contenderId = event.contenderIds[0]
        if (!contenderId) continue
        const existing = pendingHitTimers.current.get(contenderId)
        if (existing !== undefined) {
          window.clearTimeout(existing)
          audioCascadeTimers.current.delete(existing)
        }
        const timer = window.setTimeout(() => {
          audioCascadeTimers.current.delete(timer)
          pendingHitTimers.current.delete(contenderId)
          sound.playHit({ player: contenderId === 'player' })
        }, 120)
        pendingHitTimers.current.set(contenderId, timer)
        audioCascadeTimers.current.add(timer)
      } else if (event.type === 'cluster') {
        for (const contenderId of event.contenderIds) {
          const pending = pendingHitTimers.current.get(contenderId)
          if (pending === undefined) continue
          window.clearTimeout(pending)
          audioCascadeTimers.current.delete(pending)
          pendingHitTimers.current.delete(contenderId)
        }
        for (const cue of createClusterHitCues(event.contenderIds)) {
          const timer = window.setTimeout(() => {
            audioCascadeTimers.current.delete(timer)
            sound.playHit({
              clusterIndex: cue.clusterIndex,
              clusterSize: cue.clusterSize,
              player: cue.player,
            })
          }, cue.delayMs)
          audioCascadeTimers.current.add(timer)
        }
      } else if (event.type === 'escape' && event.contenderIds.includes('player')) {
        sound.playEscape()
      }
    }
  }, [round.feed, round.roundId, sound])

  useEffect(() => {
    if (round.phase !== 'placement' || !player) return
    sound.playPlacementTone(player.risk, player.crowd)
  }, [round.phase, player?.risk, player?.crowd, sound])

  useEffect(() => {
    const seconds = countdownCueSecond(round.phase, round.timeRemaining)
    if (seconds !== null) sound.playCountdown(seconds)
  }, [round.phase, round.timeRemaining, sound])

  useEffect(() => {
    if (soundDisposeTimer.current !== null) {
      window.clearTimeout(soundDisposeTimer.current)
      soundDisposeTimer.current = null
    }
    return () => {
      for (const timer of audioCascadeTimers.current) window.clearTimeout(timer)
      audioCascadeTimers.current.clear()
      pendingHitTimers.current.clear()
      sound.stopAll()
      // React StrictMode rehearses cleanup and setup against the same memoized
      // controller. Defer final disposal one task so the rehearsal can cancel
      // it; a real unmount still closes the AudioContext promptly.
      soundDisposeTimer.current = window.setTimeout(() => {
        soundDisposeTimer.current = null
        sound.dispose()
      }, 0)
    }
  }, [sound])

  const showHelp = (trigger?: HTMLButtonElement) => {
    helpReturnFocus.current = trigger ?? helpTrigger.current
    helpDialog.current?.showModal()
  }

  const closeHelp = () => {
    helpDialog.current?.close()
  }

  const sendRankedInteraction = (input: RankedInteractionTelemetryInput) => {
    sendRankedInteractionTelemetry({
      enabled: rankedTelemetryEnabled && playMode === 'ranked',
      api: alpha.status === 'ready' ? alpha.api : null,
      round,
      input,
    })
  }

  const reportDeadPlayerResponse = (action: 'spectate' | 'rematch') => {
    if (!round.playerEliminated || respondedEliminationRounds.current.has(round.roundId)) return
    respondedEliminationRounds.current.add(round.roundId)
    sendRankedInteraction({ name: 'dead_player_response', action })
    if (respondedEliminationRounds.current.size > 100) {
      respondedEliminationRounds.current = new Set([round.roundId])
    }
  }

  const handleHelpClosed = () => {
    if (!preferences.onboardingComplete) {
      updatePreferences({ onboardingComplete: true })
      track('tutorial_completed')
    }
    const returnTarget = helpReturnFocus.current ?? helpTrigger.current
    returnTarget?.focus()
    helpReturnFocus.current = null
  }

  const showLobby = () => {
    lobbyDialog.current?.showModal()
  }

  const closeLobby = () => {
    lobbyDialog.current?.close()
  }

  const showSettings = () => {
    setCallsignDraft(displayHandle)
    setCallsignError('')
    setCallsignSaved(false)
    setResetArmed(false)
    settingsDialog.current?.showModal()
  }

  const showMetrics = () => {
    setMetricsOpen(true)
    metricsDialog.current?.showModal()
  }

  const showLocalReplay = () => {
    if (!practiceGame.proof?.replay) return
    setLocalReplayOpen(true)
    localReplayDialog.current?.showModal()
  }

  const closeLocalReplay = () => {
    localReplayDialog.current?.close()
  }

  const showShare = () => {
    if (!round.summary) return
    setShareState('idle')
    window.scrollTo(0, 0)
    const artifact = shareArtifact
    track('share_opened', {
      outcome: round.summary.outcome,
      score: round.summary.score,
      moment: artifact.moment?.kind ?? 'round-result',
      format: shareFormat,
    }, round.roundId)
    sendRankedInteraction({ name: 'share_opened' })
    shareDialog.current?.showModal()
  }

  const closeShare = () => {
    if (shareState === 'preparing') return
    shareDialog.current?.close()
  }

  const closeMetrics = () => {
    metricsDialog.current?.close()
    setMetricsOpen(false)
    metricsTrigger.current?.focus()
  }

  const closeSettings = () => {
    settingsDialog.current?.close()
  }

  const saveCallsign = async () => {
    if (callsignBusy) return
    setCallsignBusy(true)
    setCallsignSaved(false)
    try {
      const handle = callsignDraft.trim().replace(/\s+/g, ' ')
      if (handle.length < 2) {
        setCallsignError('Callsign must contain at least two characters.')
        return
      }
      if (alpha.status === 'ready') {
        const renamed = await alpha.rename(handle)
        if (!renamed) {
          setCallsignError(alpha.message ?? 'That ranked callsign could not be saved.')
          return
        }
      }
      setCallsign(handle)
      setCallsignError('')
      setCallsignSaved(true)
    } catch (error) {
      setCallsignError(error instanceof Error ? error.message : 'Choose a longer callsign')
    } finally {
      setCallsignBusy(false)
    }
  }

  const joinAlpha = async () => {
    if (inviteBusy) return
    setInviteBusy(true)
    try {
      const joined = await alpha.join(inviteDraft, preferences.telemetry === 'shared')
      if (!joined) return
      setInviteDraft('')
      setPlayMode('ranked')
      track('session_started', { mode: 'ranked', invited: true })
    } finally {
      setInviteBusy(false)
    }
  }

  const selectPlayMode = (mode: PlayMode) => {
    if (mode === 'ranked' && !rankedAvailable) return
    if (mode === playMode) return
    if (mode === 'practice') rankedGame.close()
    setRankedFallbackMessage(null)
    setPlayMode(mode)
    track('session_started', { mode, invited: alpha.status === 'ready' })
  }

  useEffect(() => {
    if (round.phase === 'deck') window.scrollTo(0, 0)
  }, [round.phase, round.roundId])

  const changeTelemetryPreference = (telemetry: TelemetryPreference) => {
    updatePreferences({ telemetry })
    if (alpha.status === 'ready') void alpha.setTelemetryConsent(telemetry === 'shared')
  }

  const resetLocalProfile = () => {
    if (!resetArmed) {
      setResetArmed(true)
      window.setTimeout(() => setResetArmed(false), 3_500)
      return
    }
    resetLocalData()
    alpha.clear()
    rankedGame.close()
    activeChallenge.current = null
    setPlayMode('practice')
    setResetArmed(false)
    setCallsignError('Local profile and event history cleared.')
  }

  const shareResult = async () => {
    if (!round.summary) return
    if (shareState === 'preparing') return
    setShareState('preparing')
    const artifact = shareArtifact
    try {
      const clip = shareAsClip
        ? shareCaptureKey
          ? await arenaRecorder.current?.captureRetainedMoment(shareFormat, shareCaptureKey)
          : await arenaRecorder.current?.captureMoment(shareFormat, 700)
        : undefined
      let blob: Blob
      let usedClip = false
      if (clip?.status === 'ready') {
        blob = clip.blob
        usedClip = true
      } else {
        const card = await exportShareCard(artifact.card, { format: shareFormat })
        if (card.status !== 'ready') {
          throw card.status === 'error'
            ? card.error
            : new Error(card.reason)
        }
        blob = card.blob
      }

      const prepared = createShareFile(blob, artifact.card)
      if (prepared.status === 'ready') {
        const result = await shareStrikefallFile(
          prepared.file,
          artifact.card,
          undefined,
          { publicReplayUrl },
        )
        if (result.status === 'cancelled') {
          setShareState('idle')
          return
        }
        if (result.status === 'shared') {
          setShareState('shared')
        } else {
          downloadShareBlob(prepared.file, prepared.file.name)
          setShareState('saved')
        }
      } else {
        downloadShareBlob(blob, shareFilename(
          artifact.card,
          blob.type.includes('webm') ? 'webm' : blob.type.includes('mp4') ? 'mp4' : 'png',
        ))
        setShareState('saved')
      }
      if (usedClip && clip?.status === 'ready') {
        track('clip_exported', {
          moment: artifact.moment?.kind ?? 'round-result',
          mimeType: blob.type,
          format: shareFormat,
          width: clip.width,
          height: clip.height,
          durationMs: clip.durationMs,
          alignment: clip.alignment ? 'retained-moment' : 'result-tail',
          eventOffsetMs: clip.alignment?.eventOffsetMs ?? null,
        }, round.roundId)
        sendRankedInteraction({ name: 'clip_exported' })
      }
      window.setTimeout(() => setShareState('idle'), 2_400)
    } catch (error) {
      setShareState('error')
      console.warn('Result sharing was unavailable', error)
      window.setTimeout(() => setShareState('idle'), 2_400)
    }
  }

  const switchPlayerSide = (side: 'upper' | 'lower') => {
    if (!player) return
    placePlayerFlag(side, player.distance)
  }

  const changeDistance = (value: number) => {
    if (!player) return
    placePlayerFlag(player.side, value)
  }

  const beginRun = async (
    isRematch = false,
    challenge?: DailyChallenge | WeeklyChallenge,
  ) => {
    if (starting) return
    if (
      playMode === 'ranked'
      && (!practiceAvailability.online || alpha.status !== 'ready')
    ) return
    const featuredRun = challenge ?? (isRematch ? activeChallenge.current : null)
    const localDeck = featuredRun?.deck
      ?? (isRematch ? round.deck : selectQuickRunDeck(deckStructureVariant))
    activeChallenge.current = featuredRun
    setStarting(true)
    try {
      await sound.unlock()
      if (playMode === 'ranked') {
        const outcome = isRematch
          ? await rankedGame.rematch()
          : await rankedGame.startRound(featuredRun
              ? { deckId: featuredRun.rankedDeckId, deckVersion: featuredRun.deckVersion }
              : {})
        if (!outcome.started) {
          setRankedFallbackMessage(
            `${outcome.reason} This run is local practice and will not enter the leaderboard.`,
          )
          setPlayMode('practice')
          track('ranked_degraded_to_practice', {
            connection: outcome.connection,
            reason: 'start_failed',
          })
          if (isRematch) {
            await practiceGame.rematch(localDeck, practiceBotCount, practiceDifficulty)
          } else {
            await practiceGame.startRound(localDeck, practiceBotCount, practiceDifficulty)
          }
        } else {
          setRankedFallbackMessage(null)
        }
      } else if (isRematch) {
        await practiceGame.rematch(localDeck, practiceBotCount, practiceDifficulty)
      } else {
        await practiceGame.startRound(localDeck, practiceBotCount, practiceDifficulty)
      }
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => {
    if (
      !autoStartFresh
      || freshRunHandled.current
      || starting
      || round.phase !== 'home'
    ) return

    if (playMode === 'ranked' && alpha.status === 'loading') return
    if (
      playMode === 'ranked'
      && (!practiceAvailability.online || alpha.status !== 'ready')
    ) {
      rankedGame.close()
      setPlayMode('practice')
      return
    }

    freshRunHandled.current = true
    window.history.replaceState(window.history.state, '', '/')
    void beginRun(false)
  }, [
    alpha.status,
    autoStartFresh,
    playMode,
    practiceAvailability.online,
    rankedGame,
    round.phase,
    starting,
  ])

  const takeEscape = async () => {
    if (!escapeExperimentEnabled) return
    const accepted = await Promise.resolve(escapePlayer())
    if (!accepted) return
    void arenaRecorder.current?.retainMoment(ESCAPE_CAPTURE_KEY, {
      occurredAtMs: battleStepClockTime({
        phaseStartedAt: round.phaseStartedAt,
        phaseDuration: round.phaseDuration,
        step: accepted.frame,
        battleSteps: Math.max(1, round.battlePath.length - 1),
      }),
      // Escape wins the editorial kind tie over a same-impact cluster.
      priority: 100,
    })
    track('escape_pressed', {
      frame: accepted.frame,
      bankedScore: accepted.bankedScore,
      terminalScore: accepted.terminalScore,
      survivalProbability: accepted.survivalProbability,
      activeContenders: accepted.activeContendersBefore,
    }, accepted.roundId)
  }

  const engineCopy = engineStatus.status === 'loading'
    ? 'Loading SolMath…'
    : engineStatus.status === 'ready'
      ? rankedActive ? 'Ranked · Rust + SolMath' : 'Exact SolMath scoring'
      : 'SolMath required'

  const rankedStatusCopy = alpha.status === 'ready'
    ? rankedGame.status.connection === 'resolved'
      ? 'Proof verified'
      : rankedGame.status.active
        ? 'Ranked live'
        : 'Ranked ready'
    : alpha.status === 'loading'
      ? 'Connecting alpha'
      : alpha.status === 'invite_required'
        ? 'Invite required'
        : alpha.status === 'offline'
          ? 'Ranked offline'
          : alpha.status === 'disabled'
            ? 'Practice build'
            : 'Alpha unavailable'

  const proofLabel = `${round.deck.name} v${round.deck.version}`
  const proofCopy = proof?.status === 'verified'
    ? proof.rankable
      ? `${proofLabel} · Ranked replay ${proof.commitmentPrefix} passed every signature, digest, and Rust/WASM regeneration check.`
      : `${proofLabel} · Replay ${proof.commitmentPrefix} verified locally. The next run draws a path nobody has seen.`
    : proof?.status === 'unranked'
      ? `${proofLabel} · Replay ${proof.commitmentPrefix} is internally consistent, but this client-seeded practice path is unranked.`
    : proof?.status === 'verifying'
      ? `${proofLabel} · Checking replay ${proof.commitmentPrefix} against the pre-round commitment…`
      : proof?.status === 'failed'
        ? `${proofLabel} · Replay check failed${proof.errors[0] ? `: ${proof.errors[0]}` : '.'} This run is not rankable.`
        : proof?.status === 'precommitted'
          ? `${proofLabel} · ${rankedActive ? 'Server path' : 'Practice path'} committed as ${proof.commitmentPrefix} before the deck reveal.`
          : `${proofLabel} · Preparing deterministic replay proof.`

  return (
    <div className={`app-shell${reducedMotion ? ' app-shell--reduced-motion' : ''}`}>
      <header className="topbar">
        <div className="brand-lockup" aria-label="Strikefall home">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-copy">
            <span className="brand-name">Strikefall</span>
            <span className="brand-tagline">Plant · outlast · repeat</span>
          </span>
        </div>

        <div className="topbar__status" aria-label="Current round">
          <span className="deck-chip">{round.deck.name}</span>
          <span className="phase-chip">{PHASE_LABELS[round.phase]}</span>
          <span className={`mode-chip mode-chip--${playMode}`}>
            <Radio size={12} aria-hidden="true" />
            {playMode === 'ranked' ? rankedStatusCopy : 'Practice'}
          </span>
          <span className="bot-chip">
            <Bot size={13} aria-hidden="true" /> {activeBotCount} bots
            {playMode === 'practice' && ` · ${round.phase === 'home' ? practiceDifficulty : practiceGame.difficulty}`}
          </span>
          <span className="bot-chip" title={engineStatus.message}>{engineCopy}</span>
        </div>

        <div className="topbar__actions">
          <button
            ref={metricsTrigger}
            className="icon-button icon-button--metrics"
            type="button"
            aria-label="Open alpha metrics dashboard"
            aria-haspopup="dialog"
            onClick={showMetrics}
          >
            <BarChart3 size={19} aria-hidden="true" />
          </button>
          <button
            ref={lobbyTrigger}
            className="icon-button icon-button--lobby"
            type="button"
            aria-label="Open lobby and strike feed"
            aria-haspopup="dialog"
            onClick={showLobby}
          >
            <Bot size={19} aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={muted ? 'Turn sound on' : 'Mute sound'}
            aria-pressed={muted}
            onClick={() => setMuted((current) => !current)}
          >
            {muted ? <VolumeX size={19} aria-hidden="true" /> : <Volume2 size={19} aria-hidden="true" />}
          </button>
          <button
            ref={helpTrigger}
            className="icon-button"
            type="button"
            aria-label="How to play"
            aria-haspopup="dialog"
            onClick={(event) => showHelp(event.currentTarget)}
          >
            <HelpCircle size={19} aria-hidden="true" />
          </button>
          <button
            ref={settingsTrigger}
            className="icon-button"
            type="button"
            aria-label="Player and privacy settings"
            aria-haspopup="dialog"
            onClick={showSettings}
          >
            <Settings size={19} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="game-layout">
        {round.phase !== 'home' && round.phase !== 'deck' && round.phase !== 'result' && (
          <h1 className="sr-only">{PHASE_LABELS[round.phase]} — Strikefall</h1>
        )}
        <section className="game-stage" aria-label="Strikefall arena">
          {rankedFallbackMessage && (
            <div className="ranked-fallback" role="alert">
              <ShieldCheck size={17} aria-hidden="true" />
              <span><strong>Playing locally.</strong> {rankedFallbackMessage}</span>
              <button
                type="button"
                aria-label="Dismiss ranked fallback notice"
                onClick={() => setRankedFallbackMessage(null)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          <div className="status-rail">
            <div className="status-card status-card--phase">
              <div className="phase-readout" role="status" aria-live="polite" aria-atomic="true">
                <span className="status-card__label">Phase</span>
                <strong>{PHASE_LABELS[round.phase]}</strong>
              </div>
              <span className="phase-clock">
                {round.phase === 'home'
                  ? 'READY'
                  : round.phase === 'result'
                    ? 'FINAL'
                    : !rankedActive && practiceGame.isPaused
                      ? 'PAUSED'
                    : formatClock(round.timeRemaining / 1_000)}
              </span>
            </div>
            <div className="status-card status-card--metric">
              <div className="metric">
                <span className="metric__label">Risk reward</span>
                <strong className="metric__value status-card__value--accent">{player?.risk.toFixed(2) ?? '—'}×</strong>
              </div>
            </div>
            <div className="status-card status-card--metric">
              <div className="metric">
                <span className="metric__label">Crowd factor</span>
                <strong className="metric__value">{player?.crowd.toFixed(2) ?? '—'}×</strong>
              </div>
            </div>
            <div className="status-card status-card--metric">
              <div className="metric">
                <span className="metric__label">
                  {player?.outcome === 'escaped'
                    ? 'Banked'
                    : round.phase === 'battle' && player
                      ? 'Option price'
                      : 'Potential'}
                </span>
                <strong className="metric__value">
                  {player?.outcome === 'escaped'
                    ? player.escape?.bankedScore ?? '—'
                    : round.phase === 'battle' && player
                      ? player.outcome === 'hit'
                        ? '0.00'
                        : livePremium ?? player.potential
                      : player?.potential ?? '—'}
                </strong>
              </div>
            </div>
          </div>

          <div className="arena-frame">
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {countdownAnnouncement(round.phase, round.timeRemaining)}
            </span>
            <ArenaCanvas
              round={arenaRound}
              onCanvasReady={setArenaCanvas}
              disabled={round.phase !== 'placement' || (!rankedActive && practiceGame.isPaused)}
              reducedMotion={reducedMotion}
              mutedFlash={preferences.mutedFlash}
              chartStyle={preferences.chartStyle}
              masteryLevel={masteryLevel}
              onPlace={({ side, distance }) => placePlayerFlag(side, distance)}
              ariaLabel={round.phase === 'placement'
                ? 'Strikefall arena. Drag vertically to position your flag. Use arrow keys for fine adjustment and Space to switch sides.'
                : `Strikefall arena during ${PHASE_LABELS[round.phase]}.`}
            />

            {!rankedActive && practiceGame.canPause && (
              <div className="practice-pause-dock">
                <PracticePauseButton
                  paused={practiceGame.isPaused}
                  canPause={practiceGame.canPause}
                  onToggle={practiceGame.togglePause}
                />
              </div>
            )}

            {!rankedActive && practiceGame.isPaused && (
              <div className="practice-paused-veil" role="status" aria-live="polite">
                <span>Practice paused</span>
                <strong>The storm is frozen.</strong>
              </div>
            )}

            {round.phase === 'home' && (
              <div className="arena-overlay">
                <section className="hero-panel">
                  <span className="hero-panel__mark" aria-hidden="true"><Zap size={29} /></span>
                  <p className="eyebrow">Solo stochastic survival</p>
                  <h1>Plant outside.<em>Survive the strike.</em></h1>
                  <p className="hero-panel__copy">
                    Read the setup, place where {playMode === 'ranked' ? 19 : practiceBotCount} bots will not, and watch one unseen line decide the room.
                  </p>
                  <button
                    className={`onboarding-prompt${preferences.onboardingComplete ? ' onboarding-prompt--seen' : ''}`}
                    type="button"
                    aria-haspopup="dialog"
                    onClick={(event) => showHelp(event.currentTarget)}
                  >
                    <HelpCircle size={15} aria-hidden="true" />
                    {preferences.onboardingComplete ? 'Replay the 30-second briefing' : 'New here? Read the 30-second briefing'}
                  </button>
                  <div className={`home-mode-setup home-mode-setup--${playMode}`}>
                    <div className="play-mode-selector" role="group" aria-label="Play mode">
                      <button
                        type="button"
                        aria-pressed={playMode === 'practice'}
                        onClick={() => selectPlayMode('practice')}
                      >
                        <span><Zap size={15} aria-hidden="true" /></span>
                        <strong>Practice</strong>
                        <small>Local · instant</small>
                      </button>
                      <button
                        type="button"
                        aria-pressed={playMode === 'ranked'}
                        aria-describedby={!rankedAvailable ? 'ranked-mode-availability' : undefined}
                        disabled={!rankedAvailable}
                        title={!practiceAvailability.online
                          ? 'Ranked needs a connection; Practice works offline'
                          : ROUND_API_URL
                            ? 'Play the replay-verified closed alpha'
                            : 'Set VITE_ROUND_API_URL to enable ranked play'}
                        onClick={() => selectPlayMode('ranked')}
                      >
                        <span><ShieldCheck size={15} aria-hidden="true" /></span>
                        <strong>Ranked alpha</strong>
                        <small>Verified server</small>
                      </button>
                      {!rankedAvailable && (
                        <p id="ranked-mode-availability" className="ranked-mode-note" role="status">
                          {!practiceAvailability.online
                            ? 'Ranked needs a connection. Practice still works offline.'
                            : 'Ranked is unavailable in this build. Practice stays local.'}
                        </p>
                      )}
                    </div>

                    {playMode === 'practice' && (
                      <>
                        <PracticeLobbySelector
                          compact
                          value={practiceBotCount}
                          disabled={starting}
                          onChange={setPracticeBotCount}
                        />
                        <PracticeDifficultySelector
                          compact
                          value={practiceDifficulty}
                          disabled={starting}
                          onChange={setPracticeDifficulty}
                        />
                      </>
                    )}
                  </div>

                  <div
                    className="home-challenge-launches"
                    role="group"
                    aria-label="Featured challenges"
                  >
                    <DailyChallengeLaunch
                      challenge={dailyChallenge}
                      progress={dailyProgress}
                      starting={starting}
                      disabled={playMode === 'ranked'
                        && (!practiceAvailability.online || alpha.status !== 'ready')}
                      onPlay={(challenge) => void beginRun(false, challenge)}
                    />
                    <WeeklyChallengeLaunch
                      challenge={presentedWeeklyChallenge}
                      progress={weeklyProgress}
                      starting={starting}
                      disabled={playMode === 'ranked'
                        && (!practiceAvailability.online || alpha.status !== 'ready')}
                      onPlay={(challenge) => void beginRun(false, challenge)}
                    />
                  </div>

                  {playMode === 'ranked' && alpha.status === 'invite_required' && (
                    <form className="alpha-invite" onSubmit={(event) => {
                      event.preventDefault()
                      void joinAlpha()
                    }}>
                      <label htmlFor="alpha-invite-code">Closed-alpha invite</label>
                      <div>
                        <input
                          id="alpha-invite-code"
                          type="password"
                          autoComplete="one-time-code"
                          spellCheck={false}
                          autoCapitalize="none"
                          value={inviteDraft}
                          aria-describedby={alpha.message ? 'alpha-invite-message' : undefined}
                          onChange={(event) => setInviteDraft(event.currentTarget.value)}
                        />
                        <button
                          type="submit"
                          disabled={inviteBusy || inviteDraft.trim().length < 8}
                          aria-busy={inviteBusy}
                        >
                          {inviteBusy ? 'Joining…' : 'Join'}
                        </button>
                      </div>
                      {alpha.message && <p id="alpha-invite-message" role="status">{alpha.message}</p>}
                    </form>
                  )}

                  {playMode === 'ranked' && ['loading', 'offline', 'error'].includes(alpha.status) && (
                    <div className={`alpha-connection alpha-connection--${alpha.status}`} role="status">
                      <Radio size={15} aria-hidden="true" />
                      <span>{alpha.message ?? rankedStatusCopy}</span>
                      {(alpha.status === 'offline' || alpha.status === 'error') && (
                        <button type="button" onClick={() => void alpha.retry()}>Retry</button>
                      )}
                    </div>
                  )}

                  {playMode === 'ranked' && alpha.status === 'ready' && (
                    <div className="alpha-connection alpha-connection--ready" role="status">
                      <ShieldCheck size={15} aria-hidden="true" />
                      <span><strong>{alpha.session?.handle}</strong> · anonymous session ready</span>
                    </div>
                  )}
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={starting || (playMode === 'ranked'
                      && (!practiceAvailability.online || alpha.status !== 'ready'))}
                    aria-busy={starting}
                    onClick={() => void beginRun()}
                  >
                    <FlagTriangleRight size={18} aria-hidden="true" />
                    {starting
                      ? engineStatus.status === 'loading'
                        ? 'Loading SolMath…'
                        : 'Seeding arena…'
                      : playMode === 'ranked' ? 'Ranked run' : 'Quick run'}
                  </button>
                  {proof?.status === 'failed' && (
                    <p className="inline-error" role="alert">Could not prepare a verified round. Try again.</p>
                  )}
                  <div className="hero-panel__meta" aria-label="Game details">
                    <span>{displayHandle}</span>
                    <span>
                      {playMode === 'ranked'
                        ? '19-bot lobby'
                        : `${practiceBotCount}-bot lobby · ${practiceDifficulty} read`}
                    </span>
                    <span>{playMode === 'ranked' ? 'Anonymous session' : 'No signup'}</span>
                    <span>Fresh path</span>
                  </div>
                </section>
              </div>
            )}

            {round.phase === 'deck' && (
              <div
                className="arena-overlay"
                tabIndex={0}
                aria-label={`${round.deck.name} deck reveal`}
              >
                <section
                  className="deck-reveal"
                  style={{ '--deck-hue': round.deck.hue } as CSSProperties}
                >
                  <p className="deck-reveal__number">
                    Deck locked · {round.deck.kicker}
                    {proof?.commitmentPrefix ? ` · Proof ${proof.commitmentPrefix}` : ''}
                  </p>
                  <h1>{round.deck.name}</h1>
                  <p className="deck-reveal__copy">{round.deck.description}</p>
                  <div
                    className="deck-shape"
                    role="img"
                    aria-label={`Volatility shape: ${round.deck.variance.join(', ')}`}
                  >
                    {round.deck.variance.map((weight, index) => (
                      <span key={`${round.deck.id}-${index}`} style={{ height: `${Math.max(16, weight / Math.max(...round.deck.variance) * 100)}%` }} />
                    ))}
                  </div>
                </section>
              </div>
            )}

            {round.phase === 'placement' && player && (
              <div className="placement-dock">
                <div className="side-toggle" aria-label="Flag side">
                  <button
                    type="button"
                    aria-pressed={player.side === 'upper'}
                    onClick={() => switchPlayerSide('upper')}
                  >
                    <ArrowUp size={15} aria-hidden="true" /> Above · Call
                  </button>
                  <button
                    type="button"
                    aria-pressed={player.side === 'lower'}
                    onClick={() => switchPlayerSide('lower')}
                  >
                    <ArrowDown size={15} aria-hidden="true" /> Below · Put
                  </button>
                </div>
                <div className="risk-slider">
                  <div className="risk-slider__header">
                    <label htmlFor="flag-distance">Flag distance</label>
                    <output htmlFor="flag-distance" data-risk-display={showProbabilityRisk ? 'probability' : 'danger-band'}>
                      {showProbabilityRisk
                        ? `${(survival * 100).toFixed(0)}% no-touch · ${player.risk.toFixed(2)}×`
                        : `${riskBand(survival)} · ${player.risk.toFixed(2)}×`}
                    </output>
                  </div>
                  <input
                    id="flag-distance"
                    type="range"
                    min={distanceBounds.minimum}
                    max={distanceBounds.maximum}
                    step={(distanceBounds.maximum - distanceBounds.minimum) / 100}
                    value={player.distance}
                    onChange={(event) => changeDistance(Number(event.currentTarget.value))}
                  />
                  <div className="risk-slider__labels" aria-hidden="true">
                    <span>Danger / high score</span>
                    <span>Safer / low score</span>
                  </div>
                  <details className="risk-detail">
                    <summary>Show model survival</summary>
                    <div className="risk-detail__body">
                      <strong>{(survival * 100).toFixed(2)}% no-touch</strong>
                      <span>
                        One-sided estimate for this deck’s remaining schedule · exact SolMath WASM.
                      </span>
                    </div>
                  </details>
                </div>
                <div className="placement-potential">
                  <strong>{player.potential}</strong>
                  <span>if untouched</span>
                </div>
              </div>
            )}

            {round.phase === 'lock' && (
              <div className="lock-callout" aria-live="assertive"><strong>Locked</strong></div>
            )}

            {round.phase === 'battle' && (
              <div className="battle-hint"><span aria-hidden="true" /> {alive} flags still standing</div>
            )}

            {round.phase === 'approach' && (
              <div className="approach-explainer" role="status">
                <small>Step 1 of 3 · Watching history</small>
                <strong>This tape already happened</strong>
                <span>Read its mood. Next you buy a call (above) or put (below) strike, then the line goes live.</span>
              </div>
            )}

            {round.phase === 'battle'
              // Keep the opening beat readable on slower mobile devices; the
              // two-second impact camera remains reserved for eliminations.
              && round.phaseProgress < (8 / 60)
              && player?.outcome === 'active'
              && (
                <div className="last-human-beat" role="status">
                  <small>Last human standing</small>
                  <strong>You versus the bot storm</strong>
                </div>
              )}

            {round.phase === 'battle' && round.escapeEnabled && escapeExperimentEnabled && player && !round.playerEliminated && (
              <div className={`escape-dock${player.outcome === 'escaped' ? ' escape-dock--banked' : ''}`}>
                {player.outcome === 'escaped' && escapeTelemetry ? (
                  <div className="escape-dock__confirmation" role="status">
                    <Check size={18} aria-hidden="true" />
                    <span><strong>{escapeTelemetry.bankedScore} banked</strong><small>Airlock sealed · watching the finish</small></span>
                  </div>
                ) : (
                  <button
                    className="escape-button"
                    type="button"
                    disabled={!effectiveCanEscape}
                    aria-describedby="escape-value"
                    onClick={() => void takeEscape()}
                  >
                    {effectiveCanEscape ? <LogOut size={19} aria-hidden="true" /> : <Lock size={18} aria-hidden="true" />}
                    <span>
                      <strong>
                        {effectiveCanEscape
                          ? `Escape · sell @ ${livePremium ?? escapeQuote?.bankedScore ?? 0}`
                          : escapeClosed
                            ? 'Escape sealed'
                            : `Escape opens in ${escapeOpensIn}s`}
                      </strong>
                      <small id="escape-value">
                        {escapeQuote
                          ? `${escapeQuote.percentOfMaximum.toFixed(0)}% of ${escapeQuote.terminalScore} max payout`
                          : 'One irreversible exit'}
                      </small>
                    </span>
                  </button>
                )}
              </div>
            )}

            {killcamActive && !spectating && (
              <div className="killcam-callout" role="status" aria-live="assertive">
                <span>Impact camera</span>
                <strong>Touch confirmed · hold the frame</strong>
                <i aria-hidden="true" />
              </div>
            )}

            {round.phase === 'battle'
              && round.playerEliminated
              && killcamReadyRound === round.roundId
              && !spectating
              && (
              <div className="arena-overlay">
                <section className="elimination-panel" aria-live="assertive">
                  <p className="eyebrow">Flag destroyed</p>
                  <h2>The line found you.</h2>
                  <p className="elimination-panel__copy">Jump into a fresh lobby now, or stay for the cluster finish.</p>
                  <div className="elimination-panel__actions">
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={starting}
                      aria-busy={starting}
                      onClick={() => {
                        reportDeadPlayerResponse('rematch')
                        void beginRun(true)
                      }}
                    >
                      <RotateCcw size={17} aria-hidden="true" /> Instant rematch
                    </button>
                    <button className="button button--secondary" type="button" onClick={() => {
                      reportDeadPlayerResponse('spectate')
                      setSpectating(true)
                      track('spectate_started', { progress: round.phaseProgress }, round.roundId)
                    }}>
                      <Eye size={17} aria-hidden="true" /> Watch bots
                    </button>
                  </div>
                </section>
              </div>
            )}

            {round.phase === 'result' && round.summary && (
              <div className="arena-overlay">
                <section
                  className={`result-panel result-panel--${round.summary.outcome}${masteryLevel >= 4 ? ' result-panel--stormbound' : ''}`}
                  aria-live="assertive"
                >
                  <p className="eyebrow">Rank #{round.summary.rank} of {totalContenders} · {round.deck.name}</p>
                  <h1>{round.summary.headline}</h1>
                  <div className="result-score">
                    <strong>{round.summary.score}</strong><span>points</span>
                  </div>
                  <div className="result-grid">
                    <div><strong>{round.summary.multiplier.toFixed(2)}×</strong><span>Risk</span></div>
                    <div><strong>{round.summary.survived} · {round.summary.escaped}</strong><span>Held · escaped</span></div>
                    <div><strong>{round.summary.closestApproach.toFixed(2)}</strong><span>Closest</span></div>
                  </div>
                  {resultStories && <ResultStoryStrip stories={resultStories} />}
                  {round.summary.outcome === 'escaped' && round.summary.escape && (
                    <p className="escape-result-story">
                      <strong>
                        Banked {round.summary.escape.bankedScore} at {(round.summary.escape.survivalProbability * 100).toFixed(0)}% live value.
                      </strong>
                      <span>
                        {round.summary.escape.holdOutcome === 'would-hit'
                          ? `Holding would have exploded at ${Math.round((round.summary.escape.holdHitAt ?? 1) * 60)}s.`
                          : `Holding would have paid ${round.summary.escape.terminalScore} — clean exit, real regret.`}
                      </span>
                    </p>
                  )}
                  <p className={`result-panel__copy proof-copy proof-copy--${proof?.status ?? 'pending'}`}>
                    {proofCopy}
                  </p>
                  <p className="result-panel__copy provenance-copy">
                    Fresh SolMath path seeded this round · {round.deck.name} rhythm from synthetic
                    calibration, not historical market data.
                  </p>
                  {breakReminderRound === round.roundId && (
                    <p className="break-reminder" role="status">
                      {profile.rounds} rounds in this profile. Stretch, blink, or run it back when ready.
                    </p>
                  )}
                  <div className="result-panel__actions">
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={starting}
                      aria-busy={starting}
                      onClick={() => void beginRun(true)}
                    >
                      <RotateCcw size={17} aria-hidden="true" /> {starting ? 'Seeding…' : 'Run it back'}
                    </button>
                    <button
                      ref={shareTrigger}
                      className="button button--secondary"
                      type="button"
                      disabled={shareState === 'preparing'}
                      aria-busy={shareState === 'preparing'}
                      aria-haspopup="dialog"
                      onClick={showShare}
                    >
                      {shareState === 'shared' || shareState === 'saved'
                        ? <Check size={17} aria-hidden="true" />
                        : <Share2 size={17} aria-hidden="true" />}
                      {shareState === 'preparing'
                        ? 'Forging moment…'
                        : shareState === 'shared'
                          ? 'Shared'
                          : shareState === 'saved'
                            ? 'Saved to device'
                            : shareState === 'error'
                              ? 'Share unavailable'
                              : 'Share result'}
                    </button>
                    {!rankedActive && practiceGame.proof?.replay && (
                      <button
                        ref={localReplayTrigger}
                        className="button button--secondary"
                        type="button"
                        aria-haspopup="dialog"
                        onClick={showLocalReplay}
                      >
                        <Eye size={17} aria-hidden="true" /> Watch replay
                      </button>
                    )}
                    {rankedActive
                      && proof?.status === 'verified'
                      && proof.rankable
                      && rankedGame.replayReceipt === 'recorded'
                      && (
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => navigateInApp(`/replay/${round.roundId}`)}
                      >
                        <ShieldCheck size={17} aria-hidden="true" /> View proof
                      </button>
                    )}
                  </div>
                </section>
              </div>
            )}
          </div>
        </section>

        <aside className="side-panel" aria-label="Lobby activity">
          <section className="panel">
            <header className="panel__header">
              <h2>Contenders</h2>
              <span>{alive}/{totalContenders} active</span>
            </header>
            <ol
              className="contender-list"
              tabIndex={0}
              aria-label={`Contenders, ${alive} of ${totalContenders} active`}
            >
              {standings.map((contender, index) => (
                <li
                  className={`contender-row${contender.isPlayer ? ' contender-row--player' : ''}${contender.outcome === 'hit' ? ' contender-row--hit' : ''}${contender.outcome === 'escaped' ? ' contender-row--escaped' : ''}`}
                  key={contender.id}
                >
                  <span className="contender-row__rank">{index + 1}</span>
                  <span className="contender-row__identity">
                    <strong>{contender.name}</strong>
                    <span>{contender.isPlayer ? 'Your flag' : `${contender.persona} · BOT`}</span>
                  </span>
                  <span className="contender-row__score">
                    {contender.outcome === 'hit'
                      ? <Skull size={14} aria-label="Eliminated" />
                      : contender.outcome === 'escaped'
                        ? <><LogOut size={13} aria-label="Escaped" /> {contender.escape?.bankedScore ?? 0}</>
                        : contender.potential}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="panel">
            <header className="panel__header">
              <h2>Strike feed</h2>
              <span>Live</span>
            </header>
            <div
              className="feed-list"
              tabIndex={0}
              aria-label="Live strike feed"
              aria-live="polite"
              aria-relevant="additions"
            >
              {round.feed.length === 0 ? (
                <div className="feed-empty">
                  <Radio size={24} aria-hidden="true" />
                  <strong>The room is holding.</strong>
                  <span>Hits, wipes and rival moves will land here.</span>
                </div>
              ) : round.feed.slice().reverse().map((event) => (
                <article className={`feed-event feed-event--${event.type}`} key={event.id}>
                  <strong>{event.title}</strong>
                  <span>{event.detail}</span>
                </article>
              ))}
            </div>
          </section>
        </aside>
      </main>

      <dialog
        ref={shareDialog}
        className="share-dialog"
        aria-labelledby="share-title"
        aria-describedby="share-description"
        onCancel={(event) => {
          if (shareState === 'preparing') event.preventDefault()
        }}
        onClose={() => shareTrigger.current?.focus()}
      >
        <header className="share-dialog__header">
          <div>
            <p className="eyebrow">
              {publicReplayUrl ? 'Public moment · verified replay attached' : 'Public moment · no round ID'}
            </p>
            <h2 id="share-title">Frame the strike</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close share options"
            disabled={shareState === 'preparing'}
            onClick={closeShare}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <div className="share-dialog__body">
          <p id="share-description" className="share-dialog__intro">
            {!shareAsClip
              ? !shareClipEligible
                ? 'This result has no authoritative event frame, so Strikefall will export an honest static card.'
                : reducedMotion
                  ? 'Reduced motion is on, so Strikefall will export a crisp static card.'
                  : 'Video capture is unavailable here, so Strikefall will export a crisp static card.'
              : shareCaptureLabel
                ? `Choose a frame for the retained 8–12 second window around the ${shareCaptureLabel}. Your device share sheet opens when available; otherwise the file downloads.`
                : 'Choose a frame for the rolling 8–12 second result window. Your device share sheet opens when available; otherwise the file downloads.'}
          </p>

          <fieldset className="share-format-picker">
            <legend>Format</legend>
            <label>
              <input
                type="radio"
                name="share-format"
                value="portrait-9x16"
                checked={shareFormat === 'portrait-9x16'}
                disabled={shareState === 'preparing'}
                onChange={() => setShareFormat('portrait-9x16')}
              />
              <span className="share-format-picker__shape share-format-picker__shape--portrait" aria-hidden="true" />
              <span><strong>Story</strong><small>9:16 · {shareAsClip ? '720×1280' : '1080×1920'}</small></span>
            </label>
            <label>
              <input
                type="radio"
                name="share-format"
                value="square-1x1"
                checked={shareFormat === 'square-1x1'}
                disabled={shareState === 'preparing'}
                onChange={() => setShareFormat('square-1x1')}
              />
              <span className="share-format-picker__shape share-format-picker__shape--square" aria-hidden="true" />
              <span><strong>Square</strong><small>1:1 · {shareAsClip ? '720×720' : '1080×1080'}</small></span>
            </label>
            <label>
              <input
                type="radio"
                name="share-format"
                value="landscape-16x9"
                checked={shareFormat === 'landscape-16x9'}
                disabled={shareState === 'preparing'}
                onChange={() => setShareFormat('landscape-16x9')}
              />
              <span className="share-format-picker__shape share-format-picker__shape--landscape" aria-hidden="true" />
              <span><strong>Wide</strong><small>16:9 · {shareAsClip ? '1280×720' : '1920×1080'}</small></span>
            </label>
          </fieldset>

          <div className={`share-preview share-preview--${shareFormat === 'portrait-9x16' ? 'portrait' : shareFormat === 'square-1x1' ? 'square' : 'landscape'}`} aria-hidden="true">
            <div className="share-preview__brand"><span className="brand-mark" /> STRIKEFALL</div>
            <div className="share-preview__arena"><span>ARENA MOMENT</span></div>
            <div className="share-preview__story">
              <strong>{shareArtifact.card.kicker}</strong>
              <span>{shareArtifact.card.headline}</span>
              <small>{activeBotCount} bots · {round.summary?.outcome}</small>
            </div>
          </div>

          <dl className="share-public-facts" aria-label="Public facts included in the export">
            <div><dt>Deck</dt><dd>{round.deck.name}</dd></div>
            <div><dt>Multiplier</dt><dd>{round.summary?.multiplier.toFixed(2)}×</dd></div>
            <div><dt>Bot field</dt><dd>{activeBotCount} bots</dd></div>
            <div><dt>Result</dt><dd>{round.summary?.outcome}</dd></div>
          </dl>

          <div className="share-dialog__actions">
            <button
              className="button button--primary"
              type="button"
              disabled={shareState === 'preparing'}
              aria-busy={shareState === 'preparing'}
              onClick={() => void shareResult()}
            >
              {shareState === 'shared' || shareState === 'saved'
                ? <Check size={17} aria-hidden="true" />
                : <Share2 size={17} aria-hidden="true" />}
              {shareState === 'preparing'
                ? 'Compositing moment…'
                : shareState === 'shared'
                  ? 'Shared'
                  : shareState === 'saved'
                    ? 'Saved to device'
                    : shareState === 'error'
                      ? 'Try again'
                      : `Share ${shareFormat === 'portrait-9x16' ? 'Story' : shareFormat === 'square-1x1' ? 'Square' : 'Wide'} ${shareAsClip ? 'clip' : 'card'}`}
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={shareState === 'preparing'}
              onClick={closeShare}
            >
              Back to result
            </button>
          </div>
          <p className={`share-dialog__status share-dialog__status--${shareState}`} role="status" aria-live="polite">
            {shareState === 'preparing'
              ? 'Compositing the arena with public result facts. This can take a moment.'
              : shareState === 'shared'
                ? 'Moment handed to your device share sheet.'
                : shareState === 'saved'
                  ? 'Moment saved locally. No private proof data was included.'
                  : shareState === 'error'
                    ? 'This browser could not finish the export. Try again or switch format.'
                    : 'Includes Strikefall, deck, multiplier, bot field, result, and moment only.'}
          </p>
        </div>
      </dialog>

      <dialog
        ref={localReplayDialog}
        className="local-replay-dialog"
        aria-label="Local round replay"
        onClose={() => {
          setLocalReplayOpen(false)
          localReplayTrigger.current?.focus()
        }}
      >
        {localReplayOpen && practiceGame.proof?.replay && (
          <Suspense fallback={<p className="deferred-panel" role="status">Loading verified replay…</p>}>
            <LocalReplayViewer
              replay={practiceGame.proof.replay}
              onClose={closeLocalReplay}
            />
          </Suspense>
        )}
      </dialog>

      <dialog
        ref={metricsDialog}
        className="metrics-dialog"
        aria-label="Closed alpha metrics"
        onClose={() => {
          setMetricsOpen(false)
          metricsTrigger.current?.focus()
        }}
      >
        {metricsOpen && (
          <div className="metrics-dialog__body">
            <button
              className="metrics-dialog__close"
              type="button"
              aria-label="Close alpha metrics"
              onClick={closeMetrics}
            >
              <X size={19} aria-hidden="true" />
            </button>
            <Suspense fallback={<p className="deferred-panel" role="status">Loading alpha signals…</p>}>
              <AlphaMetricsDashboard
                heading="Strikefall alpha signals"
                sources={[{ events: readLocalTelemetry(), experiments, profile }]}
                onReturnToGame={closeMetrics}
              />
              <AuthoritativeMetricsPanel baseUrl={ROUND_API_URL} />
            </Suspense>
          </div>
        )}
      </dialog>

      <dialog
        ref={lobbyDialog}
        className="lobby-dialog"
        aria-labelledby="lobby-title"
        onClose={() => lobbyTrigger.current?.focus()}
      >
        <header className="help-dialog__header">
          <h2 id="lobby-title">Live lobby</h2>
          <button className="icon-button" type="button" aria-label="Close lobby" onClick={closeLobby}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <div className="lobby-dialog__body">
          <section className="panel">
            <header className="panel__header">
              <h2>Contenders</h2>
              <span>{alive}/{totalContenders} active</span>
            </header>
            <ol
              className="contender-list"
              tabIndex={0}
              aria-label={`Contenders, ${alive} of ${totalContenders} active`}
            >
              {standings.map((contender, index) => (
                <li
                  className={`contender-row${contender.isPlayer ? ' contender-row--player' : ''}${contender.outcome === 'hit' ? ' contender-row--hit' : ''}${contender.outcome === 'escaped' ? ' contender-row--escaped' : ''}`}
                  key={`mobile-${contender.id}`}
                >
                  <span className="contender-row__rank">{index + 1}</span>
                  <span className="contender-row__identity">
                    <strong>{contender.name}</strong>
                    <span>{contender.isPlayer ? 'Your flag' : `${contender.persona} · BOT`}</span>
                  </span>
                  <span className="contender-row__score">
                    {contender.outcome === 'hit'
                      ? <Skull size={14} aria-label="Eliminated" />
                      : contender.outcome === 'escaped'
                        ? <><LogOut size={13} aria-label="Escaped" /> {contender.escape?.bankedScore ?? 0}</>
                        : contender.potential}
                  </span>
                </li>
              ))}
            </ol>
          </section>
          <section className="panel">
            <header className="panel__header">
              <h2>Strike feed</h2>
              <span>Live</span>
            </header>
            <div
              className="feed-list"
              tabIndex={0}
              aria-label="Live strike feed"
              aria-live="polite"
              aria-relevant="additions"
            >
              {round.feed.length === 0 ? (
                <div className="feed-empty">
                  <Radio size={24} aria-hidden="true" />
                  <strong>The room is holding.</strong>
                  <span>Hits, wipes and rival moves will land here.</span>
                </div>
              ) : round.feed.slice().reverse().map((event) => (
                <article className={`feed-event feed-event--${event.type}`} key={`mobile-${event.id}`}>
                  <strong>{event.title}</strong>
                  <span>{event.detail}</span>
                </article>
              ))}
            </div>
          </section>
          <LeaderboardPanel
            api={alpha.status === 'ready' ? alpha.api : null}
            deckId={round.deck.id}
            deckName={round.deck.name}
          />
        </div>
      </dialog>

      <dialog
        ref={helpDialog}
        className="help-dialog"
        aria-labelledby="help-title"
        aria-describedby="help-summary"
        onClose={handleHelpClosed}
      >
        <header className="help-dialog__header">
          <h2 id="help-title">How to survive</h2>
          <button className="icon-button" type="button" aria-label="Close rules" onClick={closeHelp}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <div className="help-dialog__body">
          <p id="help-summary" className="rule-summary">
            Planting a flag buys a knock-out option at your strike. One touch destroys it. The most points at the end wins the round.
          </p>
          <ol className="rule-list">
            <li><span className="rule-list__number">01</span><span><strong>Watch the history.</strong><span>The candles that print first already happened — they are the tape before your round. Read the mood; the deck tells you when pressure is concentrated.</span></span></li>
            <li><span className="rule-list__number">02</span><span><strong>Buy your strike.</strong><span>Above the line is a call, below is a put. Drag in the arena or use the slider. Closer strikes pay more because they are easier to hit.</span></span></li>
            <li><span className="rule-list__number">03</span><span><strong>Find clean air.</strong><span>Strikes packed into the same risk band dilute one another. Move away from the crowd before lock.</span></span></li>
            <li><span className="rule-list__number">04</span><span><strong>Hold or sell (Escape).</strong><span>Your option is priced live: payout × no-touch odds. One touch knocks it out. Once Escape opens, you can sell the position back exactly once and bank the premium.</span></span></li>
            <li><span className="rule-list__number">05</span><span><strong>Points win, not survival.</strong><span>Final rank sorts by score alone: a sold option counts in full against every held flag, and a knocked-out flag scores zero.</span></span></li>
          </ol>
        </div>
      </dialog>

      <dialog
        ref={settingsDialog}
        className="help-dialog settings-dialog"
        aria-labelledby="settings-title"
        onClose={() => settingsTrigger.current?.focus()}
      >
        <header className="help-dialog__header">
          <div>
            <p className="eyebrow">Local alpha profile</p>
            <h2 id="settings-title">Player & privacy</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close settings" onClick={closeSettings}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <div className="help-dialog__body settings-dialog__body">
          <section className="profile-summary" aria-label="Local progression">
            <div><strong>{profile.rounds}</strong><span>Rounds</span></div>
            <div><strong>{profile.survived}</strong><span>Held</span></div>
            <div><strong>{profile.escaped}</strong><span>Escaped</span></div>
            <div><strong>{profile.bestScore}</strong><span>Best</span></div>
          </section>

          <DeckMasteryPanel mastery={deckMastery} />

          <section className="settings-section">
            <h3>Callsign</h3>
            <p>
              {alpha.status === 'ready'
                ? 'Anonymous. Your callsign appears on verified short-window leaderboards; no email or wallet is attached.'
                : 'Anonymous and stored only in this browser while you play practice rounds.'}
            </p>
            <div className="settings-inline">
              <label className="field-label" htmlFor="player-callsign">Callsign</label>
              <input
                id="player-callsign"
                type="text"
                autoComplete="nickname"
                spellCheck={false}
                value={callsignDraft}
                maxLength={20}
                aria-invalid={callsignError ? true : undefined}
                aria-describedby={callsignError
                  ? 'player-callsign-error'
                  : callsignSaved
                    ? 'player-callsign-status'
                    : undefined}
                onChange={(event) => {
                  setCallsignDraft(event.currentTarget.value)
                  setCallsignError('')
                  setCallsignSaved(false)
                }}
              />
              <button
                className="button button--secondary button--compact"
                type="button"
                disabled={callsignBusy}
                aria-busy={callsignBusy}
                onClick={() => void saveCallsign()}
              >
                {callsignBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
            {callsignError && (
              <p id="player-callsign-error" className="settings-message" role="alert">
                {callsignError}
              </p>
            )}
            {callsignSaved && (
              <p id="player-callsign-status" className="settings-message settings-message--success" role="status">
                Callsign saved.
              </p>
            )}
          </section>

          {ROUND_API_URL && (
            <section className="settings-section alpha-session-summary">
              <div>
                <h3>Ranked session</h3>
                <p>
                  {alpha.status === 'ready' && alpha.session
                    ? `Ready as ${alpha.session.handle}. This device rotates its opaque token before ${new Date(alpha.session.expiresAtMs).toLocaleDateString()}.`
                    : alpha.status === 'disabled'
                      ? 'Ranked networking stays asleep until you deliberately select Ranked alpha.'
                      : alpha.message ?? rankedStatusCopy}
                </p>
              </div>
              {alpha.status === 'ready' ? (
                <button className="button button--secondary button--compact" type="button" onClick={() => {
                  rankedGame.close()
                  alpha.clear()
                  setPlayMode('practice')
                }}>
                  Forget session
                </button>
              ) : alpha.status === 'disabled' ? (
                <button
                  className="button button--secondary button--compact"
                  type="button"
                  disabled={!rankedAvailable}
                  title={!practiceAvailability.online ? 'Ranked needs a connection' : undefined}
                  onClick={() => {
                  closeSettings()
                  selectPlayMode('ranked')
                }}>
                  Open ranked
                </button>
              ) : (
                <button className="button button--secondary button--compact" type="button" onClick={() => void alpha.retry()}>
                  Retry connection
                </button>
              )}
            </section>
          )}

          <section className="settings-section settings-grid">
            <label>
              <span>Motion</span>
              <select
                value={preferences.motion}
                onChange={(event) => updatePreferences({ motion: event.currentTarget.value as MotionPreference })}
              >
                <option value="system">Follow device</option>
                <option value="reduced">Reduce motion</option>
                <option value="full">Full effects</option>
              </select>
            </label>
            <label>
              <span>Telemetry</span>
              <select
                value={preferences.telemetry}
                onChange={(event) => changeTelemetryPreference(event.currentTarget.value as TelemetryPreference)}
              >
                <option value="off">Off</option>
                <option value="local">Local only</option>
                <option value="shared">Share alpha metrics</option>
              </select>
            </label>
            <label>
              <span>Line display</span>
              <select
                value={preferences.chartStyle}
                onChange={(event) => updatePreferences({ chartStyle: event.currentTarget.value as ChartStylePreference })}
              >
                <option value="candles">Candlesticks</option>
                <option value="line">Line</option>
              </select>
            </label>
            <label>
              <span>Break reminder</span>
              <select
                value={preferences.breakReminderRounds}
                onChange={(event) => updatePreferences({ breakReminderRounds: Number(event.currentTarget.value) })}
              >
                <option value="0">Off</option>
                <option value="3">Every 3 rounds</option>
                <option value="5">Every 5 rounds</option>
                <option value="10">Every 10 rounds</option>
              </select>
            </label>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={preferences.mutedFlash}
                onChange={(event) => updatePreferences({ mutedFlash: event.currentTarget.checked })}
              />
              <span>Lower flash intensity</span>
            </label>
          </section>

          <section className="settings-section privacy-copy">
            <h3>Nothing financial</h3>
            <p>No wallet, payment, prize pot, tradable claim, or live market position. Telemetry defaults to a bounded local queue and is uploaded only after choosing “Share alpha metrics.” Finished ranked replays expose synthetic proof data only after resolution, never another player’s future path or identity token.</p>
            <button
              className="button button--secondary button--compact"
              type="button"
              aria-pressed={resetArmed}
              onClick={resetLocalProfile}
            >
              {resetArmed ? 'Confirm reset' : 'Reset local data'}
            </button>
          </section>
        </div>
      </dialog>
    </div>
  )
}

export default function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const replayLoader = useMemo(
    () => createPublicRankedReplayLoader({ baseUrl: ROUND_API_URL ?? '/api' }),
    [],
  )

  useEffect(() => {
    const readLocation = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', readLocation)
    return () => window.removeEventListener('popstate', readLocation)
  }, [])

  const replayId = replayIdFromPath(pathname)
  if (replayId !== null) {
    const replayReducedMotion = resolveReducedMotion(loadPreferences().motion)
    return (
      <div className={`replay-page${replayReducedMotion ? ' app-shell--reduced-motion' : ''}`}>
        <header className="replay-page__topbar">
          <button className="brand-lockup replay-page__brand" type="button" onClick={() => navigateInApp('/')}>
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-copy">
              <span className="brand-name">Strikefall</span>
              <span className="brand-tagline">Verified replay</span>
            </span>
          </button>
          <span><ShieldCheck size={14} aria-hidden="true" /> Public · identity-free</span>
        </header>
        <main className="replay-page__main">
          <Suspense fallback={(
            <div className="deferred-panel" role="status">
              <h1 className="sr-only">Loading Strikefall replay</h1>
              <span>Loading public proof…</span>
            </div>
          )}>
            <RankedReplayViewer
              replayId={replayId}
              loader={replayLoader}
              shareBaseUrl={window.location.origin}
              onPlayFresh={() => navigateInApp('/?fresh=ranked-replay')}
              onBack={() => navigateInApp('/')}
            />
          </Suspense>
        </main>
      </div>
    )
  }
  const autoStartFresh = new URLSearchParams(window.location.search).get('fresh') === 'ranked-replay'
  return <StrikefallGameApp autoStartFresh={autoStartFresh} />
}
