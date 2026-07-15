import { describe, expect, it } from 'vitest'
import type { PlayerPlacementEvent } from './replay'
import { getDeck } from './decks'
import {
  PHASE_DURATIONS,
  PLACEMENT_INPUT_FREEZE_MS,
  beginBattle,
  lockPlacements,
  playBattleToEnd,
  startPlacement,
  updateBotsForPlacement,
} from './round'
import {
  applyLivePlayerEscape,
  applyLivePlayerPlacement,
  finalizeLiveRoundProof,
  isCurrentProofSession,
  prepareLiveRound,
} from './liveProof'
import { verifyRoundCommitment } from './replay'

const salt = '34d8737e128b33af4f874eeb8dc3d49452df6371acd20ee2f3746c026263d6e0'

async function completedFixture() {
  const prepared = await prepareLiveRound('live-proof-fixture', {
    deck: getDeck('pulse'),
    salt,
    now: 500,
    battleSteps: 121,
  })
  let round = startPlacement(prepared.round, 0)
  const events: PlayerPlacementEvent[] = []
  const inputs = [
    { at: 300, side: 'upper' as const, distance: 7.5 },
    { at: 4_100, side: 'lower' as const, distance: 5.25 },
    { at: 8_800, side: 'upper' as const, distance: 3.75 },
    { at: 11_100, side: 'upper' as const, distance: 6.25 },
  ]
  for (const [sequence, input] of inputs.entries()) {
    const applied = applyLivePlayerPlacement(
      round,
      input.side,
      input.distance,
      input.at,
      sequence,
    )
    round = applied.round
    if (applied.event) events.push(applied.event)
  }
  round = updateBotsForPlacement(
    round,
    PHASE_DURATIONS.placement - PLACEMENT_INPUT_FREEZE_MS,
  )
  const result = playBattleToEnd(lockPlacements(round, PHASE_DURATIONS.placement))
  return { prepared, events, result }
}

