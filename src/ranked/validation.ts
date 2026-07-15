import { RankedPayloadError, UnsupportedRankedProtocolError } from './errors'
import type {
  ApiErrorPayload,
  BotEscapeDecision,
  BotEscapeRecord,
  BotPlacementCandidate,
  BotPlacementDecision,
  ContenderOutcome,
  ContenderPlacement,
  ContenderResult,
  CreateRoundResponse,
  DecimalString,
  Deck,
  EscapeRecord,
  EscapeResponse,
  EventActor,
  ExperimentAssignments,
  FlagCluster,
  FlagUpdateResponse,
  HexString,
  LockedScore,
  PathPoint,
  RankedProtocolVersion,
  ReplayBundle,
  ReplayVerificationAck,
  ReplayVerifiedResponse,
  Reveal,
  RoundEventKind,
  RoundResult,
  RoundResultResponse,
  RoundStatus,
  Side,
  SignedRoundEvent,
  Touch,
  UnsignedDecimalString,
} from './types'

type JsonRecord = Record<string, unknown>

function fail(path: string, expectation: string): never {
  throw new RankedPayloadError(path, expectation)
}

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'an object')
  }
  return value as JsonRecord
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail(path, 'an array')
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') return fail(path, 'a string')
  return value
}

function nonEmptyString(value: unknown, path: string): string {
  const parsed = string(value, path)
  if (parsed.trim().length === 0) return fail(path, 'a non-empty string')
  return parsed
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return fail(path, 'a boolean')
  return value
}

function safeUint(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    return fail(path, `a safe unsigned integer no greater than ${maximum}`)
  }
  return value as number
}

function nullable<T>(
  value: unknown,
  path: string,
  parser: (candidate: unknown, candidatePath: string) => T,
): T | null {
  return value === null ? null : parser(value, path)
}

export function parseDecimalString(value: unknown, path = '$'): DecimalString {
  const parsed = string(value, path)
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(parsed) || parsed === '-0') {
    return fail(path, 'a canonical base-10 integer string')
  }
  return parsed as DecimalString
}

export function parseUnsignedDecimalString(
  value: unknown,
  path = '$',
): UnsignedDecimalString {
  const parsed = string(value, path)
  if (!/^(?:0|[1-9][0-9]*)$/.test(parsed)) {
    return fail(path, 'a canonical unsigned base-10 integer string')
  }
  return parsed as UnsignedDecimalString
}

function hex(value: unknown, path: string, bytes: number): HexString {
  const parsed = string(value, path)
  if (parsed.length !== bytes * 2 || !/^[0-9a-f]+$/.test(parsed)) {
    return fail(path, `${bytes} lowercase hexadecimal bytes`)
  }
  return parsed as HexString
}

function side(value: unknown, path: string): Side {
  if (value !== 'upper' && value !== 'lower') return fail(path, '"upper" or "lower"')
  return value
}

function status(value: unknown, path: string): RoundStatus {
  if (value !== 'placement' && value !== 'battle' && value !== 'resolved') {
    return fail(path, 'a ranked round status')
  }
  return value
}

function outcome(value: unknown, path: string): ContenderOutcome {
  if (value !== 'survived' && value !== 'eliminated' && value !== 'escaped') {
    return fail(path, 'a contender outcome')
  }
  return value
}

function actor(value: unknown, path: string): EventActor {
  if (value !== 'player' && value !== 'bot' && value !== 'server') {
    return fail(path, 'a ranked event actor')
  }
  return value
}

const EXPERIMENT_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  'deck-structure:v2': ['flat', 'compression-break'],
  'escape:v2': ['absent', 'midpoint'],
  'risk-display:v2': ['probability', 'danger-band'],
}

