import { describe, expect, it, vi } from 'vitest'
import { createShareArtifact } from './artifact'
import { renderShareClipFrame } from './renderClipFrame'
import type { ShareRoundInput } from './types'

function artifact() {
  const round: ShareRoundInput = {
    deck: {
      id: 'pulse',
      version: 2,
      monitoringConvention: 'strikefall/brownian-bridge-extrema/v1',
      name: 'Pulse',
      kicker: 'Double pressure',
      description: 'Alternating bursts.',
      tacticalHint: 'Pick the quiet lane.',
      variance: [15, 35, 15, 35],
      hue: 315,
      tempo: 1,
    },
    phase: 'result',
    lineValue: 100,
    battlePath: [100, 102, 99, 100.2],
    contenders: [
      {
        id: 'player', name: 'YOU', persona: 'Player', isPlayer: true,
        side: 'upper', distance: 2, barrier: 102, risk: 4.25, crowd: 1,
        potential: 850, color: '#fff', outcome: 'survived', hitAt: null,
        closestApproach: 0.1, escape: null, moves: [],
      },
      ...Array.from({ length: 19 }, (_, index) => ({
        id: `bot-${index}`, name: `Bot ${index}`, persona: 'Chaos' as const,
        isPlayer: false, side: 'lower' as const, distance: 2, barrier: 98,
        risk: 2, crowd: 1, potential: 400, color: '#aaa', outcome: 'hit' as const,
        hitAt: 0.6, closestApproach: 0, escape: null, moves: [],
      })),
    ],
    feed: [],
    summary: {
      outcome: 'survived', score: 850, rank: 1, survived: 1, escaped: 0,
      closestApproach: 0.1, multiplier: 4.25, crowd: 1,
      headline: 'GREED FLAG. ICE-COLD HOLD.', escape: null,
    },
  }
  return createShareArtifact(round).card
}

function fakeContext(text: string[], drawImage: ReturnType<typeof vi.fn>) {
  const gradient = { addColorStop: vi.fn() }
  const target: Record<PropertyKey, unknown> = {
    measureText: (value: string) => ({ width: value.length * 12 }),
    fillText: (value: string) => text.push(value),
    drawImage,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  }
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property]
      return () => undefined
    },
    set(object, property, value) {
      object[property] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

describe('branded clip frame renderer', () => {
  it.each(['portrait-9x16', 'square-1x1', 'landscape-16x9'] as const)(
    'composites the arena and every required public fact into %s',
    (format) => {
      const text: string[] = []
      const drawImage = vi.fn()
      const layout = renderShareClipFrame(
        fakeContext(text, drawImage),
        { width: 1280, height: 720 },
        artifact(),
        format,
      )
      const copy = text.join(' ')
      expect(drawImage).toHaveBeenCalledOnce()
      expect(copy).toContain('STRIKEFALL')
      expect(copy).toContain('PULSE')
      expect(copy).toContain('4.25×')
      expect(copy).toContain('19 BOTS')
      expect(copy).toContain('SURVIVED')
      expect(copy).toContain('MOMENT ·')
      expect(layout.format).toBe(format)
    },
  )
})
