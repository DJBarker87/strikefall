import {
  legalDistanceBounds,
  lockPlacements,
  playBattleToEnd,
  prepareLiveRound,
  startPlacement,
  updateBotsForPlacement,
  updatePlayerPlacement,
} from '../../src/game/index.ts'

for (let value = 1; value <= 200; value += 1) {
  const seed = [value, value + 1, value + 2]
    .map((part) => part.toString(36))
    .join('-')
  const initial = (await prepareLiveRound(seed, {
    escapeEnabled: true,
    salt: '11'.repeat(32),
  })).round
  for (const side of ['upper', 'lower'] as const) {
    const minimum = legalDistanceBounds(initial.lineValue, side).minimum
    const placed = updatePlayerPlacement(startPlacement(initial, 0), side, minimum)
    const jockeyed = updateBotsForPlacement(placed, 11_250)
    const result = playBattleToEnd(lockPlacements(jockeyed, 12_000))
    const player = result.contenders.find((contender) => contender.isPlayer)
    if (player?.outcome === 'hit') {
      console.log(JSON.stringify({
        value,
        seed,
        side,
        deck: result.deck.id,
        hitAt: player.hitAt,
        minimum,
        line: initial.lineValue,
        low: Math.min(...result.battlePath),
        high: Math.max(...result.battlePath),
      }))
      process.exit(0)
    }
  }
}

throw new Error('No deterministic elimination seed found')