export function parseExperimentAssignments(
  value: unknown,
  path = '$.experimentAssignments',
): ExperimentAssignments {
  const source = record(value, path)
  const keys = Object.keys(source)
  if (
    keys.length < 2
    || keys.length > 3
    || !Object.hasOwn(source, 'escape:v2')
    || !Object.hasOwn(source, 'risk-display:v2')
  ) {
    return fail(path, 'the versioned shipped ranked treatment set')
  }
  const assignments: Record<string, string> = {}
  for (const key of keys.sort()) {
    const variants = EXPERIMENT_VARIANTS[key]
    const variant = nonEmptyString(source[key], `${path}.${key}`)
    if (!variants?.includes(variant)) {
      return fail(`${path}.${key}`, 'a shipped treatment variant')
    }
    assignments[key] = variant
  }
  return assignments
}

export function parseProtocolVersion(value: unknown, path = '$.protocolVersion'): RankedProtocolVersion {
  const parsed = string(value, path)
  if (parsed === 'strikefall/ranked-replay/v3') return parsed
  throw new UnsupportedRankedProtocolError(parsed)
}

export function parseDeck(value: unknown, path = '$'): Deck {
  const source = record(value, path)
  const weights = array(source.varianceWeights, `${path}.varianceWeights`)
  if (weights.length !== 4) return fail(`${path}.varianceWeights`, 'exactly four weights')
  const version = safeUint(source.version, `${path}.version`, 65_535)
  const battleSteps = safeUint(source.battleSteps, `${path}.battleSteps`, 65_535)
  let parsedRunway: Deck['openingRunway']
  if (source.openingRunway !== undefined) {
    const openingRunway = record(source.openingRunway, `${path}.openingRunway`)
    const runwaySteps = safeUint(openingRunway.steps, `${path}.openingRunway.steps`, 65_535)
    const varianceShareBps = safeUint(
      openingRunway.varianceShareBps,
      `${path}.openingRunway.varianceShareBps`,
      9_999,
    )
    if (runwaySteps === 0 || runwaySteps >= Math.floor(battleSteps / 4)) {
      return fail(`${path}.openingRunway.steps`, 'inside the first battle quarter')
    }
    if (
      varianceShareBps === 0
      || varianceShareBps * Math.floor(battleSteps / 4) >= 10_000 * runwaySteps
    ) {
      return fail(`${path}.openingRunway.varianceShareBps`, 'a lower-than-linear opening share')
    }
    parsedRunway = { steps: runwaySteps, varianceShareBps }
  }
  if (version >= 3 && parsedRunway === undefined) {
    return fail(`${path}.openingRunway`, 'a v3 opening runway')
  }
  if (version < 3 && parsedRunway !== undefined) {
    return fail(`${path}.openingRunway`, 'absent on linear v2 decks')
  }
  return {
    id: nonEmptyString(source.id, `${path}.id`),
    version,
    displayName: nonEmptyString(source.displayName, `${path}.displayName`),
    approachSteps: safeUint(source.approachSteps, `${path}.approachSteps`, 65_535),
    battleSteps,
    stepMs: safeUint(source.stepMs, `${path}.stepMs`, 65_535),
    monitoringConvention: nonEmptyString(source.monitoringConvention, `${path}.monitoringConvention`),
    varianceWeights: [
      safeUint(weights[0], `${path}.varianceWeights[0]`, 65_535),
      safeUint(weights[1], `${path}.varianceWeights[1]`, 65_535),
      safeUint(weights[2], `${path}.varianceWeights[2]`, 65_535),
      safeUint(weights[3], `${path}.varianceWeights[3]`, 65_535),
    ],
    openingRunway: parsedRunway,
    totalIntegratedVariance: parseUnsignedDecimalString(
      source.totalIntegratedVariance,
      `${path}.totalIntegratedVariance`,
    ),
    driftPerVariance: parseDecimalString(source.driftPerVariance, `${path}.driftPerVariance`),
    minInitialSurvival: parseUnsignedDecimalString(
      source.minInitialSurvival,
      `${path}.minInitialSurvival`,
    ),
    maxInitialSurvival: parseUnsignedDecimalString(
      source.maxInitialSurvival,
      `${path}.maxInitialSurvival`,
    ),
    riskMultiplierCap: parseUnsignedDecimalString(
      source.riskMultiplierCap,
      `${path}.riskMultiplierCap`,
    ),
    artTheme: nonEmptyString(source.artTheme, `${path}.artTheme`),
    audioProfile: nonEmptyString(source.audioProfile, `${path}.audioProfile`),
    calibrationDigest: hex(source.calibrationDigest, `${path}.calibrationDigest`, 32),
  }
}

