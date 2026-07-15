import { beforeAll, describe, expect, it } from 'vitest'
import type { ReplayBundle } from './replay'
import { getDeck } from './decks'
import { botProfilesForPractice } from './bots'
import {
  buildReplayBundle,
  createRoundCommitment,
  deriveRoundSeedMaterial,
  digestBots,
  digestResult,
  regenerateReplay,
  resultSnapshot,
  verifyReplayBundle,
  verifyRoundCommitment,
} from './replay'

const deck = getDeck('compression-break')!
const salt = 'e8d7cb67f2a13147fbb95bc2c3b02e1aef9ab6bc6a7865b604401f7b45567fd9'

function copyBundle(bundle: ReplayBundle): ReplayBundle {
  return JSON.parse(JSON.stringify(bundle)) as ReplayBundle
}

describe('commit–reveal replay protocol', () => {
  let bundle: ReplayBundle
  let escapeBundle: ReplayBundle

  beforeAll(async () => {
    bundle = await buildReplayBundle({
      masterSeed: 'proof-fixture-001',
      deck,
      salt,
      battleSteps: 121,
      playerPlacements: [
        { at: 0, side: 'upper', distance: 8 },
        { at: 1_600, side: 'lower', distance: 6.5 },
        { at: 3_800, side: 'lower', distance: 4.25 },
        { at: 5_200, side: 'upper', distance: 7.1 },
      ],
    })
    escapeBundle = await buildReplayBundle({
      masterSeed: 'escape-proof-fixture',
      deck: getDeck('balanced-tape')!,
      salt,
      battleSteps: 121,
      playerPlacements: [
        { at: 0, side: 'upper', distance: 1_000_000 },
      ],
      playerEscape: { at: 32_000 },
    })
  })

  it('derives stable path and bot roots in separate cryptographic domains', async () => {
    const first = await deriveRoundSeedMaterial('master', 'round-a', salt)
    const second = await deriveRoundSeedMaterial('master', 'round-a', salt)
    expect(first).toEqual(second)
    expect(first.pathSeed).not.toBe(first.botSeed)
    expect(first.pathSeed).toMatch(/^[0-9a-f]{64}$/)
    expect((await deriveRoundSeedMaterial('master', 'round-b', salt)).pathSeed).not.toBe(
      first.pathSeed,
    )
  })

  it('creates a pre-round commitment that verifies only against its reveal', async () => {
    const commitment = await createRoundCommitment({
      roundId: bundle.roundId,
      engine: bundle.engine,
      deck: bundle.deck,
      path: bundle.path,
      botSeed: bundle.reveal.botSeed,
      botProfiles: bundle.botProfiles,
      salt: bundle.reveal.salt,
      escapeEnabled: bundle.recipe.escapeEnabled,
    })
    expect(commitment).toEqual(bundle.commitment)
    await expect(
      verifyRoundCommitment(commitment, {
        roundId: bundle.roundId,
        engine: bundle.engine,
        deck: bundle.deck,
        path: bundle.path,
        botSeed: bundle.reveal.botSeed,
        botProfiles: bundle.botProfiles,
        salt: bundle.reveal.salt,
        escapeEnabled: bundle.recipe.escapeEnabled,
      }),
    ).resolves.toEqual({ valid: true, errors: [] })

    const wrongSalt = await verifyRoundCommitment(commitment, {
      roundId: bundle.roundId,
      engine: bundle.engine,
      deck: bundle.deck,
      path: bundle.path,
      botSeed: bundle.reveal.botSeed,
      botProfiles: bundle.botProfiles,
      salt: `${bundle.reveal.salt}00`,
      escapeEnabled: bundle.recipe.escapeEnabled,
    })
    expect(wrongSalt.valid).toBe(false)
    expect(wrongSalt.errors).toContain('commitment:value')
  })

  it('survives a JSON round trip and regenerates every result exactly', async () => {
    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain('hitFrameExact')
    expect(serialized).not.toContain('closestApproachStep')
    expect(serialized).not.toContain('closestApproachFixed')
    expect(serialized).toContain('fixedScore')
    const decoded = JSON.parse(serialized) as ReplayBundle
    const verification = await verifyReplayBundle(decoded, bundle.commitment.value)
    expect(verification.valid).toBe(true)
    expect(verification.rankable).toBe(false)
    expect(decoded.protocolVersion).toBe('strikefall/replay/v4')
    expect(decoded.engine).toMatchObject({
      mode: 'wasm-solmath',
      rankable: true,
      pathSource: 'rust-wasm-bridge-extrema/v1',
    })
    expect(decoded.commitment).toMatchObject({
      engineMode: decoded.engine.mode,
      engineVersion: decoded.engine.engineVersion,
      engineDigest: decoded.engine.digest,
      engineRankable: true,
    })
    expect(verification.errors).toEqual([])
    expect(verification.regenerated?.result.summary).toEqual(bundle.result.summary)
    expect(verification.regenerated?.result.feed).toEqual(bundle.result.feed)
  })

  it('regenerates canonical bot decisions and the final digest', async () => {
    const replayed = regenerateReplay(bundle)
    expect(await digestBots(replayed.locked.contenders)).toBe(bundle.digests.bots)
    expect(await digestResult(resultSnapshot(replayed.result))).toBe(bundle.digests.result)
    expect(replayed.result.battlePath).toEqual(bundle.path.battlePath)
  })

  it('commits and regenerates the exact compact practice roster', async () => {
    const compact = await buildReplayBundle({
      masterSeed: 'compact-proof-fixture',
      deck,
      salt,
      battleSteps: 61,
      botProfiles: botProfilesForPractice(9),
      playerPlacements: [{ at: 4_000, side: 'upper', distance: 7 }],
    })
    expect(compact.botProfiles).toHaveLength(9)
    expect(compact.lockedContenders).toHaveLength(10)
    expect(compact.result.contenders).toHaveLength(10)
    const decoded = copyBundle(compact)
    const verification = await verifyReplayBundle(decoded, compact.commitment.value)
    expect(verification.valid).toBe(true)
    expect(verification.regenerated?.locked.contenders).toHaveLength(10)

    decoded.botProfiles.reverse()
    const changedRoster = await verifyReplayBundle(decoded, compact.commitment.value)
    expect(changedRoster.valid).toBe(false)
    expect(changedRoster.errors).toContain('bundle:bot-roster')
  })

  it('never lets a changed bot stream alter the hidden path', async () => {
    const changed = copyBundle(bundle)
    changed.reveal.botSeed = 'f'.repeat(64)
    const replayed = regenerateReplay(changed)
    expect(replayed.result.battlePath).toEqual(bundle.path.battlePath)
    expect(await digestBots(replayed.locked.contenders)).not.toBe(bundle.digests.bots)
  })

  it('detects a mutated deck', async () => {
    const changed = copyBundle(bundle)
    const variance = [...changed.deck.variance] as [number, number, number, number]
    variance[0] += 0.01
    changed.deck = { ...changed.deck, variance }
    const verification = await verifyReplayBundle(changed, bundle.commitment.value)
    expect(verification.valid).toBe(false)
    expect(verification.errors).toContain('digest:deck')
    expect(verification.errors).toContain('commitment:deck')
  })

  it('detects a mutated generated path', async () => {
    const changed = copyBundle(bundle)
    changed.path.battlePath[20] = (changed.path.battlePath[20] as number) + 0.0001
    const verification = await verifyReplayBundle(changed, bundle.commitment.value)
    expect(verification.valid).toBe(false)
    expect(verification.errors).toContain('digest:path')
    expect(verification.errors).toContain('commitment:path')
  })

  it('detects a mutated retained interval extremum', async () => {
    const changed = copyBundle(bundle)
    changed.path.battleExtrema[20]!.high += 0.0001
    const verification = await verifyReplayBundle(changed, bundle.commitment.value)
    expect(verification.valid).toBe(false)
    expect(verification.errors).toContain('digest:path')
    expect(verification.errors).toContain('commitment:path')
  })

  it('detects scorer substitution independently of the committed path', async () => {
    const changed = copyBundle(bundle)
    changed.engine.engineVersion = 'substituted-engine'
    const verification = await verifyReplayBundle(changed, bundle.commitment.value)
    expect(verification.valid).toBe(false)
    expect(verification.rankable).toBe(false)
    expect(verification.errors).toContain('bundle:engine')
    expect(verification.errors).toContain('digest:engine')

    const changedCommitment = copyBundle(bundle)
    changedCommitment.commitment.engineMode = 'typescript-fallback'
    const commitmentVerification = await verifyReplayBundle(
      changedCommitment,
      bundle.commitment.value,
    )
    expect(commitmentVerification.errors).toContain('commitment:engine')
  })

  it('detects changed bot parameters and locked decisions', async () => {
    const changedProfile = copyBundle(bundle)
    changedProfile.botProfiles[0]!.hysteresis += 0.01
    const profileVerification = await verifyReplayBundle(
      changedProfile,
      bundle.commitment.value,
    )
    expect(profileVerification.errors).toContain('digest:bot-root')
    expect(profileVerification.errors).toContain('commitment:bot-root')

    const changedMove = copyBundle(bundle)
    const bot = changedMove.lockedContenders.find((contender) => !contender.isPlayer)!
    bot.distance += 0.25
    const moveVerification = await verifyReplayBundle(changedMove, bundle.commitment.value)
    expect(moveVerification.errors).toContain('digest:bots')
  })

  it('detects result and player-recipe mutations', async () => {
    const changedResult = copyBundle(bundle)
    changedResult.result.summary!.score += 1
    const resultVerification = await verifyReplayBundle(changedResult, bundle.commitment.value)
    expect(resultVerification.errors).toContain('digest:result')

    const changedRecipe = copyBundle(bundle)
    const finalPlacement = changedRecipe.recipe.playerPlacements.at(-1)!
    finalPlacement.side = finalPlacement.side === 'upper' ? 'lower' : 'upper'
    finalPlacement.distance = 2
    const recipeVerification = await verifyReplayBundle(changedRecipe, bundle.commitment.value)
    expect(recipeVerification.valid).toBe(false)
    expect(recipeVerification.errors).toContain('digest:recipe')
    expect(recipeVerification.errors).toContain('replay:result')
  })

  it('binds Practice difficulty into the exact replay recipe', async () => {
    const hard = await buildReplayBundle({
      masterSeed: 'hard-proof-fixture',
      deck,
      salt,
      battleSteps: 61,
      difficulty: 'hard',
      playerPlacements: [{ at: 4_000, side: 'upper', distance: 7 }],
    })
    expect(hard.recipe.difficulty).toBe('hard')
    await expect(verifyReplayBundle(hard, hard.commitment.value)).resolves.toMatchObject({
      valid: true,
      rankable: false,
      errors: [],
    })

    const changed = copyBundle(hard)
    changed.recipe.difficulty = 'easy'
    const verification = await verifyReplayBundle(changed, hard.commitment.value)
    expect(verification.valid).toBe(false)
    expect(verification.errors).toContain('digest:recipe')
    expect(verification.errors).toContain('replay:bots')
  }, 15_000)

  it('detects seed substitution and an unanchored commitment', async () => {
    const changedSeed = copyBundle(bundle)
    changedSeed.reveal.pathSeed = `0${changedSeed.reveal.pathSeed.slice(1)}`
    const seedVerification = await verifyReplayBundle(changedSeed, bundle.commitment.value)
    expect(seedVerification.valid).toBe(false)
    expect(seedVerification.errors).toContain('seed:path')
    expect(seedVerification.errors).toContain('replay:path')

    const externalVerification = await verifyReplayBundle(bundle, '0'.repeat(64))
    expect(externalVerification.valid).toBe(false)
    expect(externalVerification.errors).toContain('commitment:external-value')
  })

  it('rejects player events after the progressive input freeze', async () => {
    await expect(
      buildReplayBundle({
        masterSeed: 'late-event',
        deck,
        salt,
        playerPlacements: [{ at: 5_251, side: 'upper', distance: 5 }],
      }),
    ).rejects.toThrow(RangeError)
  })

  it('replays one ordered player Escape with the exact fixed banked score', async () => {
    expect(escapeBundle.recipe.playerEscape).toEqual({ at: 32_000, sequence: 1 })
    expect(escapeBundle.result.summary?.outcome).toBe('escaped')
    const player = escapeBundle.result.contenders.find((contender) => contender.isPlayer)!
    expect(player.outcome).toBe('escaped')
    expect(player.escape?.bankedScore).toBe(escapeBundle.result.summary?.score)
    expect(player.escape?.holdOutcome).not.toBe('pending')
    expect(escapeBundle.result.feed.map((event) => event.sequence)).toEqual(
      escapeBundle.result.feed.map((_, index) => index),
    )
    const verification = await verifyReplayBundle(
      JSON.parse(JSON.stringify(escapeBundle)) as ReplayBundle,
      escapeBundle.commitment.value,
    )
    expect(verification.valid).toBe(true)
  })

  it('detects mutated Escape commands, banked values, and ordered feed events', async () => {
    const changedCommand = copyBundle(escapeBundle)
    changedCommand.recipe.playerEscape!.at += 1_000
    const commandVerification = await verifyReplayBundle(
      changedCommand,
      escapeBundle.commitment.value,
    )
    expect(commandVerification.valid).toBe(false)
    expect(commandVerification.errors).toContain('digest:recipe')

    const changedBank = copyBundle(escapeBundle)
    const player = changedBank.result.contenders.find((contender) => contender.isPlayer)!
    player.escape!.bankedScore += 1
    const bankVerification = await verifyReplayBundle(
      changedBank,
      escapeBundle.commitment.value,
    )
    expect(bankVerification.errors).toContain('digest:result')

    const changedOrder = copyBundle(escapeBundle)
    const escapeEvent = changedOrder.result.feed.find((event) => event.type === 'escape')!
    escapeEvent.sequence += 1
    const orderVerification = await verifyReplayBundle(
      changedOrder,
      escapeBundle.commitment.value,
    )
    expect(orderVerification.errors).toContain('digest:result')
  })

  it('binds the Escape rule and persona policies into the pre-round commitment', async () => {
    const changedRule = copyBundle(escapeBundle)
    changedRule.commitment.escapeEnabled = false
    const ruleVerification = await verifyReplayBundle(
      changedRule,
      escapeBundle.commitment.value,
    )
    expect(ruleVerification.valid).toBe(false)
    expect(ruleVerification.errors).toContain('commitment:escape-rule')

    const changedPolicy = copyBundle(escapeBundle)
    changedPolicy.botProfiles[0]!.escapePolicy.quoteThreshold += 0.01
    const policyVerification = await verifyReplayBundle(
      changedPolicy,
      escapeBundle.commitment.value,
    )
    expect(policyVerification.valid).toBe(false)
    expect(policyVerification.errors).toContain('digest:bot-root')
    expect(policyVerification.errors).toContain('commitment:bot-root')
  })
})
