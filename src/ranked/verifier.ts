import { canonicalStringify } from '../game/canonical'
import { RankedReplayVerificationError } from './errors'
import { RANKED_LOCK_PHASE_MS } from './protocol'
import type {
  HexString,
  RankedProtocolVersion,
  ReplayAnchor,
  ReplayBundle,
  SignedRoundEvent,
} from './types'
import { parseReplayBundle } from './validation'

const TEXT_ENCODER = new TextEncoder()
const ZERO_DIGEST = new Uint8Array(32)
const RANKED_PROTOCOL: RankedProtocolVersion = 'strikefall/ranked-replay/v3'

export const REQUIRED_REGENERATION_CHECKS = Object.freeze([
  'deck_catalog',
  'path_regeneration',
  'bot_roster',
  'bot_placement_audit',
  'final_placements',
  'locked_scores',
  'touches',
  'round_result',
  'bot_escape_audit',
  'event_semantics',
] as const)

export type RankedRegenerationCheck = typeof REQUIRED_REGENERATION_CHECKS[number]

export interface RankedRegenerationReport {
  readonly valid: boolean
  readonly checks: readonly RankedRegenerationCheck[]
  readonly reason?: string
}

/**
 * Boundary for the full Rust replay verifier compiled to WASM.
 *
 * The adapter must regenerate the catalog deck, hidden path, bot decisions,
 * Escape audit, locked scores, touches, result, and lifecycle semantics. A
 * partial report is rejected even when `valid` is true.
 */
export interface RankedReplayRegenerationAdapter {
  readonly id: string
  readonly protocolVersion: RankedProtocolVersion
  verifyReplay(
    bundle: ReplayBundle,
    anchor: ReplayAnchor,
  ): Promise<RankedRegenerationReport>
}

export interface RankedReplayVerifierOptions {
  readonly anchor: ReplayAnchor
  readonly regenerator?: RankedReplayRegenerationAdapter | null
  /** Pass `null` to explicitly model a runtime without WebCrypto. */
  readonly subtle?: SubtleCrypto | null
}

export interface RankedBrowserDigests {
  readonly deck: HexString
  readonly path: HexString
  readonly commitment: HexString
  readonly lockedScores: HexString
  readonly resultProof: HexString
  readonly events: readonly HexString[]
}

export interface RankedReplayVerificationReport {
  readonly valid: true
  readonly protocolVersion: RankedProtocolVersion
  readonly browserChecks: readonly string[]
  readonly delegatedChecks: readonly RankedRegenerationCheck[]
  readonly regenerationVerifier: string
  readonly digests: RankedBrowserDigests
}

function verificationFailure(check: string, detail: string): never {
  throw new RankedReplayVerificationError(
    'verification_failed',
    check,
    `Ranked replay verification failed (${check}): ${detail}`,
  )
}

function verificationUnavailable(check: string, detail: string, cause?: unknown): never {
  throw new RankedReplayVerificationError(
    'verification_unavailable',
    check,
    `Ranked replay verification unavailable (${check}): ${detail}`,
    cause === undefined ? undefined : { cause },
  )
}

function bytesToHex(bytes: Uint8Array): HexString {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('') as HexString
}

function hexToBytes(value: string, expectedBytes: number, field: string): Uint8Array {
  if (value.length !== expectedBytes * 2 || !/^[0-9a-f]+$/.test(value)) {
    return verificationFailure(field, `expected ${expectedBytes} lowercase hexadecimal bytes`)
  }
  const bytes = new Uint8Array(expectedBytes)
  for (let index = 0; index < expectedBytes; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function u64Bytes(value: bigint, field: string): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    return verificationFailure(field, 'value exceeds unsigned 64-bit framing')
  }
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, false)
  return bytes
}

async function sha256(subtle: SubtleCrypto, bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(await subtle.digest('SHA-256', asArrayBuffer(bytes)))
  } catch (error) {
    return verificationUnavailable('webcrypto_sha256', 'SHA-256 is not available', error)
  }
}