function pathPoint(value: unknown, path: string): PathPoint {
  const source = record(value, path)
  const point = {
    step: safeUint(source.step, `${path}.step`, 65_535),
    varianceElapsed: parseUnsignedDecimalString(source.varianceElapsed, `${path}.varianceElapsed`),
    logReturn: parseDecimalString(source.logReturn, `${path}.logReturn`),
    price: parseUnsignedDecimalString(source.price, `${path}.price`),
    intervalHigh: parseUnsignedDecimalString(source.intervalHigh, `${path}.intervalHigh`),
    intervalLow: parseUnsignedDecimalString(source.intervalLow, `${path}.intervalLow`),
  }
  if (BigInt(point.intervalLow) > BigInt(point.price)) {
    return fail(`${path}.intervalLow`, 'no greater than price')
  }
  if (BigInt(point.intervalHigh) < BigInt(point.price)) {
    return fail(`${path}.intervalHigh`, 'no less than price')
  }
  return point
}

function placement(value: unknown, path: string): ContenderPlacement {
  const source = record(value, path)
  return {
    contenderId: safeUint(source.contenderId, `${path}.contenderId`, 65_535),
    name: nonEmptyString(source.name, `${path}.name`),
    isBot: boolean(source.isBot, `${path}.isBot`),
    persona: nullable(source.persona, `${path}.persona`, string),
    side: side(source.side, `${path}.side`),
    barrier: parseUnsignedDecimalString(source.barrier, `${path}.barrier`),
  }
}

function lockedScore(value: unknown, path: string): LockedScore {
  const source = record(value, path)
  return {
    contenderId: safeUint(source.contenderId, `${path}.contenderId`, 65_535),
    side: side(source.side, `${path}.side`),
    barrier: parseUnsignedDecimalString(source.barrier, `${path}.barrier`),
    normalizedDistance: parseUnsignedDecimalString(
      source.normalizedDistance,
      `${path}.normalizedDistance`,
    ),
    initialSurvival: parseUnsignedDecimalString(source.initialSurvival, `${path}.initialSurvival`),
    riskMultiplier: parseUnsignedDecimalString(source.riskMultiplier, `${path}.riskMultiplier`),
    crowdFactor: parseUnsignedDecimalString(source.crowdFactor, `${path}.crowdFactor`),
    terminalScore: parseUnsignedDecimalString(source.terminalScore, `${path}.terminalScore`),
  }
}

function touch(value: unknown, path: string): Touch {
  const source = record(value, path)
  return {
    contenderId: safeUint(source.contenderId, `${path}.contenderId`, 65_535),
    step: safeUint(source.step, `${path}.step`, 65_535),
    side: side(source.side, `${path}.side`),
    barrier: parseUnsignedDecimalString(source.barrier, `${path}.barrier`),
    lineValue: parseUnsignedDecimalString(source.lineValue, `${path}.lineValue`),
  }
}

function escapeRecord(value: unknown, path: string): EscapeRecord {
  const source = record(value, path)
  return {
    step: safeUint(source.step, `${path}.step`, 65_535),
    bankedScore: parseUnsignedDecimalString(source.bankedScore, `${path}.bankedScore`),
    lineValue: parseUnsignedDecimalString(source.lineValue, `${path}.lineValue`),
  }
}