describe('live browser proof helpers', () => {
  it('publishes only a deck-phase round whose path and bot root are already committed', async () => {
    const prepared = await prepareLiveRound('precommitted', { salt, now: 123 })
    expect(prepared.round.phase).toBe('deck')
    expect(prepared.round.phaseStartedAt).toBe(123)
    expect(prepared.round.pathSeed).not.toBe(prepared.round.botSeed)
    expect(prepared.proof.commitment.value).toMatch(/^[0-9a-f]{64}$/)
    const verification = await verifyRoundCommitment(prepared.proof.commitment, {
      roundId: prepared.proof.roundId,
      engine: prepared.proof.engine,
      deck: prepared.proof.deck,
      path: {
        approach: prepared.round.approach,
        battlePath: prepared.round.battlePath,
        battleExtrema: prepared.round.battleExtrema,
      },
      botSeed: prepared.proof.seeds.botSeed,
      botProfiles: (await import('./bots')).BOT_PROFILES,
      salt: prepared.proof.seeds.salt,
      escapeEnabled: prepared.proof.escapeEnabled,
    })
    expect(verification.valid).toBe(true)
  })

  it('binds a nine-bot practice lobby into the precommit and final proof', async () => {
    const prepared = await prepareLiveRound('compact-live-proof', {
      salt,
      botCount: 9,
      difficulty: 'hard',
      battleSteps: 61,
    })
    expect(prepared.round.contenders).toHaveLength(10)
    expect(prepared.proof.botProfiles).toHaveLength(9)
    expect(prepared.proof.difficulty).toBe('hard')
    const placement = updateBotsForPlacement(
      startPlacement(prepared.round, 0),
      PHASE_DURATIONS.placement - PLACEMENT_INPUT_FREEZE_MS,
      prepared.proof.difficulty,
    )
    const result = playBattleToEnd(lockPlacements(placement, PHASE_DURATIONS.placement))
    const finalized = await finalizeLiveRoundProof(prepared.proof, [], result)
    expect(finalized.verification.valid).toBe(true)
    expect(finalized.bundle.botProfiles).toHaveLength(9)
    expect(finalized.bundle.recipe.difficulty).toBe('hard')
    expect(finalized.bundle.commitment.value).toBe(prepared.proof.commitment.value)
  })

  it('records canonical placements and enforces the final input freeze', async () => {
    const prepared = await prepareLiveRound('placement-proof', { salt })
    const placement = startPlacement(prepared.round, 0)
    const accepted = applyLivePlayerPlacement(placement, 'lower', 5, 2_500, 0)
    expect(accepted.event).toMatchObject({ at: 2_500, sequence: 0, side: 'lower' })
    expect(accepted.round).not.toBe(placement)

    const frozen = applyLivePlayerPlacement(
      accepted.round,
      'upper',
      4,
      PHASE_DURATIONS.placement - PLACEMENT_INPUT_FREEZE_MS + 1,
      1,
    )
    expect(frozen.event).toBeNull()
    expect(frozen.round).toBe(accepted.round)
  })

  it('builds and verifies the actual completed browser result', async () => {
    const { prepared, events, result } = await completedFixture()
    const finalized = await finalizeLiveRoundProof(prepared.proof, events, result)
    expect(finalized.verification.valid).toBe(true)
    expect(finalized.verification.errors).toEqual([])
    expect(finalized.bundle.commitment.value).toBe(prepared.proof.commitment.value)
    expect(finalized.bundle.result.summary).toEqual(result.summary)
  })

  it('fails when the displayed live result was mutated after resolution', async () => {
    const { prepared, events, result } = await completedFixture()
    const changed = {
      ...result,
      summary: result.summary ? { ...result.summary, score: result.summary.score + 1 } : null,
    }
    const finalized = await finalizeLiveRoundProof(prepared.proof, events, changed)
    expect(finalized.verification.valid).toBe(false)
    expect(finalized.verification.errors).toContain('live:result')
  })

  it('rejects stale verification completions after a rematch generation', () => {
    const finishing = { generation: 4, roundId: 'round-old' }
    expect(isCurrentProofSession(finishing, finishing)).toBe(true)
    expect(
      isCurrentProofSession(finishing, { generation: 5, roundId: 'round-new' }),
    ).toBe(false)
    expect(
      isCurrentProofSession(finishing, { generation: 4, roundId: 'round-new' }),
    ).toBe(false)
    expect(isCurrentProofSession(finishing, null)).toBe(false)
  })

  it('captures one live Escape command and verifies its ordered replay', async () => {
    const prepared = await prepareLiveRound('escape-proof-fixture', {
      deck: getDeck('balanced-tape'),
      salt,
      battleSteps: 121,
    })
    let placement = startPlacement(prepared.round, 0)
    const moved = applyLivePlayerPlacement(
      placement,
      'upper',
      1_000_000,
      0,
      0,
    )
    placement = moved.round
    placement = updateBotsForPlacement(
      placement,
      PHASE_DURATIONS.placement - PLACEMENT_INPUT_FREEZE_MS,
    )
    const battle = beginBattle(
      lockPlacements(placement, PHASE_DURATIONS.placement),
      PHASE_DURATIONS.placement + PHASE_DURATIONS.lock,
    )
    const escaped = applyLivePlayerEscape(battle, 32_000, 1)
    expect(escaped.event).toEqual({ at: 32_000, sequence: 1 })
    expect(escaped.quote?.bankedScore).toBeGreaterThan(0)
    expect(
      escaped.round.contenders.find((contender) => contender.isPlayer)?.outcome,
    ).toBe('escaped')

    const duplicate = applyLivePlayerEscape(escaped.round, 33_000, 2)
    expect(duplicate.event).toBeNull()
    expect(duplicate.rejection).toBe('not-active')

    const result = playBattleToEnd(escaped.round)
    const finalized = await finalizeLiveRoundProof(
      prepared.proof,
      moved.event ? [moved.event] : [],
      result,
      escaped.event,
    )
    expect(finalized.verification.valid).toBe(true)
    expect(finalized.bundle.result.summary?.outcome).toBe('escaped')
  })
})
