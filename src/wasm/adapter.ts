import type { InitInput } from './generated/strikefall_wasm.js'

declare const unsignedDecimalBrand: unique symbol
declare const signedDecimalBrand: unique symbol
declare const u64DecimalBrand: unique symbol

/** Canonical unsigned decimal text bounded to Rust's `u128`. */
export type UnsignedDecimal = string & { readonly [unsignedDecimalBrand]: true }
/** Canonical signed decimal text bounded to Rust's `i128`. */
export type SignedDecimal = string & { readonly [signedDecimalBrand]: true }
/** Canonical unsigned decimal text bounded to Rust's `u64`. */
export type U64Decimal = UnsignedDecimal & { readonly [u64DecimalBrand]: true }
export type DecimalInput = string | bigint
export type BarrierSide = 'upper' | 'lower'

export interface StrikefallOpeningRunway {
  steps: number
  varianceShareBps: number
}

export interface StrikefallDeck {
  id: string
  version: number
  displayName: string
  approachSteps: number
  battleSteps: number
  stepMs: number
  monitoringConvention: string
  varianceWeights: readonly [number, number, number, number]
  openingRunway: StrikefallOpeningRunway
  totalIntegratedVariance: UnsignedDecimal
  driftPerVariance: SignedDecimal
  minInitialSurvival: UnsignedDecimal
  maxInitialSurvival: UnsignedDecimal
  riskMultiplierCap: UnsignedDecimal
  artTheme: string
  audioProfile: string
  calibrationDigest: string
}

export interface StrikefallPathPoint {
  step: number
  varianceElapsed: UnsignedDecimal
  logReturn: SignedDecimal
  price: UnsignedDecimal
  intervalHigh: UnsignedDecimal
  intervalLow: UnsignedDecimal
}

export interface StrikefallRoundPath {
  approach: readonly StrikefallPathPoint[]
  battle: readonly StrikefallPathPoint[]
}

export interface NoTouchQuote {
  survivalProbability: UnsignedDecimal
  hitProbability: UnsignedDecimal
}

export interface QuoteNoTouchInput {
  spot: DecimalInput
  barrier: DecimalInput
  remainingVariance: DecimalInput
  driftPerVariance: DecimalInput
  side: BarrierSide
  alreadyBreached?: boolean
}

export interface BarrierForSurvivalInput {
  spot: DecimalInput
  targetSurvival: DecimalInput
  remainingVariance: DecimalInput
  driftPerVariance: DecimalInput
  side: BarrierSide
}

export interface RoundPathInput {
  deckId: string
  deckVersion: number
  seed: DecimalInput
  initialSpot: DecimalInput
}

export interface RemainingVarianceInput {
  deckId: string
  deckVersion: number
  completedSteps: number
}

export interface LobbyPlacementInput {
  contenderId: number
  side: BarrierSide
  barrier: DecimalInput
}

export interface LockLobbyScoresInput {
  spot: DecimalInput
  remainingVariance: DecimalInput
  driftPerVariance: DecimalInput
  placements: readonly LobbyPlacementInput[]
}

export interface LockedLobbyScore {
  contenderId: number
  side: BarrierSide
  barrier: UnsignedDecimal
  normalizedDistance: UnsignedDecimal
  initialSurvival: UnsignedDecimal
  riskMultiplier: UnsignedDecimal
  crowdFactor: UnsignedDecimal
  terminalScore: UnsignedDecimal
}

export interface RankedReplayVerificationInput {
  replayJson: string
  expectedCommitment: string
  expectedServerKey: string
}

export interface RankedReplayVerificationReport {
  valid: boolean
  roundId: string
  verifiedChecks: readonly string[]
  pathPoints: number
  signedEvents: number
}