function botPlacementCandidate(value: unknown, path: string): BotPlacementCandidate {
  const source = record(value, path)
  return {
    candidateNumber: safeUint(source.candidateNumber, `${path}.candidateNumber`, 63),
    side: side(source.side, `${path}.side`),
    targetSurvival: parseUnsignedDecimalString(source.targetSurvival, `${path}.targetSurvival`),
    barrier: parseUnsignedDecimalString(source.barrier, `${path}.barrier`),
    quotedSurvival: parseUnsignedDecimalString(source.quotedSurvival, `${path}.quotedSurvival`),
    projectedCrowdFactor: parseUnsignedDecimalString(
      source.projectedCrowdFactor,
      `${path}.projectedCrowdFactor`,
    ),
    terminalScore: parseUnsignedDecimalString(source.terminalScore, `${path}.terminalScore`),
    utility: parseDecimalString(source.utility, `${path}.utility`),
  }
}

function botPlacementDecision(value: unknown, path: string): BotPlacementDecision {
  const source = record(value, path)
  const decisionNumber = safeUint(source.decisionNumber, `${path}.decisionNumber`, 3)
  if (decisionNumber === 0) return fail(`${path}.decisionNumber`, 'an integer from 1 through 3')
  const reactionLatencyMs = safeUint(source.reactionLatencyMs, `${path}.reactionLatencyMs`, 1_500)
  if (reactionLatencyMs < 250) return fail(`${path}.reactionLatencyMs`, '250 through 1500 milliseconds')
  const decisionTimeMs = safeUint(source.decisionTimeMs, `${path}.decisionTimeMs`, 12_000)
  const observationTimeMs = safeUint(source.observationTimeMs, `${path}.observationTimeMs`, 12_000)
  if (observationTimeMs + reactionLatencyMs !== decisionTimeMs) {
    return fail(
      `${path}.observationTimeMs`,
      'decisionTimeMs minus the committed reactionLatencyMs',
    )
  }
  const candidates = array(source.candidates, `${path}.candidates`).map((candidate, index) => (
    botPlacementCandidate(candidate, `${path}.candidates[${index}]`)
  ))
  const candidateCount = safeUint(source.candidateCount, `${path}.candidateCount`, 64)
  if (candidateCount === 0 || candidateCount !== candidates.length) {
    return fail(`${path}.candidateCount`, 'the non-zero candidates array length')
  }
  candidates.forEach((candidate, index) => {
    if (candidate.candidateNumber !== index) {
      fail(`${path}.candidates[${index}].candidateNumber`, 'its canonical array index')
    }
  })
  const selectedCandidate = safeUint(
    source.selectedCandidate,
    `${path}.selectedCandidate`,
    candidateCount - 1,
  )
  const selectedUtility = parseDecimalString(source.selectedUtility, `${path}.selectedUtility`)
  const selected = candidates[selectedCandidate]
  if (selected?.utility !== selectedUtility) {
    return fail(`${path}.selectedUtility`, 'the selected candidate utility')
  }
  const parsedPlacement = placement(source.placement, `${path}.placement`)
  if (selected?.side !== parsedPlacement.side || selected.barrier !== parsedPlacement.barrier) {
    return fail(`${path}.placement`, 'the selected candidate side and barrier')
  }
  return {
    contenderId: safeUint(source.contenderId, `${path}.contenderId`, 65_535),
    persona: nonEmptyString(source.persona, `${path}.persona`),
    policyVersion: nonEmptyString(source.policyVersion, `${path}.policyVersion`),
    decisionNumber,
    decisionTimeMs,
    observationTimeMs,
    reactionLatencyMs,
    publicInputsDigest: hex(source.publicInputsDigest, `${path}.publicInputsDigest`, 32),
    entropyDigest: hex(source.entropyDigest, `${path}.entropyDigest`, 32),
    candidatesDigest: hex(source.candidatesDigest, `${path}.candidatesDigest`, 32),
    candidateCount,
    selectedCandidate,
    selectedUtility,
    reasonCode: nonEmptyString(source.reasonCode, `${path}.reasonCode`),
    candidates,
    placement: parsedPlacement,
  }
}

