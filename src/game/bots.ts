import type {
  BotAdvanceResult,
  BotDecisionTrace,
  BotDifficulty,
  BotEscapePolicy,
  BotProfile,
  Candle,
  Contender,
  DeckDefinition,
  FlagSide,
  Persona,
} from './types'
import { clamp, roundTo } from './math'
import { createRng, deriveSeed } from './rng'
import {
  ESCAPE_CLOSE_PROGRESS,
  ESCAPE_UNLOCK_PROGRESS,
  type EscapeQuote,
  quoteContenderEscape,
} from './escape'
import {
  barrierForPlacement,
  distanceForSurvivalProbability,
  estimateSurvivalProbability,
  placementScore,
  projectedCrowdFactor,
  scoreContenders,
} from './scoring'

const PLACEMENT_DURATION_MS = 6_000
const INPUT_FREEZE_MS = 750

const PERSONA_ESCAPE_POLICIES: Readonly<Record<Persona, BotEscapePolicy>> = {
  Turtle: {
    earliestProgress: 0.72,
    quoteThreshold: 0.26,
    decisionIntervalMs: 3_000,
    decisionChance: 0.75,
  },
  Sniper: {
    earliestProgress: ESCAPE_UNLOCK_PROGRESS,
    quoteThreshold: 0.76,
    decisionIntervalMs: 2_500,
    decisionChance: 1,
  },
  Greedlord: {
    earliestProgress: 0.76,
    quoteThreshold: 0.96,
    decisionIntervalMs: 4_000,
    decisionChance: 0.18,
  },
  Contrarian: {
    earliestProgress: 0.58,
    quoteThreshold: 0.76,
    decisionIntervalMs: 3_000,
    decisionChance: 0.85,
  },
  Momentum: {
    earliestProgress: 0.52,
    quoteThreshold: 0.82,
    decisionIntervalMs: 3_000,
    decisionChance: 0.9,
  },
  'Late Bidder': {
    earliestProgress: 0.82,
    quoteThreshold: 0.55,
    decisionIntervalMs: 2_200,
    decisionChance: 1,
  },
  Mimic: {
    earliestProgress: 0.55,
    quoteThreshold: 0.78,
    decisionIntervalMs: 2_500,
    decisionChance: 0.85,
  },
  Chaos: {
    earliestProgress: 0.55,
    quoteThreshold: 0.5,
    decisionIntervalMs: 3_500,
    decisionChance: 0.25,
  },
}

function profile(
  id: string,
  name: string,
  persona: Persona,
  color: string,
  riskRange: readonly [number, number],
  latencyRange: readonly [number, number],
  moveRange: readonly [number, number],
  riskAversion: number,
  hysteresis: number,
): BotProfile {
  return {
    id,
    name,
    persona,
    color,
    riskRange,
    latencyRange,
    moveRange,
    riskAversion,
    hysteresis,
    escapePolicy: { ...PERSONA_ESCAPE_POLICIES[persona] },
  }
}

