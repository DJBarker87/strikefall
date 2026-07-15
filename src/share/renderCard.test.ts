import { describe, expect, it, vi } from 'vitest'
import { createShareArtifact } from './artifact'
import { createShareCardLayout, isRectInsideCard, shareCardDimensions } from './layout'
import { exportShareCard, renderShareCard } from './renderCard'
import type { ShareCanvasSurface } from './renderCard'
import type { ShareCardFormat, ShareRoundInput } from './types'

function cardData() {
  const round: ShareRoundInput = {
    deck: {
      id: 'balanced',
      version: 2,
      monitoringConvention: 'strikefall/brownian-bridge-extrema/v1',
      name: 'Balanced Tape',
      kicker: 'Steady pressure',
      description: 'Even variance.',
      tacticalHint: 'Read both sides.',
      variance: [25, 25, 25, 25],
      hue: 145,
      tempo: 1,
    },
    phase: 'result',
    lineValue: 100,
    battlePath: [100, 101, 99, 102, 100.4],
    contenders: [
      {
        id: 'player',
        name: 'YOU',
        persona: 'Player',
        isPlayer: true,
        side: 'upper',
        distance: 3,
        barrier: 103,
        risk: 5.4,
        crowd: 1.1,
        potential: 900,
        color: '#fff',
        outcome: 'survived',
        hitAt: null,
        closestApproach: 0.2,
        escape: null,
        moves: [],
      },
    ],
    feed: [],
    summary: {
      outcome: 'survived',
      score: 900,
      rank: 1,
      survived: 2,
      escaped: 1,
      closestApproach: 0.2,
      multiplier: 5.4,
      crowd: 1.1,
      headline: 'GREED FLAG. ICE-COLD HOLD.',
      escape: null,
    },
  }
  return createShareArtifact(round).card
}

function fakeSurface(text: string[]): ShareCanvasSurface {
  const gradient = { addColorStop: vi.fn() }
  const target: Record<PropertyKey, unknown> = {
    measureText: (value: string) => ({ width: value.length * 18 }),
    fillText: (value: string) => text.push(value),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  }
  const context = new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property]
      return () => undefined
    },
    set(object, property, value) {
      object[property] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (callback) => callback(new Blob(['png'], { type: 'image/png' })),
  }
}

describe('share-card layouts', () => {
  const formats: ShareCardFormat[] = ['portrait-9x16', 'square-1x1', 'landscape-16x9']

  it.each(formats)('keeps every region inside %s', (format) => {
    const layout = createShareCardLayout(format)
    for (const rect of [layout.header, layout.hero, layout.chart, layout.stats, layout.footer]) {
      expect(isRectInsideCard(rect, layout)).toBe(true)
    }
  })

  it('ships exact 9:16, 1:1, and 16:9 export dimensions', () => {
    expect(shareCardDimensions('portrait-9x16')).toEqual([1080, 1920])
    expect(shareCardDimensions('square-1x1')).toEqual([1080, 1080])
    expect(shareCardDimensions('landscape-16x9')).toEqual([1920, 1080])
  })
})

describe('procedural share-card export', () => {
  it('draws and exports without external image assets', async () => {
    const text: string[] = []
    const surface = fakeSurface(text)
    const environment = { createCanvas: () => surface }
    const data = { ...cardData(), botCount: 19 }
    const rendered = renderShareCard(data, { format: 'square-1x1', environment })
    expect(rendered.status).toBe('ready')
    expect(text).toContain('STRIKEFALL')
    expect(text.join(' ')).toContain('MAX RISK')
    expect(text.join(' ')).toContain('19 BOTS')

    const exported = await exportShareCard(data, { format: 'square-1x1', environment })
    expect(exported.status).toBe('ready')
    if (exported.status === 'ready') expect(exported.blob.type).toBe('image/png')
  })

  it('returns capability fallbacks instead of throwing', async () => {
    const environment = { createCanvas: () => ({ width: 0, height: 0, getContext: () => null }) }
    expect(renderShareCard(cardData(), { environment })).toMatchObject({ status: 'unsupported' })
    await expect(exportShareCard(cardData(), { environment })).resolves.toMatchObject({ status: 'unsupported' })
  })
})
