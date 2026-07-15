import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_WEEKLY_PROGRESS,
  weeklyChallengeFor,
  weeklyChallengeProgress,
} from './weeklyChallenge'
import { WeeklyChallengeCard, WeeklyChallengeLaunch } from './WeeklyChallengeCard'

const NOW = new Date('2026-07-15T12:00:00Z')

describe('weekly challenge surfaces', () => {
  it('renders the named bot, persona, exact rule, version, and fresh ordinary-round policy', () => {
    const challenge = weeklyChallengeFor(NOW)
    const html = renderToStaticMarkup(
      <WeeklyChallengeCard
        challenge={challenge}
        progress={weeklyChallengeProgress(EMPTY_WEEKLY_PROGRESS, challenge)}
        onPlay={vi.fn()}
      />,
    )
    expect(html).toContain('Weekly rivalry')
    expect(html).toContain(challenge.rival.name)
    expect(html).toContain(challenge.rival.persona)
    expect(html).toContain(challenge.mission.rule)
    expect(html).toContain(`${challenge.deck.name} v${challenge.deckVersion}`)
    expect(html).toContain('Ordinary lobby, featured deck, fresh unseen line every attempt')
    expect(html).toContain('data-path-policy="fresh-per-attempt"')
    expect(html).toContain('data-launch-policy="ordinary-round"')
    expect(html).toContain('Challenge rival')
  })

  it('provides a compact keyboard-native launch button with an explicit accessible name', () => {
    const challenge = weeklyChallengeFor(NOW)
    const html = renderToStaticMarkup(
      <WeeklyChallengeLaunch
        challenge={challenge}
        progress={weeklyChallengeProgress(EMPTY_WEEKLY_PROGRESS, challenge)}
        onPlay={vi.fn()}
      />,
    )
    expect(html).toContain('<button')
    expect(html).toContain('weekly-launch')
    expect(html).toContain(`aria-label="Play weekly rivalry against ${challenge.rival.name} on ${challenge.deck.name}"`)
    expect(html).toContain('Weekly bot rivalry')
  })

  it('exposes busy and disabled launch state without removing mission context', () => {
    const challenge = weeklyChallengeFor(NOW)
    const html = renderToStaticMarkup(
      <WeeklyChallengeLaunch
        challenge={challenge}
        progress={weeklyChallengeProgress(EMPTY_WEEKLY_PROGRESS, challenge)}
        onPlay={vi.fn()}
        starting
        disabled
      />,
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Seeding…')
    expect(html).toContain(challenge.mission.rule)
  })
})