/** Stable rivals: every quick run has the same recognisable, disclosed cast. */
export const BOT_PROFILES: readonly BotProfile[] = [
  profile('turtle-exe', 'Turtle.exe', 'Turtle', '#7CF3C8', [0.74, 0.88], [850, 1_500], [1, 2], 1, 0.08),
  profile('wickhunter', 'Wickhunter', 'Sniper', '#FFE57A', [0.35, 0.44], [250, 700], [2, 3], 0.32, 0.035),
  profile('pinpoint', 'Pinpoint', 'Sniper', '#FFD04A', [0.35, 0.43], [300, 750], [2, 3], 0.3, 0.04),
  profile('greedlord', 'Greedlord', 'Greedlord', '#FF6A4D', [0.12, 0.18], [350, 900], [2, 3], 0.03, 0.02),
  profile('maxx', 'MAXX', 'Greedlord', '#FF875F', [0.12, 0.19], [400, 950], [1, 3], 0.04, 0.025),
  profile('zero-fear', 'ZeroFear', 'Greedlord', '#FF4D79', [0.12, 0.17], [300, 800], [2, 3], 0.01, 0.015),
  profile('southpaw', 'Southpaw', 'Contrarian', '#7EC8FF', [0.14, 0.23], [450, 1_100], [2, 3], 0.38, 0.035),
  profile('fade-queen', 'FadeQueen', 'Contrarian', '#78A8FF', [0.14, 0.22], [500, 1_200], [2, 3], 0.4, 0.04),
  profile('vector', 'Vector', 'Momentum', '#C39BFF', [0.12, 0.23], [250, 650], [2, 3], 0.28, 0.03),
  profile('candle-chaser', 'CandleChaser', 'Momentum', '#B578FF', [0.12, 0.22], [300, 700], [2, 3], 0.24, 0.025),
  profile('up-only', 'UpOnly', 'Momentum', '#D36BFF', [0.13, 0.24], [300, 800], [1, 3], 0.3, 0.035),
  profile('last-call', 'LastCall', 'Late Bidder', '#F0A6FF', [0.14, 0.27], [700, 1_350], [1, 2], 0.34, 0.025),
  profile('zero-x-late', '0xLate', 'Late Bidder', '#E78EE7', [0.14, 0.25], [750, 1_450], [1, 2], 0.3, 0.02),
  profile('echo', 'Echo', 'Mimic', '#8CE8FF', [0.16, 0.58], [350, 850], [2, 3], 0.3, 0.02),
  profile('copycat', 'Copycat', 'Mimic', '#6CD8E8', [0.16, 0.58], [400, 900], [2, 3], 0.28, 0.02),
  profile('mirror', 'Mirror', 'Mimic', '#70C9CC', [0.16, 0.58], [500, 1_000], [1, 3], 0.32, 0.025),
  profile('glitch', 'Glitch', 'Chaos', '#FF83BD', [0.12, 0.27], [250, 1_350], [1, 3], 0.18, 0),
  profile('dice-roll', 'DiceRoll', 'Chaos', '#FF9AD5', [0.12, 0.27], [300, 1_400], [1, 3], 0.16, 0),
  profile('mayhem', 'Mayhem', 'Chaos', '#FF70A6', [0.12, 0.25], [250, 1_250], [2, 3], 0.12, 0),
] as const

/**
 * The compact practice cast keeps every disclosed persona represented. Its
 * stable IDs are part of the local replay contract; do not reorder casually.
 */
const COMPACT_PRACTICE_BOT_IDS = [
  'turtle-exe',
  'wickhunter',
  'pinpoint',
  'greedlord',
  'southpaw',
  'vector',
  'last-call',
  'echo',
  'glitch',
] as const

export function botProfilesForPractice(
  count: import('./types').PracticeBotCount,
): readonly BotProfile[] {
  if (count === 19) return BOT_PROFILES
  if (count !== 9) throw new RangeError('Practice lobbies support exactly 9 or 19 bots')
  const byId = new Map(BOT_PROFILES.map((profileData) => [profileData.id, profileData]))
  return COMPACT_PRACTICE_BOT_IDS.map((id) => {
    const profileData = byId.get(id)
    if (!profileData) throw new Error(`Compact practice roster is missing ${id}`)
    return profileData
  })
}

/** Only canonical 9/19 casts are accepted by local proof verification. */
export function isCanonicalPracticeBotRoster(
  profiles: readonly BotProfile[],
): boolean {
  if (profiles.length !== 9 && profiles.length !== 19) return false
  const expected = botProfilesForPractice(profiles.length)
  return profiles.every((profileData, index) => {
    const canonical = expected[index]
    return canonical !== undefined
      && profileData.id === canonical.id
      && profileData.name === canonical.name
      && profileData.persona === canonical.persona
      && profileData.color === canonical.color
      && profileData.riskRange[0] === canonical.riskRange[0]
      && profileData.riskRange[1] === canonical.riskRange[1]
      && profileData.latencyRange[0] === canonical.latencyRange[0]
      && profileData.latencyRange[1] === canonical.latencyRange[1]
      && profileData.moveRange[0] === canonical.moveRange[0]
      && profileData.moveRange[1] === canonical.moveRange[1]
      && profileData.riskAversion === canonical.riskAversion
      && profileData.hysteresis === canonical.hysteresis
      && profileData.escapePolicy.earliestProgress === canonical.escapePolicy.earliestProgress
      && profileData.escapePolicy.quoteThreshold === canonical.escapePolicy.quoteThreshold
      && profileData.escapePolicy.decisionIntervalMs === canonical.escapePolicy.decisionIntervalMs
      && profileData.escapePolicy.decisionChance === canonical.escapePolicy.decisionChance
  })
}