export interface StrikefallWasmClient {
  deckCatalog(): readonly StrikefallDeck[]
  generateRoundPath(input: RoundPathInput): StrikefallRoundPath
  generateBattlePath(input: RoundPathInput): readonly StrikefallPathPoint[]
  remainingVariance(input: RemainingVarianceInput): UnsignedDecimal
  quoteNoTouch(input: QuoteNoTouchInput): NoTouchQuote
  barrierForSurvival(input: BarrierForSurvivalInput): UnsignedDecimal
  lockLobbyScores(input: LockLobbyScoresInput): readonly LockedLobbyScore[]
  verifyRankedReplayJson(input: RankedReplayVerificationInput): RankedReplayVerificationReport
}

/** Minimal generated boundary shape, exported to support deterministic adapter tests. */
export interface StrikefallWasmBindings {
  deck_catalog_json(): string
  generate_round_path_json(deckId: string, deckVersion: number, seed: string, initialSpot: string): string
  generate_battle_path_json(deckId: string, deckVersion: number, seed: string, initialSpot: string): string
  remaining_variance_fixed(deckId: string, deckVersion: number, completedSteps: number): string
  quote_no_touch_json(
    spot: string,
    barrier: string,
    remainingVariance: string,
    driftPerVariance: string,
    side: string,
    alreadyBreached: boolean,
  ): string
  barrier_for_survival_fixed(
    spot: string,
    targetSurvival: string,
    remainingVariance: string,
    driftPerVariance: string,
    side: string,
  ): string
  lock_lobby_scores_json(
    spot: string,
    remainingVariance: string,
    driftPerVariance: string,
    placementsJson: string,
  ): string
  verify_ranked_replay_json(
    replayJson: string,
    expectedCommitment: string,
    expectedServerKey: string,
  ): string
}

export class StrikefallWasmError extends Error {
  override readonly name = 'StrikefallWasmError'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export type StrikefallWasmState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly client: StrikefallWasmClient }
  | { readonly status: 'unsupported'; readonly reason: string }
  | { readonly status: 'error'; readonly error: StrikefallWasmError }

export type StrikefallWasmLoadResult = Exclude<StrikefallWasmState, { status: 'idle' | 'loading' }>

export interface LoadStrikefallWasmOptions {
  /** Optional bytes, compiled module, response, or URL. Omit for Vite's emitted asset URL. */
  moduleOrPath?: InitInput | Promise<InitInput>
  /** Retry a previous unsupported or failed load. */
  retry?: boolean
}

export interface StrikefallWasmLoader {
  getState(): StrikefallWasmState
  load(options?: LoadStrikefallWasmOptions): Promise<StrikefallWasmLoadResult>
}

/** Dependency seam used by the singleton loader and its state-machine tests. */
export interface StrikefallWasmLoaderDependencies {
  isSupported(): boolean
  initialize(moduleOrPath?: InitInput | Promise<InitInput>): Promise<StrikefallWasmBindings>
}

const U128_MAX = (1n << 128n) - 1n
const I128_MIN = -(1n << 127n)
const I128_MAX = (1n << 127n) - 1n
const U64_MAX = (1n << 64n) - 1n
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/
const SIGNED_DECIMAL = /^(0|-?[1-9][0-9]*)$/

function canonicalDecimal(
  value: DecimalInput,
  field: string,
  pattern: RegExp,
  minimum: bigint,
  maximum: bigint,
): string {
  if (typeof value !== 'string' && typeof value !== 'bigint') {
    throw new TypeError(`${field} must be a decimal string or bigint; JavaScript numbers are not accepted`)
  }
  const encoded = typeof value === 'bigint' ? value.toString() : value
  if (!pattern.test(encoded)) {
    throw new TypeError(`${field} must be a canonical decimal integer`)
  }
  const parsed = BigInt(encoded)
  if (parsed < minimum || parsed > maximum) {
    throw new RangeError(`${field} is outside the supported integer range`)
  }
  return encoded
}

export function toUnsignedDecimal(value: DecimalInput, field = 'value'): UnsignedDecimal {
  return canonicalDecimal(value, field, UNSIGNED_DECIMAL, 0n, U128_MAX) as UnsignedDecimal
}

export function toSignedDecimal(value: DecimalInput, field = 'value'): SignedDecimal {
  return canonicalDecimal(value, field, SIGNED_DECIMAL, I128_MIN, I128_MAX) as SignedDecimal
}

