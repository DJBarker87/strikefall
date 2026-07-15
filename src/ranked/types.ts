declare const decimalStringBrand: unique symbol
declare const unsignedDecimalStringBrand: unique symbol
declare const hexStringBrand: unique symbol

/** A canonical base-10 integer used for signed fixed-point values on the wire. */
export type DecimalString = string & { readonly [decimalStringBrand]: true }

/** A canonical non-negative base-10 integer used for u64/u128 values on the wire. */
export type UnsignedDecimalString = DecimalString & {
  readonly [unsignedDecimalStringBrand]: true
}

export type HexString = string & { readonly [hexStringBrand]: true }

export type RankedProtocolVersion = 'strikefall/ranked-replay/v3'

export type Side = 'upper' | 'lower'
export type RoundStatus = 'placement' | 'battle' | 'resolved'
export type ContenderOutcome = 'survived' | 'eliminated' | 'escaped'
export type EventActor = 'player' | 'bot' | 'server'
export type ExperimentAssignments = Readonly<Record<string, string>>

export interface DeckRef {
  id: string
  version: number
}

export interface OpeningRunway {
  steps: number
  varianceShareBps: number
}

export interface Deck extends DeckRef {
  displayName: string
  approachSteps: number
  battleSteps: number
  stepMs: number
  monitoringConvention: string
  varianceWeights: readonly [number, number, number, number]
  /** Absent only on frozen linear v2 replay payloads. */
  openingRunway?: OpeningRunway
  totalIntegratedVariance: UnsignedDecimalString
  driftPerVariance: DecimalString
  minInitialSurvival: UnsignedDecimalString
  maxInitialSurvival: UnsignedDecimalString
  riskMultiplierCap: UnsignedDecimalString
  artTheme: string
  audioProfile: string
  calibrationDigest: HexString
}

export interface PathPoint {
  step: number
  varianceElapsed: UnsignedDecimalString
  logReturn: DecimalString
  price: UnsignedDecimalString
  intervalHigh: UnsignedDecimalString
  intervalLow: UnsignedDecimalString
}

export interface RoundPath {
  approach: readonly PathPoint[]
  battle: readonly PathPoint[]
}

export interface ContenderPlacement {
  contenderId: number
  name: string
  isBot: boolean
  persona: string | null
  side: Side
  barrier: UnsignedDecimalString
}

export interface LockedScore {
  contenderId: number
  side: Side
  barrier: UnsignedDecimalString
  normalizedDistance: UnsignedDecimalString
  initialSurvival: UnsignedDecimalString
  riskMultiplier: UnsignedDecimalString
  crowdFactor: UnsignedDecimalString
  terminalScore: UnsignedDecimalString
}

export interface Touch {
  contenderId: number
  step: number
  side: Side
  barrier: UnsignedDecimalString
  lineValue: UnsignedDecimalString
}

export interface EscapeRecord {
  step: number
  bankedScore: UnsignedDecimalString
  lineValue: UnsignedDecimalString
}

export interface BotPlacementDecision {
  contenderId: number
  persona: string
  policyVersion: string
  decisionNumber: number
  decisionTimeMs: number
  observationTimeMs: number
  reactionLatencyMs: number
  publicInputsDigest: HexString
  entropyDigest: HexString
  candidatesDigest: HexString
  candidateCount: number
  selectedCandidate: number
  selectedUtility: DecimalString
  reasonCode: string
  candidates: readonly BotPlacementCandidate[]
  placement: ContenderPlacement
}

export interface BotPlacementCandidate {
  candidateNumber: number
  side: Side
  targetSurvival: UnsignedDecimalString
  barrier: UnsignedDecimalString
  quotedSurvival: UnsignedDecimalString
  projectedCrowdFactor: UnsignedDecimalString
  terminalScore: UnsignedDecimalString
  utility: DecimalString
}

export interface BotEscapeDecision {
  contenderId: number
  persona: string
  policyVersion: string
  decisionBucket: number
  step: number
  publicInputsDigest: HexString
  survivalProbability: UnsignedDecimalString
  threshold: UnsignedDecimalString
  chanceRoll: UnsignedDecimalString
  decisionChance: UnsignedDecimalString
  accepted: boolean
  reasonCode: string
}

export interface BotEscapeRecord {
  contenderId: number
  decisionBucket: number
  escape: EscapeRecord
}

export interface FlagCluster {
  step: number
  contenderIds: readonly number[]
}

export interface ReplayVerificationAck {
  proofDigest: HexString
  verifierVersion: string
  acknowledgedAtMs: number
  eventSequence: number
}

export interface ContenderResult {
  contenderId: number
  name: string
  outcome: ContenderOutcome
  score: UnsignedDecimalString
  rank: number
  touchStep: number | null
  closestApproach: UnsignedDecimalString
}