interface PolicyContext {
  seed: string
  deck: DeckDefinition
  approach: readonly Candle[]
  lineValue: number
  lineValueFixed?: string
  difficulty: BotDifficulty
  contenders: readonly Contender[]
  decisionTime: number
  moveNumber: number
}

interface Candidate {
  side: FlagSide
  distance: number
  survival: number
  utility: number
  reason: string
}

function approachMomentum(approach: readonly Candle[]): number {
  const first = approach[0]
  const last = approach[approach.length - 1]
  if (!first || !last || first.open === 0) return 0
  return (last.close - first.open) / first.open
}

function sidePopulation(contenders: readonly Contender[], side: FlagSide, excludeId: string): number {
  return contenders.filter((contender) => contender.id !== excludeId && contender.side === side).length
}

function targetSurvival(profileData: BotProfile, context: PolicyContext): number {
  const rng = createRng(
    deriveSeed(context.seed, `strikefall/bots/${profileData.id}/target/${context.moveNumber}`),
  )
  const [minimum, maximum] = profileData.riskRange
  const base = rng.range(minimum, maximum)
  const player = context.contenders.find((contender) => contender.isPlayer)

  if (profileData.persona === 'Mimic' && player) {
    const playerSurvival = estimateSurvivalProbability(
      player.distance,
      context.lineValue,
      player.side,
      context.lineValueFixed,
    )
    return clamp(playerSurvival + rng.range(-0.055, 0.045), minimum, maximum)
  }
  if (profileData.persona === 'Chaos') {
    return rng.range(minimum, maximum)
  }
  if (profileData.persona === 'Late Bidder' && context.decisionTime > 9_000) {
    return clamp(base - 0.055, minimum, maximum)
  }
  return base
}

function personaBias(
  profileData: BotProfile,
  candidate: Omit<Candidate, 'utility' | 'reason'>,
  context: PolicyContext,
): number {
  const player = context.contenders.find((contender) => contender.isPlayer)
  const momentum = approachMomentum(context.approach)
  const upperCount = sidePopulation(context.contenders, 'upper', profileData.id)
  const lowerCount = sidePopulation(context.contenders, 'lower', profileData.id)

  switch (profileData.persona) {
    case 'Turtle':
      return candidate.survival * 0.8
    case 'Sniper':
      return projectedCrowdFactor(
        candidate.side,
        candidate.distance,
        context.contenders,
        context.lineValue,
        profileData.id,
      ) * 0.28
    case 'Greedlord':
      return (1 - candidate.survival) * 0.72
    case 'Contrarian': {
      const lessUsedSide: FlagSide = upperCount <= lowerCount ? 'upper' : 'lower'
      return candidate.side === lessUsedSide ? 0.58 : -0.25
    }
    case 'Momentum': {
      const trailingSide: FlagSide = momentum >= 0 ? 'lower' : 'upper'
      return candidate.side === trailingSide ? 0.45 + Math.min(0.2, Math.abs(momentum) * 4) : -0.12
    }
    case 'Late Bidder':
      return context.decisionTime > 8_000 ? (1 - candidate.survival) * 0.25 : 0
    case 'Mimic': {
      if (!player) return 0
      const sameSide = candidate.side === player.side ? 0.68 : -0.35
      const scale = Math.max(context.lineValue * 0.1, 1)
      const distanceMatch = Math.max(0, 1 - Math.abs(candidate.distance - player.distance) / scale)
      return sameSide + distanceMatch * 0.82
    }
    case 'Chaos':
      return 0
  }
}

function difficultyNoise(difficulty: BotDifficulty): number {
  if (difficulty === 'easy') return 0.3
  if (difficulty === 'hard') return 0.065
  return 0.15
}

function probabilityGrid(difficulty: BotDifficulty): readonly number[] {
  if (difficulty === 'easy') return [0.13, 0.22, 0.34, 0.49, 0.68, 0.86]
  if (difficulty === 'hard') return [0.12, 0.17, 0.23, 0.3, 0.38, 0.47, 0.57, 0.68, 0.79, 0.89]
  return [0.12, 0.18, 0.25, 0.33, 0.42, 0.52, 0.64, 0.77, 0.88]
}

function difficultyWeights(difficulty: BotDifficulty) {
  if (difficulty === 'easy') return { crowd: 0.18, persona: 0.42, forecast: 0 }
  if (difficulty === 'hard') return { crowd: 1.18, persona: 1.08, forecast: 0.22 }
  return { crowd: 0.9, persona: 1, forecast: 0 }
}