export function toU64Decimal(value: DecimalInput, field = 'seed'): U64Decimal {
  return canonicalDecimal(value, field, UNSIGNED_DECIMAL, 0n, U64_MAX) as U64Decimal
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function boundaryError(operation: string, error: unknown): StrikefallWasmError {
  if (error instanceof StrikefallWasmError) return error
  return new StrikefallWasmError(`${operation} failed: ${describeError(error)}`, { cause: error })
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StrikefallWasmError(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new StrikefallWasmError(`${context} must be an array`)
  return value
}

function text(object: Record<string, unknown>, key: string, context: string): string {
  const value = object[key]
  if (typeof value !== 'string') throw new StrikefallWasmError(`${context}.${key} must be a string`)
  return value
}

function integer(
  object: Record<string, unknown>,
  key: string,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = object[key]
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0 || value > maximum) {
    throw new StrikefallWasmError(`${context}.${key} must be an unsigned integer`)
  }
  return value
}

function side(value: unknown, context: string): BarrierSide {
  if (value !== 'upper' && value !== 'lower') {
    throw new StrikefallWasmError(`${context} must be "upper" or "lower"`)
  }
  return value
}

function deckVersion(value: unknown): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > 65_535) {
    throw new RangeError('deckVersion must be a positive u16')
  }
  return value
}

function hexDigest(object: Record<string, unknown>, key: string, context: string): string {
  const value = text(object, key, context)
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new StrikefallWasmError(`${context}.${key} must be 32 lowercase hexadecimal bytes`)
  }
  return value
}

function decodeDeck(value: unknown, index: number): StrikefallDeck {
  const context = `deckCatalog[${index}]`
  const object = record(value, context)
  const weights = array(object.varianceWeights, `${context}.varianceWeights`)
  if (weights.length !== 4) {
    throw new StrikefallWasmError(`${context}.varianceWeights must contain four entries`)
  }
  const varianceWeights = weights.map((weight, weightIndex) => {
    if (!Number.isInteger(weight) || typeof weight !== 'number' || weight <= 0 || weight > 65_535) {
      throw new StrikefallWasmError(`${context}.varianceWeights[${weightIndex}] must be a positive u16`)
    }
    return weight
  }) as [number, number, number, number]
  const openingRunway = record(object.openingRunway, `${context}.openingRunway`)
  const runwaySteps = integer(openingRunway, 'steps', `${context}.openingRunway`, 65_535)
  const runwayShareBps = integer(
    openingRunway,
    'varianceShareBps',
    `${context}.openingRunway`,
    9_999,
  )
  const battleSteps = integer(object, 'battleSteps', context, 65_535)
  if (
    runwaySteps === 0
    || runwaySteps >= Math.floor(battleSteps / 4)
    || runwayShareBps === 0
    || runwayShareBps * Math.floor(battleSteps / 4) >= 10_000 * runwaySteps
  ) {
    throw new StrikefallWasmError(`${context}.openingRunway must be a lower-than-linear first-quarter schedule`)
  }

  return {
    id: text(object, 'id', context),
    version: integer(object, 'version', context, 65_535),
    displayName: text(object, 'displayName', context),
    approachSteps: integer(object, 'approachSteps', context, 65_535),
    battleSteps,
    stepMs: integer(object, 'stepMs', context, 65_535),
    monitoringConvention: text(object, 'monitoringConvention', context),
    varianceWeights,
    openingRunway: {
      steps: runwaySteps,
      varianceShareBps: runwayShareBps,
    },
    totalIntegratedVariance: toUnsignedDecimal(text(object, 'totalIntegratedVariance', context), `${context}.totalIntegratedVariance`),
    driftPerVariance: toSignedDecimal(text(object, 'driftPerVariance', context), `${context}.driftPerVariance`),
    minInitialSurvival: toUnsignedDecimal(text(object, 'minInitialSurvival', context), `${context}.minInitialSurvival`),
    maxInitialSurvival: toUnsignedDecimal(text(object, 'maxInitialSurvival', context), `${context}.maxInitialSurvival`),
    riskMultiplierCap: toUnsignedDecimal(text(object, 'riskMultiplierCap', context), `${context}.riskMultiplierCap`),
    artTheme: text(object, 'artTheme', context),
    audioProfile: text(object, 'audioProfile', context),
    calibrationDigest: hexDigest(object, 'calibrationDigest', context),
  }
}

