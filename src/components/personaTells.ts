import type { Contender, GamePhase } from '../game/types'

export interface PersonaTellContext {
  animationTimeMs: number
  mutedFlash: boolean
  phase: GamePhase
  phaseDuration: number
  reducedMotion: boolean
  timeRemaining: number
}

export interface PersonaTellState {
  chaosOffset: Readonly<{ x: number; y: number }>
  chaosTicks: boolean
  greedlordFlash: boolean
  greedlordTaunt: string | null
  lateBidSeconds: number | null
  mimicEcho: boolean
}

const EMPTY_TELL: PersonaTellState = {
  chaosOffset: { x: 0, y: 0 },
  chaosTicks: false,
  greedlordFlash: false,
  greedlordTaunt: null,
  lateBidSeconds: null,
  mimicEcho: false,
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function hashUnit(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4_294_967_295
}

function placementElapsed(context: PersonaTellContext): number {
  return clamp(context.phaseDuration - context.timeRemaining, 0, context.phaseDuration)
}

function recentCompletedMoveAge(
  contender: Contender,
  context: PersonaTellContext,
): number | null {
  if (context.phase !== 'placement') return null
  const elapsed = placementElapsed(context)
  const latest = contender.moves
    .filter((move) => move.completed && move.at <= elapsed)
    .reduce<number | null>((mostRecent, move) => (
      mostRecent === null || move.at > mostRecent ? move.at : mostRecent
    ), null)
  return latest === null ? null : elapsed - latest
}

/** Pure persona presentation state; it never changes placement or scoring inputs. */
export function derivePersonaTell(
  contender: Contender,
  context: PersonaTellContext,
): PersonaTellState {
  if (contender.isPlayer || contender.outcome !== 'active') return EMPTY_TELL
  const animationAllowed = !context.reducedMotion && !context.mutedFlash

  if (contender.persona === 'Greedlord') {
    const moveAge = recentCompletedMoveAge(contender, context)
    const taunting = moveAge !== null && moveAge <= 1_500
    return {
      ...EMPTY_TELL,
      greedlordFlash: taunting
        && animationAllowed
        && Math.floor(context.animationTimeMs / 120) % 2 === 0,
      greedlordTaunt: taunting ? 'TOP THIS' : null,
    }
  }

  if (contender.persona === 'Late Bidder' && context.phase === 'placement') {
    const elapsed = placementElapsed(context)
    const nextMove = contender.moves.find((move) => !move.completed && move.at >= elapsed)
    const untilMove = nextMove ? nextMove.at - elapsed : Number.POSITIVE_INFINITY
    return {
      ...EMPTY_TELL,
      lateBidSeconds: untilMove <= 5_000
        ? Math.max(1, Math.ceil(untilMove / 1_000))
        : null,
    }
  }

  if (contender.persona === 'Mimic') {
    return { ...EMPTY_TELL, mimicEcho: true }
  }

  if (contender.persona === 'Chaos') {
    if (!animationAllowed) return { ...EMPTY_TELL, chaosTicks: true }
    const identityPhase = hashUnit(contender.id) * Math.PI * 2
    const tick = Math.floor(context.animationTimeMs / 82)
    return {
      ...EMPTY_TELL,
      chaosOffset: {
        x: Math.sin(tick * 2.17 + identityPhase) * 2.8,
        y: Math.cos(tick * 1.43 + identityPhase) * 1.8,
      },
      chaosTicks: true,
    }
  }

  return EMPTY_TELL
}