async function canonicalDigest(
  subtle: SubtleCrypto,
  value: unknown,
): Promise<HexString> {
  return bytesToHex(await sha256(subtle, TEXT_ENCODER.encode(canonicalStringify(value))))
}

async function hashFramed(
  subtle: SubtleCrypto,
  domain: string,
  parts: readonly Uint8Array[],
): Promise<HexString> {
  const domainBytes = TEXT_ENCODER.encode(domain)
  const framed = [u64Bytes(BigInt(domainBytes.byteLength), 'domain length'), domainBytes]
  for (const part of parts) {
    framed.push(u64Bytes(BigInt(part.byteLength), 'part length'), part)
  }
  return bytesToHex(await sha256(subtle, concatenate(framed)))
}

function normalizedLockedScoresJson(bundle: ReplayBundle): Uint8Array {
  // `locked_scores_digest` uses serde_json::to_vec rather than canonical JSON.
  // Keep this literal order identical to LockedScoreDto's Rust field order.
  const wire = bundle.lockedScores.map((score) => ({
    contenderId: score.contenderId,
    side: score.side,
    barrier: score.barrier,
    normalizedDistance: score.normalizedDistance,
    initialSurvival: score.initialSurvival,
    riskMultiplier: score.riskMultiplier,
    crowdFactor: score.crowdFactor,
    terminalScore: score.terminalScore,
  }))
  return TEXT_ENCODER.encode(JSON.stringify(wire))
}

function normalizedEventKindJson(event: SignedRoundEvent): Uint8Array {
  // parseReplayBundle reconstructs each discriminated variant in the exact
  // `type`, `data`, and DTO field order declared by frozen Rust v2 serde types.
  // Rust event_digest deliberately hashes serde_json::to_vec(kind), not its
  // recursively sorted canonical form.
  return TEXT_ENCODER.encode(JSON.stringify(event.kind))
}

async function computeEventDigest(
  subtle: SubtleCrypto,
  event: SignedRoundEvent,
): Promise<HexString> {
  const previous = event.sequence === 0
    ? ZERO_DIGEST
    : hexToBytes(event.previousDigest, 32, `events[${event.sequence}].previousDigest`)
  return hashFramed(subtle, 'strikefall/ranked-event/v2', [
    previous,
    u64Bytes(BigInt(event.sequence), `events[${event.sequence}].sequence`),
    u64Bytes(BigInt(event.serverTimeMs), `events[${event.sequence}].serverTimeMs`),
    normalizedEventKindJson(event),
  ])
}

function requireAnchor(bundle: ReplayBundle, anchor: ReplayAnchor): void {
  if (anchor.protocolVersion !== RANKED_PROTOCOL || bundle.protocolVersion !== anchor.protocolVersion) {
    verificationFailure('protocol_anchor', 'protocol version differs from the ranked v2 anchor')
  }
  if (bundle.roundId !== anchor.roundId) {
    verificationFailure('round_anchor', 'round id differs from the create response')
  }
  if (bundle.commitment !== anchor.commitment) {
    verificationFailure('commitment_anchor', 'commitment differs from the create response')
  }
  if (bundle.serverVerifyingKey !== anchor.serverVerifyingKey) {
    verificationFailure('server_key_anchor', 'server key differs from the create response')
  }
  if (canonicalStringify(bundle.experimentAssignments)
    !== canonicalStringify(anchor.experimentAssignments)) {
    verificationFailure(
      'experiment_anchor',
      'versioned treatments differ from the create response',
    )
  }
}