function decodePathPoint(value: unknown, context: string): StrikefallPathPoint {
  const object = record(value, context)
  const point = {
    step: integer(object, 'step', context, 65_535),
    varianceElapsed: toUnsignedDecimal(text(object, 'varianceElapsed', context), `${context}.varianceElapsed`),
    logReturn: toSignedDecimal(text(object, 'logReturn', context), `${context}.logReturn`),
    price: toUnsignedDecimal(text(object, 'price', context), `${context}.price`),
    intervalHigh: toUnsignedDecimal(text(object, 'intervalHigh', context), `${context}.intervalHigh`),
    intervalLow: toUnsignedDecimal(text(object, 'intervalLow', context), `${context}.intervalLow`),
  }
  if (BigInt(point.intervalLow) > BigInt(point.price)) {
    throw new StrikefallWasmError(`${context}.intervalLow must not exceed price`)
  }
  if (BigInt(point.intervalHigh) < BigInt(point.price)) {
    throw new StrikefallWasmError(`${context}.intervalHigh must not be below price`)
  }
  return point
}

function decodeRoundPath(value: unknown): StrikefallRoundPath {
  const object = record(value, 'roundPath')
  return {
    approach: array(object.approach, 'roundPath.approach').map((point, index) =>
      decodePathPoint(point, `roundPath.approach[${index}]`),
    ),
    battle: array(object.battle, 'roundPath.battle').map((point, index) =>
      decodePathPoint(point, `roundPath.battle[${index}]`),
    ),
  }
}

function decodePath(value: unknown, context: string): readonly StrikefallPathPoint[] {
  return array(value, context).map((point, index) => decodePathPoint(point, `${context}[${index}]`))
}

function decodeQuote(value: unknown): NoTouchQuote {
  const object = record(value, 'quote')
  return {
    survivalProbability: toUnsignedDecimal(
      text(object, 'survivalProbability', 'quote'),
      'quote.survivalProbability',
    ),
    hitProbability: toUnsignedDecimal(text(object, 'hitProbability', 'quote'), 'quote.hitProbability'),
  }
}

function decodeLockedScore(value: unknown, index: number): LockedLobbyScore {
  const context = `lockedScores[${index}]`
  const object = record(value, context)
  return {
    contenderId: integer(object, 'contenderId', context, 65_535),
    side: side(object.side, `${context}.side`),
    barrier: toUnsignedDecimal(text(object, 'barrier', context), `${context}.barrier`),
    normalizedDistance: toUnsignedDecimal(
      text(object, 'normalizedDistance', context),
      `${context}.normalizedDistance`,
    ),
    initialSurvival: toUnsignedDecimal(text(object, 'initialSurvival', context), `${context}.initialSurvival`),
    riskMultiplier: toUnsignedDecimal(text(object, 'riskMultiplier', context), `${context}.riskMultiplier`),
    crowdFactor: toUnsignedDecimal(text(object, 'crowdFactor', context), `${context}.crowdFactor`),
    terminalScore: toUnsignedDecimal(text(object, 'terminalScore', context), `${context}.terminalScore`),
  }
}

function decodeRankedReplayVerification(value: unknown): RankedReplayVerificationReport {
  const context = 'rankedReplayVerification'
  const object = record(value, context)
  if (typeof object.valid !== 'boolean') {
    throw new StrikefallWasmError(`${context}.valid must be a boolean`)
  }
  const verifiedChecks = array(object.verifiedChecks, `${context}.verifiedChecks`).map(
    (check, index) => {
      if (typeof check !== 'string' || check.length === 0) {
        throw new StrikefallWasmError(`${context}.verifiedChecks[${index}] must be text`)
      }
      return check
    },
  )
  return {
    valid: object.valid,
    roundId: text(object, 'roundId', context),
    verifiedChecks,
    pathPoints: integer(object, 'pathPoints', context),
    signedEvents: integer(object, 'signedEvents', context),
  }
}