function botEscapeDecision(value: unknown, path: string): BotEscapeDecision {
  const source = record(value, path)
  return {
    contenderId: safeUint(source.contenderId, `${path}.contenderId`, 65_535),
    persona: nonEmptyString(source.persona, `${path}.persona`),
    policyVersion: nonEmptyString(source.policyVersion, `${path}.policyVersion`),
    decisionBucket: safeUint(source.decisionBucket, `${path}.decisionBucket`, 65_535),
    step: safeUint(source.step, `${path}.step`, 65_535),
    publicInputsDigest: hex(source.publicInputsDigest, `${path}.publicInputsDigest`, 32),
    survivalProbability: parseUnsignedDecimalString(
      source.survivalProbability,
      `${path}.survivalProbability`,
    ),
    threshold: parseUnsignedDecimalString(source.threshold, `${path}.threshold`),
    chanceRoll: parseUnsignedDecimalString(source.chanceRoll, `${path}.chanceRoll`),
    decisionChance: parseUnsignedDecimalString(source.decisionChance, `${path}.decisionChance`),
    accepted: boolean(source.accepted, `${path}.accepted`),
    reasonCode: nonEmptyString(source.reasonCode, `${path}.reasonCode`),
  }
}

function botEscapeRecord(value: unknown, path: string): BotEscapeRecord {
  const source = record(value, path)
  return {
    contenderId: safeUint(source.contenderId, `${path}.contenderId`, 65_535),
    decisionBucket: safeUint(source.decisionBucket, `${path}.decisionBucket`, 65_535),
    escape: escapeRecord(source.escape, `${path}.escape`),
  }
}

function flagCluster(value: unknown, path: string): FlagCluster {
  const source = record(value, path)
  return {
    step: safeUint(source.step, `${path}.step`, 65_535),
    contenderIds: array(source.contenderIds, `${path}.contenderIds`).map((candidate, index) => (
      safeUint(candidate, `${path}.contenderIds[${index}]`, 65_535)
    )),
  }
}

function contenderResult(value: unknown, path: string): ContenderResult {
  const source = record(value, path)
  return {
    contenderId: safeUint(source.contenderId, `${path}.contenderId`, 65_535),
    name: nonEmptyString(source.name, `${path}.name`),
    outcome: outcome(source.outcome, `${path}.outcome`),
    score: parseUnsignedDecimalString(source.score, `${path}.score`),
    rank: safeUint(source.rank, `${path}.rank`, 65_535),
    touchStep: nullable(source.touchStep, `${path}.touchStep`, (candidate, candidatePath) => (
      safeUint(candidate, candidatePath, 65_535)
    )),
    closestApproach: parseUnsignedDecimalString(source.closestApproach, `${path}.closestApproach`),
  }
}

function roundResult(value: unknown, path: string): RoundResult {
  const source = record(value, path)
  return {
    outcome: outcome(source.outcome, `${path}.outcome`),
    score: parseUnsignedDecimalString(source.score, `${path}.score`),
    rank: safeUint(source.rank, `${path}.rank`, 65_535),
    survivors: safeUint(source.survivors, `${path}.survivors`, 65_535),
    closestApproach: parseUnsignedDecimalString(source.closestApproach, `${path}.closestApproach`),
    contenders: array(source.contenders, `${path}.contenders`).map((candidate, index) => (
      contenderResult(candidate, `${path}.contenders[${index}]`)
    )),
    proofDigest: hex(source.proofDigest, `${path}.proofDigest`, 32),
  }
}

