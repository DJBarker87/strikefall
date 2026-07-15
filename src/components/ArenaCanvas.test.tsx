import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createHomeRound } from '../game'
import { ArenaCanvas } from './ArenaCanvas'

describe('ArenaCanvas mastery cosmetics', () => {
  it('clamps and exposes the cosmetic tier without changing round data', () => {
    const round = createHomeRound('mastery-cosmetic-test', { now: 0 })
    const before = JSON.stringify(round)
    const html = renderToStaticMarkup(
      <ArenaCanvas round={round} masteryLevel={99} reducedMotion />,
    )

    expect(html).toContain('data-mastery-level="4"')
    expect(html).toContain('Strikefall arena')
    expect(JSON.stringify(round)).toBe(before)
  })

  it('defaults a new deck to the unadorned tier', () => {
    const round = createHomeRound('mastery-default-test', { now: 0 })
    const html = renderToStaticMarkup(<ArenaCanvas round={round} reducedMotion />)

    expect(html).toContain('data-mastery-level="0"')
  })

  it('uses image semantics at rest and exposes a slider only during placement', () => {
    const home = createHomeRound('arena-semantics-test', { now: 0 })
    const staticHtml = renderToStaticMarkup(<ArenaCanvas round={home} reducedMotion />)

    expect(staticHtml).toContain('class="arena-canvas__viewport"')
    expect(staticHtml).toContain('role="img"')
    expect(staticHtml).not.toContain('role="slider"')
    expect(staticHtml).not.toContain('<button')

    const placement = { ...home, phase: 'placement' as const }
    const interactiveHtml = renderToStaticMarkup(
      <ArenaCanvas round={placement} onPlace={() => {}} reducedMotion />,
    )

    expect(interactiveHtml).toContain('<button')
    expect(interactiveHtml).toContain('role="slider"')
    expect(interactiveHtml).not.toContain('class="arena-canvas__viewport" role="img"')
  })
})
