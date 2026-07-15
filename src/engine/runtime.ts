import {
  getStrikefallWasmState,
  loadStrikefallWasm,
  type StrikefallDeck,
  type StrikefallPathPoint,
  type StrikefallRoundPath,
  type StrikefallWasmClient,
} from '../wasm'
import {
  canonicalUnsignedFixed,
  displayNumberToFixed,
  fixedToDisplayNumber,
  fixedToRoundedPoints,
  probabilityNumberToFixed,
} from './fixed'
import type {
  EngineDeckInput,
  EngineLockedScore,
  EnginePlacementInput,
  EngineQuoteInput,
  EngineQuoteResult,
  EngineRuntime,
  ScoringEngineDescriptor,
  ScoringEngineStatus,
} from './types'

export const DEFAULT_BROWSER_PRICING_VARIANCE = 0.0064
export const WASM_ENGINE_VERSION = 'solmath/0.2.0+strikefall-wasm/0.1.0+browser-scoring/v1'
export const LEGACY_FALLBACK_ENGINE_VERSION = 'typescript-prototype-scoring/v1'

const FALLBACK_DRIFT = '-500000000000'
const LEGACY_PATH_SOURCE = 'typescript-bridge-extrema/v2' as const
const WASM_PATH_SOURCE = 'rust-wasm-bridge-extrema/v1' as const
const PATH_SEED_DOMAIN = 'strikefall/rust-path-seed/v1'

const DECK_IDS: Readonly<Record<string, string>> = {
  'balanced-tape': 'balanced_tape',
  'compression-break': 'compression_break',
  'opening-rush': 'opening_rush',
  pulse: 'pulse',
}

interface DescriptorIdentity {
  mode: ScoringEngineDescriptor['mode']
  engineVersion: string
  rankable: boolean
  rustDeckId: string | null
  rustDeckVersion: number | null
  pricingVarianceFixed: string
  driftPerVarianceFixed: string
  pathSource: ScoringEngineDescriptor['pathSource']
}

function identityOf(descriptor: ScoringEngineDescriptor): DescriptorIdentity {
  return {
    mode: descriptor.mode,
    engineVersion: descriptor.engineVersion,
    rankable: descriptor.rankable,
    rustDeckId: descriptor.rustDeckId,
    rustDeckVersion: descriptor.rustDeckVersion,
    pricingVarianceFixed: descriptor.pricingVarianceFixed,
    driftPerVarianceFixed: descriptor.driftPerVarianceFixed,
    pathSource: descriptor.pathSource,
  }
}