function reveal(value: unknown, path: string): Reveal {
  const source = record(value, path)
  return {
    pathSeed: parseUnsignedDecimalString(source.pathSeed, `${path}.pathSeed`),
    botSeedRoot: hex(source.botSeedRoot, `${path}.botSeedRoot`, 32),
    salt: hex(source.salt, `${path}.salt`, 32),
    deckDigest: hex(source.deckDigest, `${path}.deckDigest`, 32),
    pathDigest: hex(source.pathDigest, `${path}.pathDigest`, 32),
  }
}

function replayVerificationAck(value: unknown, path: string): ReplayVerificationAck {
  const source = record(value, path)
  return {
    proofDigest: hex(source.proofDigest, `${path}.proofDigest`, 32),
    verifierVersion: nonEmptyString(source.verifierVersion, `${path}.verifierVersion`),
    acknowledgedAtMs: safeUint(source.acknowledgedAtMs, `${path}.acknowledgedAtMs`),
    eventSequence: safeUint(source.eventSequence, `${path}.eventSequence`),
  }
}

function eventKind(value: unknown, path: string, expectedProtocol: RankedProtocolVersion): RoundEventKind {
  const source = record(value, path)
  const type = string(source.type, `${path}.type`)
  const data = record(source.data, `${path}.data`)
  switch (type) {
    case 'round_created': {
      const protocolVersion = parseProtocolVersion(data.protocolVersion, `${path}.data.protocolVersion`)
      if (protocolVersion !== expectedProtocol) {
        return fail(`${path}.data.protocolVersion`, `the anchored protocol ${expectedProtocol}`)
      }
      return {
        type,
        data: {
          protocolVersion,
          commitment: hex(data.commitment, `${path}.data.commitment`, 32),
          experimentAssignments: parseExperimentAssignments(
            data.experimentAssignments,
            `${path}.data.experimentAssignments`,
          ),
          playerPlacement: placement(data.playerPlacement, `${path}.data.playerPlacement`),
        },
      }
    }
    case 'approach_frame':
    case 'battle_frame':
      return { type, data: { point: pathPoint(data.point, `${path}.data.point`) } }
    case 'placement_opened':
      return {
        type,
        data: {
          placementDeadlineMs: safeUint(
            data.placementDeadlineMs,
            `${path}.data.placementDeadlineMs`,
          ),
          inputFreezeAtMs: safeUint(data.inputFreezeAtMs, `${path}.data.inputFreezeAtMs`),
          botPolicyVersion: nonEmptyString(
            data.botPolicyVersion,
            `${path}.data.botPolicyVersion`,
          ),
        },
      }
    case 'bot_placement_decision':
      return {
        type,
        data: { decision: botPlacementDecision(data.decision, `${path}.data.decision`) },
      }
    case 'flag_moved':
      return {
        type,
        data: {
          actor: actor(data.actor, `${path}.data.actor`),
          placement: placement(data.placement, `${path}.data.placement`),
          clientSequence: nullable(
            data.clientSequence,
            `${path}.data.clientSequence`,
            safeUint,
          ),
        },
      }
    case 'placement_locked':
      return {
        type,
        data: {
          lockedScoresDigest: hex(
            data.lockedScoresDigest,
            `${path}.data.lockedScoresDigest`,
            32,
          ),
          lockedScores: array(data.lockedScores, `${path}.data.lockedScores`).map(
            (candidate, index) => lockedScore(
              candidate,
              `${path}.data.lockedScores[${index}]`,
            ),
          ),
          battleStartsAtMs: safeUint(
            data.battleStartsAtMs,
            `${path}.data.battleStartsAtMs`,
          ),
        },
      }
    case 'flag_cluster':
      return { type, data: { cluster: flagCluster(data.cluster, `${path}.data.cluster`) } }
    case 'bot_escape_evaluated':
      return {
        type,
        data: { decision: botEscapeDecision(data.decision, `${path}.data.decision`) },
      }
    case 'escape_accepted':
      return {
        type,
        data: {
          contenderId: safeUint(data.contenderId, `${path}.data.contenderId`, 65_535),
          actor: actor(data.actor, `${path}.data.actor`),
          escape: escapeRecord(data.escape, `${path}.data.escape`),
        },
      }
    case 'flag_hit':
      return { type, data: { touch: touch(data.touch, `${path}.data.touch`) } }
    case 'round_ended':
      return {
        type,
        data: { proofDigest: hex(data.proofDigest, `${path}.data.proofDigest`, 32) },
      }
    case 'seed_revealed':
      return { type, data: { reveal: reveal(data.reveal, `${path}.data.reveal`) } }
    case 'replay_verified':
      return {
        type,
        data: {
          proofDigest: hex(data.proofDigest, `${path}.data.proofDigest`, 32),
          verifierVersion: nonEmptyString(data.verifierVersion, `${path}.data.verifierVersion`),
        },
      }
    default:
      return fail(`${path}.type`, 'a supported ranked event type')
  }
}

