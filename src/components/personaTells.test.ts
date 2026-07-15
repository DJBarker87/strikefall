import { describe, expect, it } from 'vitest'
import type { Contender, Persona } from '../game/types'
import { derivePersonaTell, type PersonaTellContext } from './personaTells'

function contender(persona: Persona, moves: Contender['moves'] = []): Contender {
  return {
    id: persona.toLowerCase().replace(' ', '-'),
    name: persona,
    persona,
    isPlayer: false,
    side: 'upper',
    distance: 1,
    barrier: 101,
    risk: 2,
    crowd: 1,
    potential: 200,
    color: '#fff',
    outcome: 'active',
    hitAt: null,
    closestApproach: 1,
    escape: null,
    moves,
  }
}

const context: PersonaTellContext = {
  animationTimeMs: 240,
  mutedFlash: false,
  phase: 'placement',
  phaseDuration: 15_000,
  reducedMotion: false,
  timeRemaining: 6_000,
}

describe('persona tells', () => {
  it('gives Greedlord a brief text taunt and flash after a public move', () => {
    const greedlord = contender('Greedlord', [{ at: 8_000, completed: true }])
    const tell = derivePersonaTell(greedlord, context)
    expect(tell.greedlordTaunt).toBe('TOP THIS')
    expect(tell.greedlordFlash).toBe(true)

    expect(derivePersonaTell(greedlord, { ...context, reducedMotion: true })).toMatchObject({
      greedlordFlash: false,
      greedlordTaunt: 'TOP THIS',
    })
    expect(derivePersonaTell(greedlord, { ...context, mutedFlash: true }).greedlordFlash).toBe(false)
    expect(derivePersonaTell(greedlord, { ...context, timeRemaining: 4_000 }).greedlordTaunt).toBeNull()
  })

  it('shows Late Bidder countdown only inside the five-second move window', () => {
    const late = contender('Late Bidder', [{ at: 12_500, completed: false }])
    expect(derivePersonaTell(late, context).lateBidSeconds).toBe(4)
    expect(derivePersonaTell(late, { ...context, timeRemaining: 9_000 }).lateBidSeconds).toBeNull()
  })

  it('keeps Mimic echo and a static Chaos identifier when motion is reduced', () => {
    expect(derivePersonaTell(contender('Mimic'), context).mimicEcho).toBe(true)
    const moving = derivePersonaTell(contender('Chaos'), context)
    expect(moving.chaosTicks).toBe(true)
    expect(Math.abs(moving.chaosOffset.x) + Math.abs(moving.chaosOffset.y)).toBeGreaterThan(0)
    expect(derivePersonaTell(contender('Chaos'), { ...context, reducedMotion: true })).toMatchObject({
      chaosOffset: { x: 0, y: 0 },
      chaosTicks: true,
    })
    expect(derivePersonaTell(contender('Chaos'), { ...context, mutedFlash: true }).chaosOffset).toEqual({
      x: 0,
      y: 0,
    })
  })

  it('does not decorate players, eliminated flags, or unrelated personas', () => {
    expect(derivePersonaTell({ ...contender('Sniper'), isPlayer: true }, context)).toMatchObject({
      greedlordFlash: false,
      greedlordTaunt: null,
      lateBidSeconds: null,
      mimicEcho: false,
    })
    expect(derivePersonaTell({ ...contender('Chaos'), outcome: 'hit' }, context).chaosTicks).toBe(false)
    expect(derivePersonaTell(contender('Turtle'), context).mimicEcho).toBe(false)
  })
})