/** FNV is an identity checksum; the surrounding replay commitment is SHA-256. */
export function scoringEngineDigest(identity: DescriptorIdentity): string {
  const encoded = JSON.stringify(identity)
  let hash = 14_695_981_039_346_656_037n
  const prime = 1_099_511_628_211n
  const mask = (1n << 64n) - 1n
  for (const byte of new TextEncoder().encode(encoded)) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & mask
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`
}

function descriptor(
  identity: DescriptorIdentity,
  reason: string | null,
): ScoringEngineDescriptor {
  return { ...identity, digest: scoringEngineDigest(identity), reason }
}

/** Decoder identity only. New browser rounds can never activate this engine. */
export function createLegacyFallbackEngineDescriptor(reason: string): ScoringEngineDescriptor {
  return descriptor(
    {
      mode: 'typescript-fallback',
      engineVersion: LEGACY_FALLBACK_ENGINE_VERSION,
      rankable: false,
      rustDeckId: null,
      rustDeckVersion: null,
      pricingVarianceFixed: displayNumberToFixed(DEFAULT_BROWSER_PRICING_VARIANCE),
      driftPerVarianceFixed: FALLBACK_DRIFT,
      pathSource: LEGACY_PATH_SOURCE,
    },
    reason,
  )
}

function createUnavailableEngineDescriptor(reason: string): ScoringEngineDescriptor {
  return descriptor(
    {
      mode: 'unavailable',
      engineVersion: 'scoring-unavailable/v1',
      rankable: false,
      rustDeckId: null,
      rustDeckVersion: null,
      pricingVarianceFixed: displayNumberToFixed(DEFAULT_BROWSER_PRICING_VARIANCE),
      driftPerVarianceFixed: FALLBACK_DRIFT,
      pathSource: WASM_PATH_SOURCE,
    },
    reason,
  )
}

function createWasmDescriptor(
  deck: StrikefallDeck,
): ScoringEngineDescriptor {
  return descriptor(
    {
      mode: 'wasm-solmath',
      engineVersion: WASM_ENGINE_VERSION,
      rankable: true,
      rustDeckId: deck.id,
      rustDeckVersion: deck.version,
      pricingVarianceFixed: deck.totalIntegratedVariance,
      driftPerVarianceFixed: deck.driftPerVariance,
      pathSource: WASM_PATH_SOURCE,
    },
    null,
  )
}

const initialUnavailable = createUnavailableEngineDescriptor('SolMath is not initialized.')
let runtime: EngineRuntime = { descriptor: initialUnavailable, client: null }
let status: ScoringEngineStatus = {
  status: 'idle',
  descriptor: initialUnavailable,
  message: 'Preparing the SolMath scoring engine…',
}

export function rustDeckId(tsDeckId: string): string {
  const mapped = DECK_IDS[tsDeckId]
  if (!mapped) throw new RangeError(`No Rust deck mapping for ${tsDeckId}`)
  return mapped
}

export function getScoringEngineStatus(): ScoringEngineStatus {
  return status
}

export function getActiveScoringEngine(): EngineRuntime {
  return runtime
}

export function getActiveScoringEngineDescriptor(): ScoringEngineDescriptor {
  return runtime.descriptor
}

export function scoringEngineDescriptorIsValid(value: ScoringEngineDescriptor): boolean {
  return value.digest === scoringEngineDigest(identityOf(value))
}

export function activeEngineMatches(expected: ScoringEngineDescriptor): boolean {
  return (
    scoringEngineDescriptorIsValid(expected) &&
    runtime.descriptor.digest === expected.digest &&
    runtime.descriptor.mode === expected.mode
  )
}

export function assertActiveEngine(expected: ScoringEngineDescriptor): void {
  if (expected.mode !== 'wasm-solmath') {
    throw new Error(`New rounds require SolMath WASM; ${expected.mode} is replay metadata only`)
  }
  if (!activeEngineMatches(expected)) {
    throw new Error(
      `Scoring engine mismatch: replay requires ${expected.mode}/${expected.digest}`,
    )
  }
  if (!runtime.client) {
    throw new Error('The replay requires the SolMath WASM scorer, but it is not ready')
  }
}

function blockScoringEngine(reason: string): ScoringEngineDescriptor {
  const next = createUnavailableEngineDescriptor(reason)
  runtime = { descriptor: next, client: null }
  status = {
    status: 'blocked',
    descriptor: next,
    message: `SolMath is required to play: ${reason}`,
  }
  return next
}

function findDeck(client: StrikefallWasmClient, input: EngineDeckInput): StrikefallDeck {
  const id = rustDeckId(input.id)
  const found = client.deckCatalog().find((deck) => deck.id === id)
  if (!found) throw new Error(`SolMath WASM does not contain ${id}`)
  if (found.displayName !== input.name) {
    throw new Error(`Deck identity mismatch for ${input.id}`)
  }
  if (input.version !== undefined && found.version !== input.version) {
    throw new Error(`Deck version mismatch for ${input.id}`)
  }
  if (
    input.monitoringConvention !== undefined
    && found.monitoringConvention !== input.monitoringConvention
  ) {
    throw new Error(`Deck monitoring mismatch for ${input.id}`)
  }
  if (input.variance !== undefined) {
    const browserTotal = input.variance.reduce((sum, weight) => sum + weight, 0)
    const rustTotal = found.varianceWeights.reduce((sum, weight) => sum + weight, 0)
    const matches = Number.isFinite(browserTotal)
      && browserTotal > 0
      && rustTotal > 0
      && input.variance.every((weight, index) => (
        Number.isFinite(weight)
        && weight > 0
        && Math.abs(weight / browserTotal - found.varianceWeights[index]! / rustTotal) <= 1e-12
      ))
    if (!matches) throw new Error(`Deck variance schedule mismatch for ${input.id}`)
  }
  if (
    input.openingRunway !== undefined
    && (
      found.openingRunway.steps !== input.openingRunway.steps
      || found.openingRunway.varianceShareBps !== input.openingRunway.varianceShareBps
    )
  ) {
    throw new Error(`Deck opening runway mismatch for ${input.id}`)
  }
  return found
}

function smokeTest(client: StrikefallWasmClient, engine: ScoringEngineDescriptor): void {
  const spot = '100000000000000'
  const barrier = '110000000000000'
  const quote = client.quoteNoTouch({
    spot,
    barrier,
    remainingVariance: engine.pricingVarianceFixed,
    driftPerVariance: engine.driftPerVarianceFixed,
    side: 'upper',
  })
  if (BigInt(quote.survivalProbability) <= 0n) {
    throw new Error('SolMath smoke quote returned no survival value')
  }
  const locked = client.lockLobbyScores({
    spot,
    remainingVariance: engine.pricingVarianceFixed,
    driftPerVariance: engine.driftPerVarianceFixed,
    placements: [{ contenderId: 0, side: 'upper', barrier }],
  })
  if (locked.length !== 1) throw new Error('SolMath smoke lock returned the wrong lobby size')
}

export function installScoringEngineClient(
  client: StrikefallWasmClient,
  deckInput: EngineDeckInput,
  pricingVariance = DEFAULT_BROWSER_PRICING_VARIANCE,
): ScoringEngineDescriptor {
  const deck = findDeck(client, deckInput)
  if (
    displayNumberToFixed(pricingVariance, 'pricingVariance')
    !== deck.totalIntegratedVariance
  ) {
    throw new Error(`Pricing variance mismatch for ${deckInput.id}`)
  }
  const next = createWasmDescriptor(deck)
  smokeTest(client, next)
  runtime = { descriptor: next, client }
  status = {
    status: 'ready',
    descriptor: next,
    message: `SolMath WASM ready · ${deck.displayName} v${deck.version} · canonical Rust path`,
  }
  return next
}

/** Selects a deck synchronously after the single WASM module is cached. */
export function activateScoringEngineForDeck(
  deckInput: EngineDeckInput,
  pricingVariance = DEFAULT_BROWSER_PRICING_VARIANCE,
): ScoringEngineDescriptor {
  if (!runtime.client) {
    throw new Error('SolMath WASM must be initialized before selecting a deck')
  }
  return installScoringEngineClient(runtime.client, deckInput, pricingVariance)
}

/**
 * Restores the requested committed scorer before replay regeneration. Legacy
 * TypeScript descriptors remain decodable but deliberately cannot execute.
 */
export function ensureScoringEngineForDeck(
  deckInput: EngineDeckInput,
  expected?: ScoringEngineDescriptor,
): ScoringEngineDescriptor {
  const selected = activateScoringEngineForDeck(deckInput)
  if (expected && (
    expected.mode !== 'wasm-solmath'
    || expected.digest !== selected.digest
  )) {
    throw new Error(
      `Replay scorer ${expected.mode}/${expected.digest} is not executable by the public-alpha runtime`,
    )
  }
  return selected
}

export async function initializeScoringEngine(
  deck: EngineDeckInput,
  pricingVariance = DEFAULT_BROWSER_PRICING_VARIANCE,
): Promise<ScoringEngineStatus> {
  const id = rustDeckId(deck.id)
  if (
    status.status === 'ready' &&
    runtime.descriptor.rustDeckId === id &&
    runtime.descriptor.pricingVarianceFixed === displayNumberToFixed(pricingVariance)
  ) {
    return status
  }

  status = {
    status: 'loading',
    descriptor: runtime.descriptor,
    message: 'Loading the SolMath WASM scoring engine…',
  }
  try {
    const wasmState = getStrikefallWasmState()
    const loaded = await loadStrikefallWasm({
      retry: wasmState.status === 'error' || wasmState.status === 'unsupported',
    })
    if (loaded.status === 'ready') {
      installScoringEngineClient(loaded.client, deck, pricingVariance)
      return status
    }
    const reason = loaded.status === 'unsupported'
      ? loaded.reason
      : loaded.error.message
    blockScoringEngine(reason)
  } catch (error) {
    blockScoringEngine(
      error instanceof Error ? error.message : 'SolMath WASM could not start',
    )
  }
  return status
}

function readyClient(): StrikefallWasmClient {
  if (runtime.descriptor.mode !== 'wasm-solmath' || !runtime.client) {
    throw new Error('SolMath WASM is required for scoring and probability quotes')
  }
  return runtime.client
}

/** Stable, domain-separated UTF-8 FNV-1a mapping into Rust's u64 seed space. */
export function pathSeedToU64(seed: string): string {
  if (!seed.trim()) throw new RangeError('A path seed is required')
  let hash = 14_695_981_039_346_656_037n
  const prime = 1_099_511_628_211n
  const mask = (1n << 64n) - 1n
  const message = `${PATH_SEED_DOMAIN}\u0000${seed}`
  for (const byte of new TextEncoder().encode(message)) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & mask
  }
  return hash.toString()
}

function validateGeneratedPath(
  points: readonly StrikefallPathPoint[],
  expectedSteps: number,
  expectedInitialSpot: string,
  context: string,
): void {
  if (points.length !== expectedSteps + 1) {
    throw new Error(`${context} returned ${points.length} points; expected ${expectedSteps + 1}`)
  }
  for (const [index, point] of points.entries()) {
    if (point.step !== index) throw new Error(`${context} returned a non-canonical step sequence`)
  }
  if (points[0]?.price !== expectedInitialSpot) {
    throw new Error(`${context} returned the wrong initial spot`)
  }
}

/** Generates the full canonical Rust approach and battle for local Practice. */
export function generateRoundPathWithActiveEngine(
  deckInput: EngineDeckInput,
  seed: string,
  initialSpot: number,
): StrikefallRoundPath {
  const client = readyClient()
  const deck = findDeck(client, deckInput)
  const encodedSpot = displayNumberToFixed(initialSpot, 'initialSpot')
  const path = client.generateRoundPath({
    deckId: deck.id,
    deckVersion: deck.version,
    seed: pathSeedToU64(seed),
    initialSpot: encodedSpot,
  })
  validateGeneratedPath(path.approach, deck.approachSteps, encodedSpot, 'Rust approach path')
  const battleSpot = path.approach.at(-1)?.price
  if (!battleSpot) throw new Error('Rust approach path has no terminal spot')
  validateGeneratedPath(path.battle, deck.battleSteps, battleSpot, 'Rust battle path')
  return path
}

/** Generates the exact ranked-core battle stream for model and balance campaigns. */
export function generateBattlePathWithActiveEngine(
  deckInput: EngineDeckInput,
  seed: string,
  initialSpot: number,
): readonly StrikefallPathPoint[] {
  const client = readyClient()
  const deck = findDeck(client, deckInput)
  const encodedSpot = displayNumberToFixed(initialSpot, 'initialSpot')
  const path = client.generateBattlePath({
    deckId: deck.id,
    deckVersion: deck.version,
    seed: pathSeedToU64(seed),
    initialSpot: encodedSpot,
  })
  validateGeneratedPath(path, deck.battleSteps, encodedSpot, 'Rust battle path')
  return path
}

/**
 * Resolves a display frame to the exact Rust microstep represented by that
 * frame, then asks the core for the remaining fixed variance.
 */
export function remainingVarianceWithActiveEngine(
  deckInput: EngineDeckInput,
  completedFrame: number,
  displayBattlePoints: number,
): number {
  return fixedToDisplayNumber(
    remainingVarianceFixedWithActiveEngine(deckInput, completedFrame, displayBattlePoints),
    'remainingVariance',
  )
}

/** Exact SCALE=1e12 remaining variance for probability/scoring inputs. */
export function remainingVarianceFixedWithActiveEngine(
  deckInput: EngineDeckInput,
  completedFrame: number,
  displayBattlePoints: number,
): string {
  if (!Number.isInteger(displayBattlePoints) || displayBattlePoints < 2) {
    throw new RangeError('Display battle points must be an integer of at least two')
  }
  const client = readyClient()
  const deck = findDeck(client, deckInput)
  const boundedFrame = Math.min(
    displayBattlePoints - 1,
    Math.max(0, Math.floor(completedFrame)),
  )
  const completedSteps = Math.floor(
    (boundedFrame * deck.battleSteps) / (displayBattlePoints - 1),
  )
  return canonicalUnsignedFixed(
    client.remainingVariance({ deckId: deck.id, deckVersion: deck.version, completedSteps }),
    'remainingVariance',
  )
}

export function lockLobbyWithActiveEngine(
  spot: number,
  placements: readonly EnginePlacementInput[],
  spotFixed?: string,
): EngineLockedScore[] {
  const client = readyClient()
  const encodedPlacements = placements.map((placement, contenderId) => ({
    contenderId,
    side: placement.side,
    barrier: placement.barrierFixed !== undefined
      ? canonicalUnsignedFixed(
          placement.barrierFixed,
          `placements[${contenderId}].barrierFixed`,
        )
      : displayNumberToFixed(placement.barrier, `placements[${contenderId}].barrier`),
  }))
  const locked = client.lockLobbyScores({
    spot: spotFixed !== undefined
      ? canonicalUnsignedFixed(spotFixed, 'spotFixed')
      : displayNumberToFixed(spot, 'spot'),
    remainingVariance: runtime.descriptor.pricingVarianceFixed,
    driftPerVariance: runtime.descriptor.driftPerVarianceFixed,
    placements: encodedPlacements,
  })
  if (locked.length !== placements.length) {
    throw new Error('SolMath returned an incomplete locked lobby')
  }
  return locked.map((score) => {
    const placement = placements[score.contenderId]
    if (!placement) throw new Error(`SolMath returned unknown contender ${score.contenderId}`)
    return {
      id: placement.id,
      survivalFixed: score.initialSurvival,
      riskFixed: score.riskMultiplier,
      crowdFixed: score.crowdFactor,
      potentialFixed: score.terminalScore,
      survival: fixedToDisplayNumber(score.initialSurvival, 'initialSurvival'),
      risk: fixedToDisplayNumber(score.riskMultiplier, 'riskMultiplier'),
      crowd: fixedToDisplayNumber(score.crowdFactor, 'crowdFactor'),
      potential: fixedToRoundedPoints(score.terminalScore, 'terminalScore'),
    }
  })
}

export function quoteWithActiveEngine(input: EngineQuoteInput): EngineQuoteResult {
  const client = readyClient()
  const quote = client.quoteNoTouch({
    spot: input.spotFixed !== undefined
      ? canonicalUnsignedFixed(input.spotFixed, 'spotFixed')
      : displayNumberToFixed(input.spot, 'spot'),
    barrier: input.barrierFixed !== undefined
      ? canonicalUnsignedFixed(input.barrierFixed, 'barrierFixed')
      : displayNumberToFixed(input.barrier, 'barrier'),
    remainingVariance: input.remainingVarianceFixed !== undefined
      ? canonicalUnsignedFixed(input.remainingVarianceFixed, 'remainingVarianceFixed')
      : displayNumberToFixed(input.remainingVariance, 'remainingVariance'),
    driftPerVariance: runtime.descriptor.driftPerVarianceFixed,
    side: input.side,
    alreadyBreached: input.alreadyBreached,
  })
  return {
    survivalProbabilityFixed: quote.survivalProbability,
    hitProbabilityFixed: quote.hitProbability,
    survivalProbability: fixedToDisplayNumber(
      quote.survivalProbability,
      'survivalProbability',
    ),
    hitProbability: fixedToDisplayNumber(quote.hitProbability, 'hitProbability'),
  }
}

export function barrierWithActiveEngine(
  spot: number,
  targetSurvival: number,
  side: 'upper' | 'lower',
  spotFixed?: string,
): number {
  return fixedToDisplayNumber(
    barrierFixedWithActiveEngine(spot, targetSurvival, side, spotFixed),
    'barrier',
  )
}

/** Returns the exact SolMath barrier; the Number arguments are UI controls. */
export function barrierFixedWithActiveEngine(
  spot: number,
  targetSurvival: number,
  side: 'upper' | 'lower',
  spotFixed?: string,
): string {
  const client = readyClient()
  const barrier = client.barrierForSurvival({
    spot: spotFixed !== undefined
      ? canonicalUnsignedFixed(spotFixed, 'spotFixed')
      : displayNumberToFixed(spot, 'spot'),
    targetSurvival: probabilityNumberToFixed(targetSurvival),
    remainingVariance: runtime.descriptor.pricingVarianceFixed,
    driftPerVariance: runtime.descriptor.driftPerVarianceFixed,
    side,
  })
  return canonicalUnsignedFixed(barrier, 'barrier')
}