export function parseSignedRoundEvent(
  value: unknown,
  protocolVersion: RankedProtocolVersion,
  path = '$',
): SignedRoundEvent {
  const source = record(value, path)
  return {
    sequence: safeUint(source.sequence, `${path}.sequence`),
    serverTimeMs: safeUint(source.serverTimeMs, `${path}.serverTimeMs`),
    previousDigest: hex(source.previousDigest, `${path}.previousDigest`, 32),
    kind: eventKind(source.kind, `${path}.kind`, protocolVersion),
    digest: hex(source.digest, `${path}.digest`, 32),
    signature: hex(source.signature, `${path}.signature`, 64),
  }
}

export function parseCreateRoundResponse(value: unknown): CreateRoundResponse {
  const source = record(value, '$')
  const protocolVersion = parseProtocolVersion(source.protocolVersion)
  const playerPlacement = placement(source.playerPlacement, '$.playerPlacement')
  if (
    playerPlacement.contenderId !== 0
    || playerPlacement.isBot
    || playerPlacement.persona !== null
  ) {
    return fail('$.playerPlacement', 'the authoritative non-bot contender zero')
  }
  return {
    protocolVersion,
    roundId: nonEmptyString(source.roundId, '$.roundId'),
    deck: parseDeck(source.deck, '$.deck'),
    status: status(source.status, '$.status'),
    commitment: hex(source.commitment, '$.commitment', 32),
    serverVerifyingKey: hex(source.serverVerifyingKey, '$.serverVerifyingKey', 32),
    createdAtMs: safeUint(source.createdAtMs, '$.createdAtMs'),
    placementDeadlineMs: safeUint(source.placementDeadlineMs, '$.placementDeadlineMs'),
    inputFreezeAtMs: safeUint(source.inputFreezeAtMs, '$.inputFreezeAtMs'),
    experimentAssignments: parseExperimentAssignments(source.experimentAssignments),
    approach: array(source.approach, '$.approach').map((candidate, index) => (
      pathPoint(candidate, `$.approach[${index}]`)
    )),
    playerPlacement,
    bots: array(source.bots, '$.bots').map((candidate, index) => (
      placement(candidate, `$.bots[${index}]`)
    )),
    streamUrl: nonEmptyString(source.streamUrl, '$.streamUrl'),
  }
}

export function parseFlagUpdateResponse(value: unknown): FlagUpdateResponse {
  const source = record(value, '$')
  return {
    eventSequence: safeUint(source.eventSequence, '$.eventSequence'),
    placement: placement(source.placement, '$.placement'),
    inputFreezeAtMs: safeUint(source.inputFreezeAtMs, '$.inputFreezeAtMs'),
  }
}

export function parseEscapeResponse(value: unknown): EscapeResponse {
  const source = record(value, '$')
  return {
    eventSequence: safeUint(source.eventSequence, '$.eventSequence'),
    escape: escapeRecord(source.escape, '$.escape'),
  }
}

