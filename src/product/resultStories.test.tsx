import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResultStoryStrip } from '../components/ResultStoryStrip'
import type { Contender, FeedEvent, RoundSummary } from '../game'
import { deriveResultStories } from './resultStories'

function contender(update: Partial<Contender> = {}): Contender {
  return {
    id: 'player',
    name: 'YOU',
    persona: 'Player',
    isPlayer: true,
    side: 'upper',
    distance: 8,
    barrier: 108,
    risk: 4.2,
    crowd: 1.16,
    potential: 487,
    color: '#fff',
    outcome: 'survived',
    hitAt: null,
    closestApproach: 0.42,
    escape: null,
    moves: [],
    ...update,
  }
}

function summary(update: Partial<RoundSummary> = {}): RoundSummary {
  return {
    outcome: 'survived',
    score: 487,
    rank: 1,
    survived: 3,
    escaped: 2,
    closestApproach: 0.42,
    multiplier: 4.2,
    crowd: 1.16,
    headline: 'UNTOUCHED.',
    escape: null,
    ...update,
  }
}

function event(update: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: 'cluster-1',
    sequence: 4,
    type: 'cluster',
    title: 'CLUSTER WIPE ×3',
    detail: 'Three flags fell.',
    contenderIds: ['bot-near', 'bot-far', 'bot-third'],
    at: 0.4,
    ...update,
  }
}

describe('result story derivation', () => {
  it('reports the held risk, nearest named rival, and largest actual cluster', () => {
    const player = contender()
    const mimic = contender({
      id: 'bot-near',
      name: 'Echo.exe',
      persona: 'Mimic',
      isPlayer: false,
      barrier: 107.9,
      outcome: 'hit',
      hitAt: 0.4,
    })
    const far = contender({
      id: 'bot-far',
      name: 'Turtle.exe',
      persona: 'Turtle',
      isPlayer: false,
      barrier: 120,
      potential: 200,
    })
    const third = contender({
      id: 'bot-third',
      name: 'Glitch.exe',
      persona: 'Chaos',
      isPlayer: false,
      barrier: 90,
      outcome: 'hit',
      hitAt: 0.4,
    })
    const stories = deriveResultStories({
      contenders: [player, mimic, far, third],
      feed: [
        event({ id: 'small', sequence: 3, contenderIds: ['bot-near', 'bot-far', 'bot-third'] }),
        event({ id: 'large', sequence: 8, contenderIds: ['bot-near', 'bot-far', 'bot-third', 'extra'] }),
      ],
      summary: summary(),
    }, [player, far, mimic, third])

    expect(stories?.skill).toMatchObject({
      title: 'Held a 4.20× flag',
      detail: '1.16× crowd · line stopped 0.42 away.',
    })
    expect(stories?.rival).toMatchObject({
      title: 'Echo.exe shadowed your line',
    })
    expect(stories?.rival.detail).toContain('Mimic BOT')
    expect(stories?.lobby).toMatchObject({
      title: '4 flags fell together',
      detail: expect.stringContaining('Largest strike at 24s'),
    })
  })

  it('uses a shared cluster as the rival story and reports only signed feed facts', () => {
    const player = contender({ outcome: 'hit', hitAt: 0.75, closestApproach: 0 })
    const rival = contender({
      id: 'bot-rival',
      name: 'Needle',
      persona: 'Sniper',
      isPlayer: false,
      barrier: 107.8,
      outcome: 'hit',
      hitAt: 0.75,
    })
    const stories = deriveResultStories({
      contenders: [player, rival],
      feed: [event({ contenderIds: ['player', 'bot-rival', 'bot-other'], at: 0.75 })],
      summary: summary({
        outcome: 'eliminated',
        score: 0,
        rank: 8,
        closestApproach: 0,
      }),
    }, [rival, player])

    expect(stories?.skill.title).toBe('Struck at 45s')
    expect(stories?.rival).toEqual({
      kind: 'rival',
      label: 'Rival',
      title: 'Needle fell beside you',
      detail: 'Sniper BOT · same 3-flag strike at 45s.',
    })
  })

  it('reports an Escape timing and an honest no-cluster lobby', () => {
    const escape = {
      frame: 126,
      at: 0.525,
      survivalProbability: 0.64,
      terminalScore: 500,
      bankedScore: 320,
      holdOutcome: 'would-survive' as const,
      holdHitAt: null,
    }
    const player = contender({ outcome: 'escaped', escape })
    const bot = contender({
      id: 'bot-one',
      name: 'Shell',
      persona: 'Turtle',
      isPlayer: false,
      barrier: 112,
    })
    const stories = deriveResultStories({
      contenders: [player, bot],
      feed: [],
      summary: summary({
        outcome: 'escaped',
        score: 320,
        escaped: 1,
        escape,
      }),
    }, [bot, player])

    expect(stories?.skill).toMatchObject({
      title: 'Banked 320 at 32s',
      detail: '64.0% live survival · 4.20× risk above.',
    })
    expect(stories?.lobby).toMatchObject({
      title: 'No cluster wipe this run',
      detail: '0 struck · 3 held · 1 escaped.',
    })
  })

  it('does not invent stories before a settled result', () => {
    const player = contender()
    expect(deriveResultStories({ contenders: [player], feed: [], summary: null }, [player])).toBeNull()
  })

  it('renders all three compact stories with semantic labels', () => {
    const player = contender()
    const bot = contender({
      id: 'bot-one',
      name: 'Shell',
      persona: 'Turtle',
      isPlayer: false,
      barrier: 112,
    })
    const stories = deriveResultStories({
      contenders: [player, bot],
      feed: [],
      summary: summary(),
    }, [player, bot])!
    const html = renderToStaticMarkup(<ResultStoryStrip stories={stories} />)
    expect(html).toContain('aria-label="Round stories"')
    expect(html).toContain('Your read')
    expect(html).toContain('Rival')
    expect(html).toContain('Lobby')
    expect(html.match(/<article/g)).toHaveLength(3)
  })
})
