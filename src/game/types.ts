import type { ScoringEngineDescriptor } from '../engine'

export type GamePhase =
  | 'home'
  | 'deck'
  | 'approach'
  | 'placement'
  | 'lock'
  | 'battle'
  | 'result'

export type FlagSide = 'upper' | 'lower'

export type Persona =
  | 'Turtle'
  | 'Sniper'
  | 'Greedlord'
  | 'Contrarian'
  | 'Momentum'
  | 'Late Bidder'
  | 'Mimic'
  | 'Chaos'

export interface DeckDefinition {
  id: string
  version: number
  monitoringConvention: 'strikefall/brownian-bridge-extrema/v1'
  name: string
  kicker: string
  description: string
  tacticalHint: string
  variance: readonly [number, number, number, number]
  /**
   * Canonical microstep pacing committed by Rust. Optional only for legacy
   * display-only snapshots; every playable deck must pass `validateDeck`.
   */
  openingRunway?: {
    steps: number
    varianceShareBps: number
  }
  hue: number
  tempo: number
}

export interface Candle {
  open: number
  high: number
  low: number
  close: number
}

/** Retained continuous-monitoring extrema for one public battle interval. */
export interface BattleIntervalExtrema {
  high: number
  low: number
}

/** Exact SCALE=1e12 projection used by Practice outcome logic. */
export interface FixedBattleIntervalExtrema {
  high: string
  low: string
}

export interface BotMove {
  /** Milliseconds after the placement phase opens. */
  at: number
  completed: boolean
  targetSide?: FlagSide
  targetDistance?: number
  reason?: string
}

export type ContenderOutcome = 'active' | 'hit' | 'survived' | 'escaped'

export type EscapeHoldOutcome = 'pending' | 'would-hit' | 'would-survive'

/** Immutable terms captured when a contender leaves the arena through Escape. */
export interface EscapeRecord {
  /** Zero-based battle path frame at which the command resolved. */
  frame: number
  /** Battle progress in the inclusive range 0..1. */
  at: number
  /** Conditional no-touch probability over the public remaining variance. */
  survivalProbability: number
  /** Canonical SCALE=1e12 quote retained for exact replay/ranking logic. */
  survivalProbabilityFixed?: string
  /** Fixed terminal score that was for sale. */
  terminalScore: number
  /** Canonical SCALE=1e12 terminal value. */
  terminalScoreFixed?: string
  /** Fixed score banked by the one-time command. */
  bankedScore: number
  /** Canonical SCALE=1e12 banked value. */
  bankedScoreFixed?: string
  /** Hindsight-only comparison, settled after the hidden path is revealed. */
  holdOutcome: EscapeHoldOutcome
  /** Counterfactual hit progress when holding would have lost, otherwise null. */
  holdHitAt: number | null
}

export interface Contender {
  id: string
  name: string
  persona: Persona | 'Player'
  isPlayer: boolean
  side: FlagSide
  distance: number
  barrier: number
  /** Exact SCALE=1e12 barrier used by scoring, touches, and Escape quotes. */
  barrierFixed?: string
  risk: number
  crowd: number
  potential: number
  /**
   * Canonical SCALE=1e12 lock terms from Rust/SolMath. Optional only so older
   * stored replay payloads and hand-built display fixtures remain decodable.
   * Every newly scored Practice contender has this value.
   */
  fixedScore?: {
    survivalProbability: string
    riskMultiplier: string
    crowdFactor: string
    terminalScore: string
  }
  color: string
  outcome: ContenderOutcome
  hitAt: number | null
  /**
   * Canonical display-frame index used by exact Practice rank tie-breaking.
   * It is regenerated from the committed path and omitted from replay v4.
   */
  hitFrameExact?: string
  closestApproach: number
  /**
   * Internal battle step at which `closestApproach` was first reached. This is
   * retained live for event-aligned sharing, but deliberately omitted from the
   * replay-v4 wire payload so older proofs keep their canonical shape.
   */
  closestApproachStep?: number
  /**
   * Exact SCALE=1e12 distance paired with `closestApproachStep` when the
   * authoritative path exposes fixed extrema. Also omitted from replay v4.
   */
  closestApproachFixed?: string
  escape: EscapeRecord | null
  moves: BotMove[]
}