function parseJson<T>(operation: string, encoded: string, decode: (value: unknown) => T): T {
  try {
    return decode(JSON.parse(encoded) as unknown)
  } catch (error) {
    throw boundaryError(`${operation} response validation`, error)
  }
}

function invoke<T>(operation: string, callback: () => T): T {
  try {
    return callback()
  } catch (error) {
    throw boundaryError(operation, error)
  }
}

export function createStrikefallWasmClient(bindings: StrikefallWasmBindings): StrikefallWasmClient {
  return {
    deckCatalog() {
      return invoke('deck catalog', () =>
        parseJson('deck catalog', bindings.deck_catalog_json(), (value) =>
          array(value, 'deckCatalog').map(decodeDeck),
        ),
      )
    },

    generateRoundPath(input) {
      return invoke('round path replay', () => {
        if (typeof input.deckId !== 'string' || input.deckId.length === 0) {
          throw new TypeError('deckId must be a non-empty string')
        }
        const encoded = bindings.generate_round_path_json(
          input.deckId,
          deckVersion(input.deckVersion),
          toU64Decimal(input.seed),
          toUnsignedDecimal(input.initialSpot, 'initialSpot'),
        )
        return parseJson('round path replay', encoded, decodeRoundPath)
      })
    },

    generateBattlePath(input) {
      return invoke('battle path replay', () => {
        if (typeof input.deckId !== 'string' || input.deckId.length === 0) {
          throw new TypeError('deckId must be a non-empty string')
        }
        const encoded = bindings.generate_battle_path_json(
          input.deckId,
          deckVersion(input.deckVersion),
          toU64Decimal(input.seed),
          toUnsignedDecimal(input.initialSpot, 'initialSpot'),
        )
        return parseJson('battle path replay', encoded, (value) => decodePath(value, 'battlePath'))
      })
    },

    remainingVariance(input) {
      return invoke('remaining variance', () => {
        if (typeof input.deckId !== 'string' || input.deckId.length === 0) {
          throw new TypeError('deckId must be a non-empty string')
        }
        if (
          !Number.isInteger(input.completedSteps)
          || input.completedSteps < 0
          || input.completedSteps > 65_535
        ) {
          throw new RangeError('completedSteps must be a u16')
        }
        return toUnsignedDecimal(
          bindings.remaining_variance_fixed(
            input.deckId,
            deckVersion(input.deckVersion),
            input.completedSteps,
          ),
          'remainingVariance',
        )
      })
    },

    quoteNoTouch(input) {
      return invoke('no-touch quote', () => {
        if (input.alreadyBreached !== undefined && typeof input.alreadyBreached !== 'boolean') {
          throw new TypeError('alreadyBreached must be a boolean when provided')
        }
        const encoded = bindings.quote_no_touch_json(
          toUnsignedDecimal(input.spot, 'spot'),
          toUnsignedDecimal(input.barrier, 'barrier'),
          toUnsignedDecimal(input.remainingVariance, 'remainingVariance'),
          toSignedDecimal(input.driftPerVariance, 'driftPerVariance'),
          side(input.side, 'side'),
          input.alreadyBreached ?? false,
        )
        return parseJson('no-touch quote', encoded, decodeQuote)
      })
    },

    barrierForSurvival(input) {
      return invoke('barrier solve', () =>
        toUnsignedDecimal(
          bindings.barrier_for_survival_fixed(
            toUnsignedDecimal(input.spot, 'spot'),
            toUnsignedDecimal(input.targetSurvival, 'targetSurvival'),
            toUnsignedDecimal(input.remainingVariance, 'remainingVariance'),
            toSignedDecimal(input.driftPerVariance, 'driftPerVariance'),
            side(input.side, 'side'),
          ),
          'barrier',
        ),
      )
    },

    lockLobbyScores(input) {
      return invoke('lobby scoring', () => {
        const placements = input.placements.map((placement, index) => {
          if (
            !Number.isInteger(placement.contenderId) ||
            placement.contenderId < 0 ||
            placement.contenderId > 65_535
          ) {
            throw new RangeError(`placements[${index}].contenderId must be a u16`)
          }
          return {
            contenderId: placement.contenderId,
            side: side(placement.side, `placements[${index}].side`),
            barrier: toUnsignedDecimal(placement.barrier, `placements[${index}].barrier`),
          }
        })
        const encoded = bindings.lock_lobby_scores_json(
          toUnsignedDecimal(input.spot, 'spot'),
          toUnsignedDecimal(input.remainingVariance, 'remainingVariance'),
          toSignedDecimal(input.driftPerVariance, 'driftPerVariance'),
          JSON.stringify(placements),
        )
        return parseJson('lobby scoring', encoded, (value) =>
          array(value, 'lockedScores').map(decodeLockedScore),
        )
      })
    },

    verifyRankedReplayJson(input) {
      return invoke('ranked replay verification', () => {
        if (typeof input.replayJson !== 'string' || input.replayJson.length === 0) {
          throw new TypeError('replayJson must be non-empty JSON text')
        }
        for (const [field, value] of [
          ['expectedCommitment', input.expectedCommitment],
          ['expectedServerKey', input.expectedServerKey],
        ] as const) {
          if (!/^[0-9a-f]{64}$/.test(value)) {
            throw new TypeError(`${field} must be 32 lowercase hexadecimal bytes`)
          }
        }
        const encoded = bindings.verify_ranked_replay_json(
          input.replayJson,
          input.expectedCommitment,
          input.expectedServerKey,
        )
        return parseJson(
          'ranked replay verification',
          encoded,
          decodeRankedReplayVerification,
        )
      })
    },
  }
}