async function importEd25519Key(
  subtle: SubtleCrypto,
  encoded: string,
): Promise<CryptoKey> {
  const bytes = hexToBytes(encoded, 32, 'serverVerifyingKey')
  try {
    return await subtle.importKey(
      'raw',
      asArrayBuffer(bytes),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
  } catch (error) {
    return verificationUnavailable(
      'webcrypto_ed25519',
      'Ed25519 public-key import is not supported',
      error,
    )
  }
}

async function verifyEventLog(
  subtle: SubtleCrypto,
  bundle: ReplayBundle,
  anchoredServerKey: string,
): Promise<readonly HexString[]> {
  const key = await importEd25519Key(subtle, anchoredServerKey)
  const eventDigests: HexString[] = []
  let expectedPrevious = '0'.repeat(64)
  for (let index = 0; index < bundle.events.length; index += 1) {
    const event = bundle.events[index]
    if (event === undefined) verificationFailure('event_order', `event ${index} is missing`)
    if (event.sequence !== index || event.previousDigest !== expectedPrevious) {
      verificationFailure('event_order', `event ${index} breaks sequence or previousDigest`)
    }
    if (index > 0 && event.serverTimeMs < (bundle.events[index - 1]?.serverTimeMs ?? 0)) {
      verificationFailure('event_time_order', `event ${index} moves server time backwards`)
    }
    const digest = await computeEventDigest(subtle, event)
    if (event.digest !== digest) {
      verificationFailure('event_digest', `event ${index} digest does not match its framed payload`)
    }
    let verified: boolean
    try {
      verified = await subtle.verify(
        { name: 'Ed25519' },
        key,
        asArrayBuffer(hexToBytes(event.signature, 64, `events[${index}].signature`)),
        asArrayBuffer(hexToBytes(digest, 32, `events[${index}].digest`)),
      )
    } catch (error) {
      return verificationUnavailable(
        'webcrypto_ed25519',
        `Ed25519 verification failed to execute for event ${index}`,
        error,
      )
    }
    if (!verified) verificationFailure('event_signature', `event ${index} signature is invalid`)
    eventDigests.push(digest)
    expectedPrevious = digest
  }
  return eventDigests
}

export async function computeRankedBrowserDigests(
  bundleInput: ReplayBundle,
  subtle: SubtleCrypto,
): Promise<RankedBrowserDigests> {
  const bundle = parseReplayBundle(bundleInput)
  const deck = await canonicalDigest(subtle, { domain: 'strikefall/deck/v1', deck: bundle.deck })
  const path = await canonicalDigest(subtle, { domain: 'strikefall/path/v1', path: bundle.path })
  const botRootDigest = await canonicalDigest(subtle, {
    botSeed: bundle.reveal.botSeedRoot,
    domain: 'strikefall/ranked-bot-root/v2',
    profile: 'ranked-fixed-v2',
  })
  const commitment = await canonicalDigest(subtle, {
    protocolVersion: RANKED_PROTOCOL,
    algorithm: 'SHA-256',
    roundId: bundle.roundId,
    deckDigest: deck,
    pathDigest: path,
    botRootDigest,
    salt: bundle.reveal.salt,
  })
  const lockedScores = await hashFramed(
    subtle,
    'strikefall/locked-scores/v1',
    [normalizedLockedScoresJson(bundle)],
  )
  const resultProof = await canonicalDigest(subtle, {
    domain: 'strikefall/result/v1',
    deckDigest: deck,
    pathDigest: path,
    placements: bundle.placements,
    lockedScores: bundle.lockedScores,
    resolution: {
      escape: bundle.escape,
      botEscapes: bundle.botEscapes,
      touches: bundle.touches,
      contenders: bundle.result.contenders,
    },
  })
  const events: HexString[] = []
  for (const event of bundle.events) events.push(await computeEventDigest(subtle, event))
  return { deck, path, commitment, lockedScores, resultProof, events }
}

function assertDigestLinks(bundle: ReplayBundle, digests: RankedBrowserDigests): void {
  if (digests.deck !== bundle.reveal.deckDigest) {
    verificationFailure('deck_digest', 'deck payload differs from revealed deckDigest')
  }
  if (digests.path !== bundle.reveal.pathDigest) {
    verificationFailure('path_digest', 'path payload differs from revealed pathDigest')
  }
  if (digests.commitment !== bundle.commitment) {
    verificationFailure('commitment', 'revealed material does not reproduce the anchored commitment')
  }
  if (digests.resultProof !== bundle.result.proofDigest) {
    verificationFailure('result_proof', 'placements, locked values, or resolution changed')
  }
  const lockedEvents = bundle.events.filter(({ kind }) => kind.type === 'placement_locked')
  if (lockedEvents.length !== 1 || lockedEvents[0]?.kind.type !== 'placement_locked') {
    verificationFailure('locked_scores_digest', 'expected exactly one placement_locked event')
  }
  if (lockedEvents[0].kind.data.lockedScoresDigest !== digests.lockedScores) {
    verificationFailure('locked_scores_digest', 'locked scores differ from their signed event digest')
  }
  if (canonicalStringify(lockedEvents[0].kind.data.lockedScores)
    !== canonicalStringify(bundle.lockedScores)) {
    verificationFailure('locked_scores_payload', 'live locked scores differ from the replay')
  }
  const firstBattleFrame = bundle.events.find(({ kind }) => kind.type === 'battle_frame')
  if (
    lockedEvents[0].kind.data.battleStartsAtMs - lockedEvents[0].serverTimeMs
      !== RANKED_LOCK_PHASE_MS
    || firstBattleFrame?.kind.type !== 'battle_frame'
    || firstBattleFrame.kind.data.point.step !== 0
    || firstBattleFrame.serverTimeMs !== lockedEvents[0].kind.data.battleStartsAtMs
  ) {
    verificationFailure(
      'lock_phase_timeline',
      'battle frame zero must follow the signed placement lock by exactly 2,000ms',
    )
  }
  const createdEvents = bundle.events.filter(({ kind }) => kind.type === 'round_created')
  if (createdEvents.length !== 1 || createdEvents[0]?.kind.type !== 'round_created') {
    verificationFailure('experiment_event', 'expected one signed round_created treatment map')
  }
  if (canonicalStringify(createdEvents[0].kind.data.experimentAssignments)
    !== canonicalStringify(bundle.experimentAssignments)) {
    verificationFailure('experiment_event', 'signed treatments differ from replay metadata')
  }
  const deckVariant = bundle.experimentAssignments['deck-structure:v2']
  const expectedDeck = deckVariant === 'flat'
    ? 'balanced_tape'
    : deckVariant === 'compression-break'
      ? 'compression_break'
      : null
  if (expectedDeck !== null && bundle.deck.id !== expectedDeck) {
    verificationFailure('deck_treatment', 'Quick Run deck differs from its signed assignment')
  }
  if (bundle.experimentAssignments['escape:v2'] === 'absent') {
    const hasEscapeEvent = bundle.events.some(({ kind }) =>
      kind.type === 'escape_accepted' || kind.type === 'bot_escape_evaluated')
    if (
      bundle.escape !== null
      || bundle.botEscapeDecisions.length > 0
      || bundle.botEscapes.length > 0
      || hasEscapeEvent
    ) {
      verificationFailure('escape_treatment', 'absent treatment contains Escape behavior')
    }
  }
  if (bundle.events.length !== digests.events.length) {
    verificationFailure('event_digest', 'event digest count differs')
  }
  for (let index = 0; index < bundle.events.length; index += 1) {
    if (bundle.events[index]?.digest !== digests.events[index]) {
      verificationFailure('event_digest', `event ${index} digest differs`)
    }
  }
}

function assertResultSummary(bundle: ReplayBundle): void {
  const players = bundle.result.contenders.filter(({ contenderId }) => contenderId === 0)
  if (players.length !== 1) {
    verificationFailure('result_summary', 'result must contain exactly one player contender')
  }
  const player = players[0]
  if (
    player === undefined
    || player.outcome !== bundle.result.outcome
    || player.score !== bundle.result.score
    || player.rank !== bundle.result.rank
    || player.closestApproach !== bundle.result.closestApproach
  ) {
    verificationFailure('result_summary', 'top-level player result differs from contender zero')
  }
  const survivors = bundle.result.contenders.filter(({ outcome }) => outcome === 'survived').length
  if (survivors !== bundle.result.survivors) {
    verificationFailure('result_summary', 'survivor count differs from contender outcomes')
  }
}

async function requireRegeneration(
  adapter: RankedReplayRegenerationAdapter | null | undefined,
  bundle: ReplayBundle,
  anchor: ReplayAnchor,
): Promise<RankedRegenerationReport> {
  if (adapter === undefined || adapter === null) {
    return verificationUnavailable(
      'rust_wasm_regeneration',
      'the full Rust/WASM replay regeneration adapter is not installed',
    )
  }
  if (adapter.protocolVersion !== RANKED_PROTOCOL || adapter.id.trim().length === 0) {
    verificationUnavailable(
      'rust_wasm_regeneration',
      'the regeneration adapter does not identify ranked replay v2',
    )
  }
  let report: RankedRegenerationReport
  try {
    report = await adapter.verifyReplay(bundle, anchor)
  } catch (error) {
    return verificationUnavailable(
      'rust_wasm_regeneration',
      'the regeneration adapter could not execute',
      error,
    )
  }
  const reported = new Set(report.checks)
  const missing = REQUIRED_REGENERATION_CHECKS.filter((check) => !reported.has(check))
  if (missing.length > 0) {
    verificationUnavailable(
      'rust_wasm_regeneration',
      `adapter omitted required checks: ${missing.join(', ')}`,
    )
  }
  if (!report.valid) {
    verificationFailure(
      'rust_wasm_regeneration',
      report.reason?.trim() || 'full deterministic regeneration rejected the replay',
    )
  }
  return report
}

/**
 * Fail-closed ranked replay verifier.
 *
 * Browser-native checks cover exact Rust canonical/framed SHA-256 digests and
 * every Ed25519 event signature. Deterministic path, bots, scoring, Escape,
 * and lifecycle regeneration must be supplied by the Rust/WASM adapter.
 */
export async function verifyRankedReplay(
  bundleInput: ReplayBundle,
  options: RankedReplayVerifierOptions,
): Promise<RankedReplayVerificationReport> {
  const bundle = parseReplayBundle(bundleInput)
  requireAnchor(bundle, options.anchor)
  const subtle = options.subtle === undefined ? globalThis.crypto?.subtle : options.subtle
  if (subtle === undefined || subtle === null) {
    verificationUnavailable('webcrypto', 'SubtleCrypto is not available')
  }
  const digests = await computeRankedBrowserDigests(bundle, subtle)
  assertDigestLinks(bundle, digests)
  assertResultSummary(bundle)
  const eventDigests = await verifyEventLog(subtle, bundle, options.anchor.serverVerifyingKey)
  if (eventDigests.some((digest, index) => digest !== digests.events[index])) {
    verificationFailure('event_digest', 'event digest passes disagreed')
  }
  const regeneration = await requireRegeneration(options.regenerator, bundle, options.anchor)
  return {
    valid: true,
    protocolVersion: RANKED_PROTOCOL,
    browserChecks: Object.freeze([
      'external create-response anchors',
      'versioned treatment anchor and signed behavior',
      'canonical deck digest',
      'canonical path digest',
      'pre-round commitment',
      'framed locked-score digest',
      'signed 2,000ms lock-phase timeline',
      'canonical result proof digest',
      'player result summary cross-link',
      'framed event digest chain',
      'every Ed25519 event signature',
    ]),
    delegatedChecks: Object.freeze([...regeneration.checks]),
    regenerationVerifier: options.regenerator?.id ?? 'unavailable',
    digests,
  }
}