/**
 * Hard bots forecast only public, visible persona tendencies and unfinished
 * placement activity. They never receive the hidden path or another bot's
 * future chosen coordinate.
 */
function forecastLateCrowd(
  profileData: BotProfile,
  candidate: Omit<Candidate, 'utility' | 'reason'>,
  context: PolicyContext,
): number {
  if (context.difficulty !== 'hard') return 0
  const player = context.contenders.find((contender) => contender.isPlayer)
  const upper = sidePopulation(context.contenders, 'upper', profileData.id)
  const lower = sidePopulation(context.contenders, 'lower', profileData.id)
  const momentumSide: FlagSide = approachMomentum(context.approach) >= 0 ? 'lower' : 'upper'
  let pressure = 0

  for (const contender of context.contenders) {
    if (contender.id === profileData.id || contender.isPlayer) continue
    const remainingMoves = contender.moves.filter((move) => !move.completed).length
    if (remainingMoves === 0) continue
    const predictedSide: FlagSide = contender.persona === 'Mimic' && player
      ? player.side
      : contender.persona === 'Contrarian'
        ? upper <= lower ? 'upper' : 'lower'
        : contender.persona === 'Momentum'
          ? momentumSide
          : contender.side
    if (predictedSide !== candidate.side) continue
    const currentSurvival = estimateSurvivalProbability(
      contender.distance,
      context.lineValue,
      contender.side,
      context.lineValueFixed,
    )
    const bandSimilarity = clamp(1 - Math.abs(currentSurvival - candidate.survival) / 0.2, 0, 1)
    pressure += bandSimilarity * Math.min(2, remainingMoves)
  }

  return pressure / Math.max(1, context.contenders.length - 1)
}

function evaluateCandidate(
  profileData: BotProfile,
  side: FlagSide,
  survivalTarget: number,
  personaTarget: number,
  context: PolicyContext,
  noise: number,
): Candidate {
  const distance = distanceForSurvivalProbability(
    survivalTarget,
    context.lineValue,
    side,
    context.lineValueFixed,
  )
  const survival = estimateSurvivalProbability(
    distance,
    context.lineValue,
    side,
    context.lineValueFixed,
  )
  const crowd = projectedCrowdFactor(
    side,
    distance,
    context.contenders,
    context.lineValue,
    profileData.id,
  )
  const targetFit = 1 - Math.abs(survival - personaTarget) / 0.38
  const outcomeVariance = survival * (1 - survival)
  const weights = difficultyWeights(context.difficulty)
  const utility =
    crowd * weights.crowd +
    targetFit * 1.35 -
    profileData.riskAversion * outcomeVariance * 0.65 +
    personaBias(profileData, { side, distance, survival }, context) * weights.persona -
    forecastLateCrowd(profileData, { side, distance, survival }, context) * weights.forecast +
    noise
  return {
    side,
    distance,
    survival,
    utility,
    reason: `${profileData.persona.toLowerCase()} read · ${Math.round(survival * 100)}% band`,
  }
}

function choosePlacement(profileData: BotProfile, context: PolicyContext): Candidate & { count: number } {
  const rng = createRng(
    deriveSeed(context.seed, `strikefall/bots/${profileData.id}/decision/${context.moveNumber}`),
  )
  const target = targetSurvival(profileData, context)
  const candidates: Candidate[] = []

  for (const side of ['upper', 'lower'] as const) {
    for (const probability of probabilityGrid(context.difficulty)) {
      candidates.push(
        evaluateCandidate(
          profileData,
          side,
          probability,
          target,
          context,
          rng.range(-difficultyNoise(context.difficulty), difficultyNoise(context.difficulty)),
        ),
      )
    }
  }

  candidates.sort((left, right) => right.utility - left.utility)
  const winner = candidates[0] as Candidate
  return { ...winner, count: candidates.length }
}

function initialSide(
  profileData: BotProfile,
  seed: string,
  approach: readonly Candle[],
  contenders: readonly Contender[],
): FlagSide {
  const rng = createRng(deriveSeed(seed, `strikefall/bots/${profileData.id}/initial-side`))
  const upper = sidePopulation(contenders, 'upper', profileData.id)
  const lower = sidePopulation(contenders, 'lower', profileData.id)
  if (profileData.persona === 'Contrarian') return upper <= lower ? 'upper' : 'lower'
  if (profileData.persona === 'Momentum') return approachMomentum(approach) >= 0 ? 'lower' : 'upper'
  return rng.chance(0.5) ? 'upper' : 'lower'
}

