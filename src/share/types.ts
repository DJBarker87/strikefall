import type { Persona, RoundState } from '../game/types'
import type { RivalryShareContext } from '../product/rivalry'
export type { RivalryShareContext } from '../product/rivalry'

export type DramaticMomentKind =
  | 'near-miss'
  | 'cluster-wipe'
  | 'greed-hold'
  | 'escape-regret'
  | 'escape-save'
  | 'perfect-escape'
  | 'bot-rivalry'

export type DramaticMomentAccent = 'primary' | 'strike' | 'danger' | 'success' | 'violet'

interface DramaticMomentBase {
  kind: DramaticMomentKind
  /** Deterministic 0–100 editorial priority. */
  impact: number
  kicker: string
  title: string
  detail: string
  accent: DramaticMomentAccent
  /** Normalized battle progress when the moment occurred, otherwise null. */
  at: number | null
}

export interface NearMissMoment extends DramaticMomentBase {
  kind: 'near-miss'
  outcome: 'held' | 'late-hit'
  closestApproach: number
  /** Authoritative discrete battle step, when live/replay path data provides it. */
  closestApproachStep: number | null
  marginPercent: number
}

export interface ClusterWipeMoment extends DramaticMomentBase {
  kind: 'cluster-wipe'
  size: number
  playerInvolved: boolean
  sequence: number
}

export interface GreedHoldMoment extends DramaticMomentBase {
  kind: 'greed-hold'
  risk: number
  score: number
  rank: number
}

export interface EscapeRegretMoment extends DramaticMomentBase {
  kind: 'escape-regret'
  bankedScore: number
  scoreLeftBehind: number
  escapeProbability: number
}

export interface PerfectEscapeMoment extends DramaticMomentBase {
  kind: 'perfect-escape'
  bankedScore: number
  strikeDelayProgress: number
  strikeDelaySeconds: number
  escapeProbability: number
}

export interface EscapeSaveMoment extends DramaticMomentBase {
  kind: 'escape-save'
  bankedScore: number
  strikeDelayProgress: number
  strikeDelaySeconds: number
  escapeProbability: number
}

export interface BotRivalryMoment extends DramaticMomentBase {
  kind: 'bot-rivalry'
  rivalName: string
  rivalPersona: Persona
  relation: 'fell-together' | 'copied-player' | 'rank-duel' | 'nearest-placement'
  /** Aggregate public series copy. Raw bot IDs are deliberately absent. */
  seriesCopy: string | null
  copyEncounters: number
}

export type DramaticMoment =
  | NearMissMoment
  | ClusterWipeMoment
  | GreedHoldMoment
  | EscapeRegretMoment
  | EscapeSaveMoment
  | PerfectEscapeMoment
  | BotRivalryMoment

export type ShareCardFormat = 'portrait-9x16' | 'square-1x1' | 'landscape-16x9'

export type ShareClipFormat = ShareCardFormat

export interface NormalizedShareChart {
  points: readonly number[]
  flag: number
  final: number
  side: 'upper' | 'lower'
}

export interface ShareCardStat {
  label: string
  value: string
}

/** Deliberately excludes seeds, round IDs, proof internals, and raw feed details. */
export interface ShareCardData {
  brand: 'STRIKEFALL'
  deckName: string
  deckKicker: string
  deckHue: number
  /** Public round fact used by cards and branded clips. */
  botCount: number
  /** Public locked/final multiplier. Never derived from proof or seed data. */
  multiplier: number
  outcome: 'survived' | 'escaped' | 'eliminated' | 'in-progress'
  headline: string
  kicker: string
  detail: string
  accent: DramaticMomentAccent
  stats: readonly [ShareCardStat, ShareCardStat, ShareCardStat, ShareCardStat]
  chart: NormalizedShareChart
  momentKind: DramaticMomentKind | 'round-result'
}

export interface ShareArtifact {
  card: ShareCardData
  moment: DramaticMoment | null
}

export interface CreateShareArtifactOptions {
  /** `null` deliberately suppresses automatic dramatic-moment selection. */
  selectedMoment?: DramaticMoment | null
  rivalry?: RivalryShareContext | null
}

export type ShareRoundInput = Pick<
  RoundState,
  'deck' | 'phase' | 'lineValue' | 'battlePath' | 'contenders' | 'feed' | 'summary'
>