export type BotDifficulty = 'easy' | 'normal' | 'hard'

/** Supported offline lobby sizes. Ranked rounds always use the full 19-bot roster. */
export type PracticeBotCount = 9 | 19

export interface BotProfile {
  id: string
  name: string
  persona: Persona
  color: string
  riskRange: readonly [number, number]
  latencyRange: readonly [number, number]
  moveRange: readonly [number, number]
  riskAversion: number
  hysteresis: number
  escapePolicy: BotEscapePolicy
}

/** Public, committed parameters for persona-specific Escape decisions. */
export interface BotEscapePolicy {
  earliestProgress: number
  quoteThreshold: number
  decisionIntervalMs: number
  decisionChance: number
}

export interface BotDecisionTrace {
  botId: string
  persona: Persona
  decisionTime: number
  moveNumber: number
  candidateCount: number
  selectedSide: FlagSide
  selectedDistance: number
  selectedSurvival: number
  selectedUtility: number
  reason: string
}

export interface BotAdvanceResult {
  contenders: Contender[]
  movedIds: string[]
  traces: BotDecisionTrace[]
}

export type FeedEventType = 'hit' | 'cluster' | 'lock' | 'escape' | 'survivor' | 'system'

export interface FeedEvent {
  id: string
  /** Strict append-only ordering used by replay verification. */
  sequence: number
  type: FeedEventType
  title: string
  detail: string
  contenderIds: string[]
  at: number
}

export interface RoundSummary {
  outcome: 'survived' | 'escaped' | 'eliminated'
  score: number
  rank: number
  /** Untouched terminal survivors. Escaped contenders are deliberately excluded. */
  survived: number
  escaped: number
  closestApproach: number
  multiplier: number
  crowd: number
  headline: string
  escape: EscapeRecord | null
}

export interface RoundState {
  roundId: string
  /** Public master seed in local play; authoritative servers keep this hidden until reveal. */
  seed: string
  /** Isolated streams let a server hand bots no path-generating material. */
  pathSeed: string
  botSeed: string
  phase: GamePhase
  /** Monotonic wall-clock timestamp in milliseconds. */
  phaseStartedAt: number
  /** Duration and remaining time are in milliseconds. */
  phaseDuration: number
  phaseProgress: number
  timeRemaining: number
  deck: DeckDefinition
  /** Exact scorer identity committed before play; path generation is separate. */
  engine: ScoringEngineDescriptor
  approach: Candle[]
  battlePath: number[]
  /** Exact SCALE=1e12 path retained alongside the display projection. */
  battlePathFixed?: string[]
  /** Same length as `battlePath`; index zero is a degenerate start interval. */
  battleExtrema: BattleIntervalExtrema[]
  /** Exact extrema for Practice touch decisions; optional for legacy snapshots. */
  battleExtremaFixed?: FixedBattleIntervalExtrema[]
  battleIndex: number
  lineValue: number
  /** Exact current SCALE=1e12 line value for Practice quotes. */
  lineValueFixed?: string
  contenders: Contender[]
  feed: FeedEvent[]
  nextEventSequence: number
  summary: RoundSummary | null
  playerEliminated: boolean
  /** V1.1 rule switch. Legacy pacing simulations keep the pure survival loop. */
  escapeEnabled: boolean
}

export interface CreateRoundOptions {
  now?: number
  roundId?: string
  pathSeed?: string
  botSeed?: string
  playerSide?: FlagSide
  playerDistance?: number
  difficulty?: BotDifficulty
  /** Canonical committed roster used by local practice replay regeneration. */
  botProfiles?: readonly BotProfile[]
  approachCandles?: number
  battleSteps?: number
  escapeEnabled?: boolean
  engine?: ScoringEngineDescriptor
}

export interface HitResolution {
  contenders: Contender[]
  hits: Contender[]
}

export interface PlacementScore {
  id: string
  survival: number
  risk: number
  crowd: number
  potential: number
}

export interface RoundPacing {
  survivors: number
  escaped: number
  firstHitAt: number | null
  largestCluster: number
  clusterWipes: number
}