function scheduledMoves(
  profileData: BotProfile,
  seed: string,
  difficulty: BotDifficulty,
  deck: DeckDefinition,
) {
  const rng = createRng(deriveSeed(seed, `strikefall/bots/${profileData.id}/schedule`))
  const [minimum, maximum] = profileData.moveRange
  const count =
    difficulty === 'easy'
      ? minimum
      : difficulty === 'hard'
        ? maximum
        : rng.int(minimum, maximum)
  const late = profileData.persona === 'Late Bidder'
  const times = Array.from({ length: count }, (_, index) => {
    const section = late
      ? rng.range(0.64 + index * 0.1, Math.min(0.93, 0.79 + index * 0.1))
      : (index + rng.range(0.4, 0.78)) / count
    const latency = rng.range(profileData.latencyRange[0], profileData.latencyRange[1])
    return Math.round(
      clamp(
        section * PLACEMENT_DURATION_MS * (2 - deck.tempo) + latency * 0.22,
        500,
        PLACEMENT_DURATION_MS - INPUT_FREEZE_MS,
      ),
    )
  }).sort((left, right) => left - right)

  return times.map((at) => ({ at, completed: false }))
}

export function createBotContenders(
  seed: string,
  deck: DeckDefinition,
  approach: readonly Candle[],
  lineValue: number,
  difficulty: BotDifficulty = 'normal',
  visibleContenders: readonly Contender[] = [],
  profiles: readonly BotProfile[] = BOT_PROFILES,
  lineValueFixed?: string,
): Contender[] {
  const contenders: Contender[] = [...visibleContenders]
  const bots: Contender[] = []

  for (const profileData of profiles) {
    const rng = createRng(deriveSeed(seed, `strikefall/bots/${profileData.id}/initial-risk`))
    const target = rng.range(profileData.riskRange[0], profileData.riskRange[1])
    const side = initialSide(profileData, seed, approach, contenders)
    const distance = distanceForSurvivalProbability(
      target,
      lineValue,
      side,
      lineValueFixed,
    )
    const contender: Contender = {
      id: profileData.id,
      name: profileData.name,
      persona: profileData.persona,
      isPlayer: false,
      side,
      distance,
      barrier: barrierForPlacement(lineValue, side, distance),
      risk: 1,
      crowd: 1,
      potential: 100,
      color: profileData.color,
      outcome: 'active',
      hitAt: null,
      closestApproach: distance,
      closestApproachStep: 0,
      escape: null,
      moves: scheduledMoves(profileData, seed, difficulty, deck),
    }
    bots.push(contender)
    contenders.push(contender)
  }

  const scored = scoreContenders(contenders, lineValue, lineValueFixed)
  const botIds = new Set(bots.map((bot) => bot.id))
  return scored.filter((contender) => botIds.has(contender.id))
}

export interface AdvanceBotOptions {
  seed: string
  deck: DeckDefinition
  approach: readonly Candle[]
  lineValue: number
  lineValueFixed?: string
  difficulty?: BotDifficulty
}