export interface RoundResult {
  outcome: ContenderOutcome
  score: UnsignedDecimalString
  rank: number
  survivors: number
  closestApproach: UnsignedDecimalString
  contenders: readonly ContenderResult[]
  proofDigest: HexString
}

export interface Reveal {
  pathSeed: UnsignedDecimalString
  botSeedRoot: HexString
  salt: HexString
  deckDigest: HexString
  pathDigest: HexString
}

export type RoundEventKind =
  | {
    type: 'round_created'
    data: {
      protocolVersion: RankedProtocolVersion
      commitment: HexString
      experimentAssignments: ExperimentAssignments
      playerPlacement: ContenderPlacement
    }
  }
  | { type: 'approach_frame'; data: { point: PathPoint } }
  | {
    type: 'placement_opened'
    data: {
      placementDeadlineMs: number
      inputFreezeAtMs: number
      botPolicyVersion: string
    }
  }
  | { type: 'bot_placement_decision'; data: { decision: BotPlacementDecision } }
  | {
    type: 'flag_moved'
    data: {
      actor: EventActor
      placement: ContenderPlacement
      clientSequence: number | null
    }
  }
  | {
    type: 'placement_locked'
    data: {
      lockedScoresDigest: HexString
      lockedScores: readonly LockedScore[]
      battleStartsAtMs: number
    }
  }
  | { type: 'battle_frame'; data: { point: PathPoint } }
  | { type: 'flag_cluster'; data: { cluster: FlagCluster } }
  | { type: 'bot_escape_evaluated'; data: { decision: BotEscapeDecision } }
  | {
    type: 'escape_accepted'
    data: { contenderId: number; actor: EventActor; escape: EscapeRecord }
  }
  | { type: 'flag_hit'; data: { touch: Touch } }
  | { type: 'round_ended'; data: { proofDigest: HexString } }
  | { type: 'seed_revealed'; data: { reveal: Reveal } }
  | {
    type: 'replay_verified'
    data: { proofDigest: HexString; verifierVersion: string }
  }

export interface SignedRoundEvent {
  sequence: number
  serverTimeMs: number
  previousDigest: HexString
  kind: RoundEventKind
  digest: HexString
  signature: HexString
}

export interface CreateRoundRequest {
  deckId?: string
  deckVersion?: number
}

export interface CreateRoundResponse {
  protocolVersion: RankedProtocolVersion
  roundId: string
  deck: Deck
  status: RoundStatus
  commitment: HexString
  serverVerifyingKey: HexString
  createdAtMs: number
  placementDeadlineMs: number
  inputFreezeAtMs: number
  experimentAssignments: ExperimentAssignments
  approach: readonly PathPoint[]
  playerPlacement: ContenderPlacement
  bots: readonly ContenderPlacement[]
  streamUrl: string
}

export interface FlagUpdateRequest {
  side: Side
  barrier: UnsignedDecimalString
  clientSequence?: number
}

export interface FlagUpdateResponse {
  eventSequence: number
  placement: ContenderPlacement
  inputFreezeAtMs: number
}

export interface EscapeRequest {
  clientSequence?: number
}

export interface EscapeResponse {
  eventSequence: number
  escape: EscapeRecord
}

export interface RoundResultResponse {
  roundId: string
  status: RoundStatus
  result: RoundResult | null
  reveal: Reveal | null
}

export interface ReplayVerifiedRequest {
  proofDigest: HexString
  verifierVersion: string
}

export interface ReplayVerifiedResponse {
  eventSequence: number
  alreadyAcknowledged: boolean
}

export interface ReplayBundle {
  protocolVersion: RankedProtocolVersion
  roundId: string
  deck: Deck
  initialSpot: UnsignedDecimalString
  commitment: HexString
  serverVerifyingKey: HexString
  experimentAssignments: ExperimentAssignments
  bots: readonly ContenderPlacement[]
  botPlacementDecisions: readonly BotPlacementDecision[]
  placements: readonly ContenderPlacement[]
  lockedScores: readonly LockedScore[]
  path: RoundPath
  escape: EscapeRecord | null
  botEscapeDecisions: readonly BotEscapeDecision[]
  botEscapes: readonly BotEscapeRecord[]
  touches: readonly Touch[]
  result: RoundResult
  reveal: Reveal
  replayVerification: ReplayVerificationAck | null
  events: readonly SignedRoundEvent[]
}

export interface ApiErrorPayload {
  code: string
  message: string
  retryAfterMs: number | null
}

export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ReplayAnchor {
  roundId: string
  protocolVersion: RankedProtocolVersion
  commitment: HexString
  serverVerifyingKey: HexString
  experimentAssignments: ExperimentAssignments
}

export interface LocalPracticeResult {
  readonly score: number
  readonly outcome: ContenderOutcome
  readonly completedAtMs: number
}
