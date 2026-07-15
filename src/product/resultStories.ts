import type { Contender, FeedEvent, RoundState } from '../game'
import { selectRelevantRoundRival } from './rivalry'

export type ResultStoryKind = 'skill' | 'rival' | 'lobby'

export interface ResultStory {
  kind: ResultStoryKind
  label: string
  title: string
  detail: string
}

export interface ResultStories {
  skill: ResultStory
  rival: ResultStory
  lobby: ResultStory
}

type ResultRound = Pick<RoundState, 'contenders' | 'feed' | 'summary'>

function seconds(progress: number | null) {
  return `${Math.round(Math.max(0, Math.min(1, progress ?? 0)) * 60)}s`
}

function rankOf(contender: Contender, standings: readonly Contender[]) {
  const rank = standings.findIndex((entry) => entry.id === contender.id)
  return rank < 0 ? null : rank + 1
}

function largestCluster(feed: readonly FeedEvent[]) {
  return feed
    .filter((event) => event.type === 'cluster')
    .map((event) => ({
      event,
      size: new Set(event.contenderIds).size,
    }))
    .sort((left, right) => (
      right.size - left.size
      || left.event.sequence - right.event.sequence
      || left.event.id.localeCompare(right.event.id)
    ))[0] ?? null
}

function skillStory(player: Contender, round: ResultRound): ResultStory {
  const summary = round.summary!
  const position = player.side === 'upper' ? 'above' : 'below'
  if (summary.outcome === 'escaped' && summary.escape) {
    return {
      kind: 'skill',
      label: 'Your read',
      title: `Banked ${summary.score} at ${seconds(summary.escape.at)}`,
      detail: `${(summary.escape.survivalProbability * 100).toFixed(1)}% live survival · ${summary.multiplier.toFixed(2)}× risk ${position}.`,
    }
  }
  if (summary.outcome === 'survived') {
    return {
      kind: 'skill',
      label: 'Your read',
      title: `Held a ${summary.multiplier.toFixed(2)}× flag`,
      detail: `${summary.crowd.toFixed(2)}× crowd · line stopped ${summary.closestApproach.toFixed(2)} away.`,
    }
  }
  return {
    kind: 'skill',
    label: 'Your read',
    title: `Struck at ${seconds(player.hitAt)}`,
    detail: `${summary.multiplier.toFixed(2)}× risk ${position} · ${summary.crowd.toFixed(2)}× crowd at lock.`,
  }
}

function rivalStory(
  player: Contender,
  round: ResultRound,
  standings: readonly Contender[],
): ResultStory {
  const selected = selectRelevantRoundRival(round, standings)
  if (!selected) {
    return {
      kind: 'rival',
      label: 'Rival',
      title: 'No bot rival recorded',
      detail: 'The verified result contained no disclosed bot placement.',
    }
  }
  const rival = selected.contender
  if (selected.relation === 'shared-wipe') {
    return {
      kind: 'rival',
      label: 'Rival',
      title: `${rival.name} fell beside you`,
      detail: `${rival.persona} BOT · same ${selected.sharedWipeSize ?? 2}-flag strike at ${seconds(selected.eventAt)}.`,
    }
  }
  const playerRank = selected.playerRank ?? rankOf(player, standings)
  const rivalRank = selected.rivalRank ?? rankOf(rival, standings)
  const result = playerRank && rivalRank
    ? playerRank < rivalRank
      ? `you finished #${playerRank}, ahead of #${rivalRank}`
      : rivalRank < playerRank
        ? `finished #${rivalRank}, ahead of your #${playerRank}`
        : `matched your #${playerRank} finish`
    : 'final rank unavailable'
  return {
    kind: 'rival',
    label: 'Rival',
    title: selected.relation === 'copied-player'
      ? `${rival.name} shadowed your line`
      : selected.relation === 'rank-neighbour'
        ? `${rival.name} challenged your rank`
        : `${rival.name} planted nearest`,
    detail: `${rival.persona} BOT · ${result}.`,
  }
}

function lobbyStory(round: ResultRound): ResultStory {
  const summary = round.summary!
  const cluster = largestCluster(round.feed)
  const struck = round.contenders.filter((contender) => contender.outcome === 'hit').length
  if (cluster && cluster.size >= 3) {
    return {
      kind: 'lobby',
      label: 'Lobby',
      title: `${cluster.size} flags fell together`,
      detail: `Largest strike at ${seconds(cluster.event.at)} · ${struck} total struck.`,
    }
  }
  return {
    kind: 'lobby',
    label: 'Lobby',
    title: 'No cluster wipe this run',
    detail: `${struck} struck · ${summary.survived} held · ${summary.escaped} escaped.`,
  }
}

/** Derives only from settled contender, feed, summary, and standings facts. */
export function deriveResultStories(
  round: ResultRound,
  standings: readonly Contender[],
): ResultStories | null {
  if (!round.summary) return null
  const player = round.contenders.find((contender) => contender.isPlayer)
  if (!player) return null
  return {
    skill: skillStory(player, round),
    rival: rivalStory(player, round, standings),
    lobby: lobbyStory(round),
  }
}