export function advanceBotPlacements(
  contenders: readonly Contender[],
  elapsedMs: number,
  options: AdvanceBotOptions,
): BotAdvanceResult {
  let working = contenders.map((contender) => ({
    ...contender,
    moves: contender.moves.map((move) => ({ ...move })),
  }))
  const due = working
    .flatMap((contender) =>
      contender.isPlayer
        ? []
        : contender.moves.map((move, moveIndex) => ({ contenderId: contender.id, moveIndex, at: move.at })),
    )
    .filter(({ contenderId, moveIndex, at }) => {
      const contender = working.find((entry) => entry.id === contenderId)
      return at <= elapsedMs && contender?.moves[moveIndex]?.completed === false
    })
    .sort((left, right) => left.at - right.at || left.contenderId.localeCompare(right.contenderId))

  const movedIds: string[] = []
  const traces: BotDecisionTrace[] = []

  for (const event of due) {
    const contenderIndex = working.findIndex((contender) => contender.id === event.contenderId)
    const contender = working[contenderIndex]
    const profileData = BOT_PROFILES.find((entry) => entry.id === event.contenderId)
    if (!contender || !profileData) continue

    const context: PolicyContext = {
      seed: options.seed,
      deck: options.deck,
      approach: options.approach,
      lineValue: options.lineValue,
      lineValueFixed: options.lineValueFixed,
      difficulty: options.difficulty ?? 'normal',
      contenders: working,
      decisionTime: event.at,
      moveNumber: event.moveIndex + 1,
    }
    const selected = choosePlacement(profileData, context)
    const current = placementScore(
      contender,
      working,
      options.lineValue,
      options.lineValueFixed,
    )
    const currentSurvival = estimateSurvivalProbability(
      contender.distance,
      options.lineValue,
      contender.side,
      options.lineValueFixed,
    )
    const currentTarget = targetSurvival(profileData, context)
    const weights = difficultyWeights(context.difficulty)
    const currentUtility =
      current.crowd * weights.crowd +
      (1 - Math.abs(currentSurvival - currentTarget) / 0.38) * 1.35 -
      profileData.riskAversion * currentSurvival * (1 - currentSurvival) * 0.65 +
      personaBias(
        profileData,
        { side: contender.side, distance: contender.distance, survival: currentSurvival },
        context,
      ) * weights.persona -
      forecastLateCrowd(
        profileData,
        { side: contender.side, distance: contender.distance, survival: currentSurvival },
        context,
      ) * weights.forecast
    const shouldMove =
      profileData.persona === 'Chaos' ||
      profileData.persona === 'Mimic' ||
      selected.utility > currentUtility + profileData.hysteresis
    const move = contender.moves[event.moveIndex]
    if (!move) continue

    const updatedMove = {
      ...move,
      completed: true,
      targetSide: shouldMove ? selected.side : contender.side,
      targetDistance: shouldMove ? selected.distance : contender.distance,
      reason: shouldMove ? selected.reason : 'held position · no clear edge',
    }
    const moves = contender.moves.map((entry, index) =>
      index === event.moveIndex ? updatedMove : entry,
    )
    working[contenderIndex] = shouldMove
      ? {
          ...contender,
          side: selected.side,
          distance: selected.distance,
          barrier: barrierForPlacement(options.lineValue, selected.side, selected.distance),
          moves,
        }
      : { ...contender, moves }

    if (shouldMove) movedIds.push(contender.id)
    traces.push({
      botId: contender.id,
      persona: profileData.persona,
      decisionTime: event.at,
      moveNumber: event.moveIndex + 1,
      candidateCount: selected.count,
      selectedSide: shouldMove ? selected.side : contender.side,
      selectedDistance: shouldMove ? selected.distance : contender.distance,
      selectedSurvival: roundTo(
        shouldMove ? selected.survival : currentSurvival,
        4,
      ),
      selectedUtility: roundTo(shouldMove ? selected.utility : currentUtility, 4),
      reason: updatedMove.reason,
    })
    working = scoreContenders(working, options.lineValue, options.lineValueFixed)
  }

  return { contenders: working, movedIds, traces }
}

export function getBotProfile(id: string): BotProfile | undefined {
  return BOT_PROFILES.find((profileData) => profileData.id === id)
}

export interface BotEscapePublicState {
  /** Isolated bot stream; never pass the path seed to this policy. */
  seed: string
  deck: DeckDefinition
  lineValue: number
  lineValueFixed?: string
  battleFrame: number
  battleSteps: number
  contenders: readonly Contender[]
}

export interface BotEscapeDecision {
  botId: string
  quote: EscapeQuote
  reason: string
}

function publicScore(contender: Contender): number {
  if (contender.outcome === 'hit') return 0
  if (contender.outcome === 'escaped') return contender.escape?.bankedScore ?? 0
  return contender.potential
}

function publicRank(contenders: readonly Contender[], contenderId: string): number {
  return [...contenders]
    .sort(
      (left, right) =>
        publicScore(right) - publicScore(left) || left.id.localeCompare(right.id),
    )
    .findIndex((contender) => contender.id === contenderId) + 1
}

