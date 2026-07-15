import type { Contender } from '../game/types'
import { selectPrimaryDramaticMoment } from './moments'
import type {
  DramaticMoment,
  CreateShareArtifactOptions,
  NormalizedShareChart,
  ShareArtifact,
  ShareCardData,
  ShareCardStat,
  ShareRoundInput,
} from './types'

const MAX_CHART_POINTS = 180

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function compactNumber(value: number): string {
  const rounded = Math.round(Math.max(0, value))
  return new Intl.NumberFormat('en-US', {
    notation: rounded >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: rounded >= 10_000 ? 1 : 0,
  }).format(rounded)
}

function sample(values: readonly number[], maximum: number): number[] {
  if (values.length <= maximum) return [...values]
  return Array.from({ length: maximum }, (_, index) => {
    const sourceIndex = Math.round(index / (maximum - 1) * (values.length - 1))
    return values[sourceIndex] ?? values[values.length - 1] ?? 0
  })
}

function normalizedChart(round: ShareRoundInput, player: Contender | undefined): NormalizedShareChart {
  const source = sample(round.battlePath.length > 1 ? round.battlePath : [round.lineValue, round.lineValue], MAX_CHART_POINTS)
  const flagValue = player?.barrier ?? round.lineValue
  const minimum = Math.min(flagValue, ...source)
  const maximum = Math.max(flagValue, ...source)
  const padding = Math.max(0.0001, (maximum - minimum) * 0.08)
  const low = minimum - padding
  const high = maximum + padding
  const normalize = (value: number) => clamp((value - low) / Math.max(Number.EPSILON, high - low), 0, 1)
  return {
    points: source.map(normalize),
    flag: normalize(flagValue),
    final: normalize(source[source.length - 1] ?? round.lineValue),
    side: player?.side ?? 'upper',
  }
}

function fallbackCopy(round: ShareRoundInput): Pick<ShareCardData, 'headline' | 'kicker' | 'detail' | 'accent'> {
  const summary = round.summary
  if (!summary) {
    return {
      kicker: 'LIVE STORM',
      headline: 'ONE FLAG. ONE LINE.',
      detail: 'The result is still moving.',
      accent: 'primary',
    }
  }
  return {
    kicker: summary.outcome === 'survived' ? 'FLAG HELD' : summary.outcome === 'escaped' ? 'SCORE BANKED' : 'FLAG DOWN',
    headline: summary.headline,
    detail: `${compactNumber(summary.score)} points · rank ${summary.rank}`,
    accent: summary.outcome === 'survived' ? 'success' : summary.outcome === 'escaped' ? 'primary' : 'danger',
  }
}

function stats(round: ShareRoundInput, player: Contender | undefined): ShareCardData['stats'] {
  const summary = round.summary
  const values: [ShareCardStat, ShareCardStat, ShareCardStat, ShareCardStat] = [
    { label: 'RANK', value: summary ? `#${summary.rank}` : 'LIVE' },
    { label: 'SCORE', value: summary ? compactNumber(summary.score) : '—' },
    { label: 'RISK', value: `${(summary?.multiplier ?? player?.risk ?? 1).toFixed(1)}×` },
    {
      label: 'FIELD',
      value: summary ? `${summary.survived} HELD` : `${round.contenders.length} FLAGS`,
    },
  ]
  return values
}

/** Builds a stable public artifact. Raw seeds, IDs, proof state, and feed copy never cross this boundary. */
export function createShareArtifact(
  round: ShareRoundInput,
  options: CreateShareArtifactOptions | DramaticMoment | null = {},
): ShareArtifact {
  const normalizedOptions: CreateShareArtifactOptions = options === null || 'kind' in options
    ? { selectedMoment: options }
    : options
  const selectedMoment = normalizedOptions.selectedMoment === undefined
    ? selectPrimaryDramaticMoment(round, normalizedOptions.rivalry)
    : normalizedOptions.selectedMoment
  const player = round.contenders.find((contender) => contender.isPlayer)
  const fallback = fallbackCopy(round)
  const copy = selectedMoment
    ? {
        kicker: selectedMoment.kicker,
        headline: selectedMoment.title,
        detail: selectedMoment.detail,
        accent: selectedMoment.accent,
      }
    : fallback
  return {
    moment: selectedMoment,
    card: {
      brand: 'STRIKEFALL',
      deckName: round.deck.name,
      deckKicker: round.deck.kicker,
      deckHue: clamp(round.deck.hue, 0, 360),
      botCount: round.contenders.filter((contender) => !contender.isPlayer).length,
      multiplier: round.summary?.multiplier ?? player?.risk ?? 1,
      outcome: round.summary?.outcome ?? 'in-progress',
      ...copy,
      stats: stats(round, player),
      chart: normalizedChart(round, player),
      momentKind: selectedMoment?.kind ?? 'round-result',
    },
  }
}

export function shareCaption(data: ShareCardData): string {
  return `${data.headline} ${data.stats[1].value} points in Strikefall.`
}

export function shareFilename(data: ShareCardData, extension: 'png' | 'webm' | 'mp4' = 'png'): string {
  const deck = data.deckName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `strikefall-${deck || 'result'}.${extension}`
}