export function parseRoundResultResponse(value: unknown): RoundResultResponse {
  const source = record(value, '$')
  return {
    roundId: nonEmptyString(source.roundId, '$.roundId'),
    status: status(source.status, '$.status'),
    result: nullable(source.result, '$.result', roundResult),
    reveal: nullable(source.reveal, '$.reveal', reveal),
  }
}

function requiredArray<T>(
  source: JsonRecord,
  key: string,
  parser: (candidate: unknown, candidatePath: string) => T,
): readonly T[] {
  return array(source[key], `$.${key}`).map((candidate, index) => (
    parser(candidate, `$.${key}[${index}]`)
  ))
}

export function parseReplayBundle(value: unknown): ReplayBundle {
  const source = record(value, '$')
  const protocolVersion = parseProtocolVersion(source.protocolVersion)
  const path = record(source.path, '$.path')
  const replayVerification = nullable(
    source.replayVerification,
    '$.replayVerification',
    replayVerificationAck,
  )
  return {
    protocolVersion,
    roundId: nonEmptyString(source.roundId, '$.roundId'),
    deck: parseDeck(source.deck, '$.deck'),
    initialSpot: parseUnsignedDecimalString(source.initialSpot, '$.initialSpot'),
    commitment: hex(source.commitment, '$.commitment', 32),
    serverVerifyingKey: hex(source.serverVerifyingKey, '$.serverVerifyingKey', 32),
    experimentAssignments: parseExperimentAssignments(source.experimentAssignments),
    bots: array(source.bots, '$.bots').map((candidate, index) => (
      placement(candidate, `$.bots[${index}]`)
    )),
    botPlacementDecisions: requiredArray(
      source,
      'botPlacementDecisions',
      botPlacementDecision,
    ),
    placements: array(source.placements, '$.placements').map((candidate, index) => (
      placement(candidate, `$.placements[${index}]`)
    )),
    lockedScores: array(source.lockedScores, '$.lockedScores').map((candidate, index) => (
      lockedScore(candidate, `$.lockedScores[${index}]`)
    )),
    path: {
      approach: array(path.approach, '$.path.approach').map((candidate, index) => (
        pathPoint(candidate, `$.path.approach[${index}]`)
      )),
      battle: array(path.battle, '$.path.battle').map((candidate, index) => (
        pathPoint(candidate, `$.path.battle[${index}]`)
      )),
    },
    escape: nullable(source.escape, '$.escape', escapeRecord),
    botEscapeDecisions: requiredArray(
      source,
      'botEscapeDecisions',
      botEscapeDecision,
    ),
    botEscapes: requiredArray(source, 'botEscapes', botEscapeRecord),
    touches: array(source.touches, '$.touches').map((candidate, index) => (
      touch(candidate, `$.touches[${index}]`)
    )),
    result: roundResult(source.result, '$.result'),
    reveal: reveal(source.reveal, '$.reveal'),
    replayVerification,
    events: array(source.events, '$.events').map((candidate, index) => (
      parseSignedRoundEvent(candidate, protocolVersion, `$.events[${index}]`)
    )),
  }
}

export function parseApiErrorPayload(value: unknown): ApiErrorPayload {
  const source = record(value, '$')
  return {
    code: nonEmptyString(source.code, '$.code'),
    message: nonEmptyString(source.message, '$.message'),
    retryAfterMs: nullable(source.retryAfterMs, '$.retryAfterMs', safeUint),
  }
}

export function parseReplayVerifiedResponse(value: unknown): ReplayVerifiedResponse {
  const source = record(value, '$')
  return {
    eventSequence: safeUint(source.eventSequence, '$.eventSequence'),
    alreadyAcknowledged: boolean(source.alreadyAcknowledged, '$.alreadyAcknowledged'),
  }
}