export function isWebAssemblySupported(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'
}

export function createStrikefallWasmLoader(
  dependencies: StrikefallWasmLoaderDependencies,
): StrikefallWasmLoader {
  let state: StrikefallWasmState = { status: 'idle' }
  let pendingLoad: Promise<StrikefallWasmLoadResult> | undefined

  return {
    getState() {
      return state
    },

    load(options: LoadStrikefallWasmOptions = {}) {
      if (state.status === 'ready') return Promise.resolve(state)
      if (state.status === 'loading' && pendingLoad) return pendingLoad
      if ((state.status === 'unsupported' || state.status === 'error') && !options.retry) {
        return Promise.resolve(state)
      }

      if (!dependencies.isSupported()) {
        const unsupported = {
          status: 'unsupported',
          reason: 'This browser does not provide the WebAssembly APIs required by Strikefall.',
        } as const
        state = unsupported
        return Promise.resolve(unsupported)
      }

      state = { status: 'loading' }
      pendingLoad = (async () => {
        try {
          const bindings = await dependencies.initialize(options.moduleOrPath)
          const ready = { status: 'ready', client: createStrikefallWasmClient(bindings) } as const
          state = ready
          return ready
        } catch (error) {
          const failed = {
            status: 'error',
            error: boundaryError('Strikefall WASM initialization', error),
          } as const
          state = failed
          return failed
        } finally {
          pendingLoad = undefined
        }
      })()

      return pendingLoad
    },
  }
}

const defaultLoader = createStrikefallWasmLoader({
  isSupported: isWebAssemblySupported,
  async initialize(moduleOrPath) {
    const bindings = await import('./generated/strikefall_wasm.js')
    if (moduleOrPath === undefined) {
      await bindings.default()
    } else {
      await bindings.default({ module_or_path: moduleOrPath })
    }
    return bindings
  },
})

export function getStrikefallWasmState(): StrikefallWasmState {
  return defaultLoader.getState()
}

export function loadStrikefallWasm(
  options: LoadStrikefallWasmOptions = {},
): Promise<StrikefallWasmLoadResult> {
  return defaultLoader.load(options)
}
