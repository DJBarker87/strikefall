import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { botProfilesForPractice, buildReplayBundle, getDeck, type ReplayBundle } from '../game'
import {
  LocalReplayViewer,
  deriveLocalReplayFrame,
  localReplayTimeline,
} from './LocalReplayViewer'

const salt = '22e6040b981b83e46aa7ec768581d041a13068dd22349cbcc03e56e63cd1841c'
let replay: ReplayBundle

beforeAll(async () => {
  replay = await buildReplayBundle({
    masterSeed: 'local-replay-viewer',
    deck: getDeck('pulse')!,
    salt,
    battleSteps: 61,
    botProfiles: botProfilesForPractice(9),
    playerPlacements: [{ at: 5_000, side: 'upper', distance: 6 }],
  })
})

describe('local replay viewer', () => {
  it('derives deterministic flag states at the start and finish', () => {
    const opening = deriveLocalReplayFrame(replay, 0)
    const finish = deriveLocalReplayFrame(replay, 1)
    expect(opening.frameIndex).toBe(0)
    expect(opening.active).toBe(10)
    expect(opening.struck).toBe(0)
    expect(finish.frameIndex).toBe(60)
    expect(finish.active).toBe(0)
    expect(finish.struck + finish.escaped + finish.survived).toBe(10)
    expect(deriveLocalReplayFrame(replay, 2).progress).toBe(1)
  })

  it('exposes only proof-bearing result events as jump targets', () => {
    const timeline = localReplayTimeline(replay)
    expect(timeline.length).toBeGreaterThan(0)
    expect(timeline.at(-1)?.type).toBe('survivor')
    expect(timeline.every((event) => (
      ['hit', 'cluster', 'escape', 'survivor'].includes(event.type)
    ))).toBe(true)
    expect(timeline.map((event) => event.at)).toEqual(
      [...timeline.map((event) => event.at)].sort((left, right) => left - right),
    )
  })

  it('renders play, scrub, restart, close, roster, and timeline controls', () => {
    const html = renderToStaticMarkup(
      <LocalReplayViewer replay={replay} onClose={vi.fn()} />,
    )
    expect(html).toContain('aria-label="Local round replay"')
    expect(html).toContain('Replay the strike')
    expect(html).toContain(`${replay.deck.name} · deck v${replay.deck.version}`)
    expect(html).toContain('9 bots')
    expect(html).toContain('Play replay')
    expect(html).toContain('aria-label="Replay timeline"')
    expect(html).toContain('aria-label="Restart replay"')
    expect(html).toContain('aria-label="Close local replay"')
    expect(html).toContain('Flag board')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Replay flag board; scroll for all contenders"')
    expect(html).toContain('Turtle · BOT')
    expect(html).toContain('Strike timeline')
    expect(html).toContain(replay.commitment.value.slice(0, 12))
  })
})
