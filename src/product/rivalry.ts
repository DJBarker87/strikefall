import type { Contender, FeedEvent, RoundState } from '../game/types'
import type { ProfileRoundResult, RivalRecord } from './profile'

export type RoundRivalRelation =
  | 'shared-wipe'
  | 'copied-player'
  | 'rank-neighbour'
  | 'nearest-placement'

type RivalryRound = Pick<RoundState, 'contenders' | 'feed' | 'summary'>
export type RivalContender = Contender & {
  isPlayer: false
  persona: Exclude<Contender['persona'], 'Player'>
}

export interface RelevantRoundRival {
  /** Internal game object. Share boundaries must use createRivalryShareContext instead. */
  contender: RivalContender
  relation: RoundRivalRelation
  playerWon: boolean
  playerRank: number
  rivalRank: number
  eventAt: number | null
  sharedWipeSize: number | null
  copiedPlayer: boolean
}

/** Sanitized history accepted by share APIs. It deliberately has no bot ID or round data. */
export interface RivalryShareContext {
  rivalName: string
  rivalPersona: Exclude<Contender['persona'], 'Player'>
  playerWins: number
  playerLosses: number
  copyEncounters: number
}

function score(contender: Contender): number {
  if (contender.outcome === 'survived') return contender.potential
  if (contender.outcome === 'escaped') return contender.escape?.bankedScore ?? 0
  return 0
}

function rankOrder(contenders: readonly Contender[]): Contender[] {
  const outcomePriority: Readonly<Record<Contender['outcome'], number>> = {
    survived: 3,
    escaped: 2,
    active: 1,
    hit: 0,
  }
  return [...contenders].sort((left, right) => (
    score(right) - score(left)
    || outcomePriority[right.outcome] - outcomePriority[left.outcome]
    || (right.hitAt ?? 1) - (left.hitAt ?? 1)
    || right.potential - left.potential
    || left.id.localeCompare(right.id)
  ))
}

function validStandings(
  contenders: readonly Contender[],
  standings: readonly Contender[] | undefined,
): Contender[] {
  if (!standings || standings.length !== contenders.length) return rankOrder(contenders)
  const expected = new Set(contenders.map(({ id }) => id))
  if (standings.some(({ id }) => !expected.delete(id)) || expected.size > 0) {
    return rankOrder(contenders)
  }
  return [...standings]
}

function barrierGap(player: Contender, rival: Contender): number {
  return Math.abs(rival.barrier - player.barrier)
}

function rankAt(contender: Contender, standings: readonly Contender[]): number {
  const index = standings.findIndex(({ id }) => id === contender.id)
  return index < 0 ? standings.length + 1 : index + 1
}

function rivalResult(
  contender: RivalContender,
  relation: RoundRivalRelation,
  player: Contender,
  standings: readonly Contender[],
  eventAt: number | null = null,
  sharedWipeSize: number | null = null,
): RelevantRoundRival {
  const playerRank = rankAt(player, standings)
  const rivalRank = rankAt(contender, standings)
  return {
    contender,
    relation,
    playerWon: playerRank < rivalRank,
    playerRank,
    rivalRank,
    eventAt,
    sharedWipeSize,
    copiedPlayer: relation === 'copied-player',
  }
}

interface SharedWipe {
  event: FeedEvent
  bots: RivalContender[]
}

function sharedWipes(
  round: RivalryRound,
  player: Contender,
  bots: readonly RivalContender[],
): SharedWipe[] {
  return round.feed
    .filter((event) => event.type === 'cluster' && event.contenderIds.includes(player.id))
    .map((event) => ({
      event,
      bots: bots.filter((bot) => event.contenderIds.includes(bot.id)),
    }))
    .filter(({ bots: members }) => members.length > 0)
    .sort((left, right) => (
      new Set(right.event.contenderIds).size - new Set(left.event.contenderIds).size
      || right.event.sequence - left.event.sequence
      || right.event.at - left.event.at
      || left.event.id.localeCompare(right.event.id)
    ))
}

function nearestByPlacement(
  player: Contender,
  bots: readonly RivalContender[],
  standings: readonly Contender[],
): RivalContender | null {
  const playerRank = rankAt(player, standings)
  return [...bots].sort((left, right) => (
    barrierGap(player, left) - barrierGap(player, right)
    || Math.abs(rankAt(left, standings) - playerRank) - Math.abs(rankAt(right, standings) - playerRank)
    || left.id.localeCompare(right.id)
  ))[0] ?? null
}

/**
 * Picks the one current-round rival worth remembering. Priority is a shared
 * wipe, then a Mimic encounter, then nearest final rank (with placement as the
 * tie-break), or nearest placement before a settled result.
 */
export function selectRelevantRoundRival(
  round: RivalryRound,
  suppliedStandings?: readonly Contender[],
): RelevantRoundRival | null {
  const player = round.contenders.find((contender) => contender.isPlayer)
  const bots = round.contenders.filter((contender): contender is RivalContender => (
    !contender.isPlayer && contender.persona !== 'Player'
  ))
  if (!player || bots.length === 0) return null

  const standings = validStandings(round.contenders, suppliedStandings)
  const wipe = sharedWipes(round, player, bots)[0]
  if (wipe) {
    const rival = nearestByPlacement(player, wipe.bots, standings)
    if (rival) {
      return rivalResult(
        rival,
        'shared-wipe',
        player,
        standings,
        wipe.event.at,
        new Set(wipe.event.contenderIds).size,
      )
    }
  }

  const mimic = nearestByPlacement(
    player,
    bots.filter((contender) => contender.persona === 'Mimic'),
    standings,
  )
  if (mimic) return rivalResult(mimic, 'copied-player', player, standings)

  if (round.summary) {
    const playerRank = rankAt(player, standings)
    const neighbour = [...bots].sort((left, right) => (
      Math.abs(rankAt(left, standings) - playerRank) - Math.abs(rankAt(right, standings) - playerRank)
      || barrierGap(player, left) - barrierGap(player, right)
      || Math.abs(score(left) - score(player)) - Math.abs(score(right) - score(player))
      || left.id.localeCompare(right.id)
    ))[0]
    if (neighbour) return rivalResult(neighbour, 'rank-neighbour', player, standings)
  }

  const nearest = nearestByPlacement(player, bots, standings)
  return nearest ? rivalResult(nearest, 'nearest-placement', player, standings) : null
}

/** Converts an internal rival selection plus stored history into share-safe copy facts. */
export function createRivalryShareContext(
  records: readonly RivalRecord[],
  selection: RelevantRoundRival | null,
): RivalryShareContext | null {
  if (!selection) return null
  const record = records.find(({ botId }) => botId === selection.contender.id)
  if (!record) return null
  return {
    // The canonical current-round display name is used; stored names and IDs never cross the boundary.
    rivalName: selection.contender.name,
    rivalPersona: selection.contender.persona,
    playerWins: Math.max(0, Math.round(record.wins)),
    playerLosses: Math.max(0, Math.round(record.losses)),
    copyEncounters: Math.max(0, Math.round(record.copyEncounters)),
  }
}

/** Internal profile payload for the selected rival; never pass this object to share APIs. */
export function createProfileRoundRival(
  selection: RelevantRoundRival | null,
): NonNullable<ProfileRoundResult['rival']> | undefined {
  if (!selection) return undefined
  return {
    botId: selection.contender.id,
    botName: selection.contender.name,
    playerWon: selection.playerWon,
    copiedPlayer: selection.copiedPlayer,
  }
}