function escapeDecisionBucket(
  profileData: BotProfile,
  seed: string,
  battleFrame: number,
  battleSteps: number,
): number | null {
  if (battleFrame <= 0 || battleSteps < 2) return null
  const progress = battleFrame / (battleSteps - 1)
  if (progress < ESCAPE_UNLOCK_PROGRESS || progress >= ESCAPE_CLOSE_PROGRESS) return null
  const previousProgress = (battleFrame - 1) / (battleSteps - 1)
  const interval = profileData.escapePolicy.decisionIntervalMs
  const earliest = Math.max(
    ESCAPE_UNLOCK_PROGRESS,
    profileData.escapePolicy.earliestProgress,
  ) * 60_000
  const offsetRng = createRng(
    deriveSeed(seed, `strikefall/bots/${profileData.id}/escape/schedule`),
  )
  const firstDecision = earliest + offsetRng.range(0, interval * 0.7)
  const elapsed = progress * 60_000
  const previousElapsed = previousProgress * 60_000
  if (elapsed < firstDecision) return null
  const bucket = Math.floor((elapsed - firstDecision) / interval)
  const previousBucket = previousElapsed < firstDecision
    ? -1
    : Math.floor((previousElapsed - firstDecision) / interval)
  return bucket !== previousBucket ? bucket : null
}

function personaEscapeDecision(
  profileData: BotProfile,
  contender: Contender,
  quote: EscapeQuote,
  bucket: number,
  context: BotEscapePublicState,
): string | null {
  const rank = publicRank(context.contenders, contender.id)
  const rankAdjustment = rank <= 3 ? -0.025 : rank > 10 ? 0.035 : 0
  const threshold = clamp(
    profileData.escapePolicy.quoteThreshold + rankAdjustment,
    0.05,
    0.995,
  )
  const signedGap = contender.side === 'upper'
    ? contender.barrier - context.lineValue
    : context.lineValue - contender.barrier
  const proximity = clamp(signedGap / Math.max(contender.distance, Number.EPSILON), 0, 2)
  const playerEscaped = context.contenders.some(
    (entry) => entry.isPlayer && entry.outcome === 'escaped',
  )
  const chanceRng = createRng(
    deriveSeed(
      context.seed,
      `strikefall/bots/${profileData.id}/escape/decision/${bucket}`,
    ),
  )
  if (!chanceRng.chance(profileData.escapePolicy.decisionChance)) return null

  let shouldEscape = false
  switch (profileData.persona) {
    case 'Turtle':
      shouldEscape =
        quote.survivalProbability >= threshold &&
        (proximity <= 0.48 || quote.at >= 0.9)
      break
    case 'Sniper':
      shouldEscape = quote.survivalProbability >= threshold
      break
    case 'Greedlord':
      shouldEscape = quote.at >= 0.84 && quote.survivalProbability >= threshold
      break
    case 'Contrarian':
      shouldEscape = contender.crowd >= 1.03 && quote.survivalProbability >= threshold
      break
    case 'Momentum':
      shouldEscape = quote.survivalProbability >= threshold
      break
    case 'Late Bidder':
      shouldEscape = quote.at >= 0.84 && quote.survivalProbability >= threshold
      break
    case 'Mimic':
      shouldEscape = playerEscaped
        ? quote.survivalProbability >= Math.min(0.35, threshold)
        : quote.at >= 0.72 && quote.survivalProbability >= threshold
      break
    case 'Chaos':
      shouldEscape = quote.survivalProbability >= threshold
      break
  }
  if (!shouldEscape) return null
  return `${profileData.persona.toLowerCase()} escape · ${Math.round(quote.percentOfMaximum)}% value · rank ${rank}`
}

/**
 * Deterministic bot Escape policy. Its deliberately narrow input contains only
 * the public line, public deck/time, visible contenders, and isolated bot seed.
 */
export function decideBotEscapes(
  context: BotEscapePublicState,
): BotEscapeDecision[] {
  const decisions: BotEscapeDecision[] = []
  const activeBots = context.contenders
    .filter((contender) => !contender.isPlayer && contender.outcome === 'active')
    .sort((left, right) => left.id.localeCompare(right.id))

  for (const contender of activeBots) {
    const profileData = getBotProfile(contender.id)
    if (!profileData) continue
    const bucket = escapeDecisionBucket(
      profileData,
      context.seed,
      context.battleFrame,
      context.battleSteps,
    )
    if (bucket === null) continue
    const quote = quoteContenderEscape(
      contender,
      context.deck,
      context.lineValue,
      context.battleFrame,
      context.battleSteps,
      context.lineValueFixed,
    )
    const reason = personaEscapeDecision(
      profileData,
      contender,
      quote,
      bucket,
      context,
    )
    if (reason) decisions.push({ botId: contender.id, quote, reason })
  }
  return decisions
}
