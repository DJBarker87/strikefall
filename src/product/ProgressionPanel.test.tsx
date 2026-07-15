import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createAnonymousProfile, recordProfileRound } from './profile'
import {
  DailyChallengeCard,
  DailyChallengeLaunch,
  DeckMasteryPanel,
  ProgressionPanel,
} from './ProgressionPanel'
import {
  challengeProgress,
  dailyChallengeFor,
  deriveDeckMastery,
  recordDailyChallengeRound,
  EMPTY_DAILY_PROGRESS,
} from './progression'

const NOW = new Date('2026-07-15T12:00:00Z')

function profileWithPulseMastery() {
  const profile = createAnonymousProfile({
    now: NOW,
    entropy: Uint8Array.from([0, 1, 2, 3, 4, 5]),
  })
  return recordProfileRound(profile, {
    deckId: 'pulse',
    outcome: 'survived',
    score: 520,
    multiplier: 5.2,
  }, NOW)
}

describe('progression surfaces', () => {
  it('renders an actionable fresh-path Daily Deck state', () => {
    const challenge = dailyChallengeFor(NOW)
    const html = renderToStaticMarkup(
      <DailyChallengeCard
        challenge={challenge}
        progress={challengeProgress(EMPTY_DAILY_PROGRESS, challenge)}
        onPlay={vi.fn()}
      />,
    )

    expect(html).toContain('Daily Deck')
    expect(html).toContain(challenge.deck.name)
    expect(html).toContain(challenge.mission.title)
    expect(html).toContain('new unseen line on every attempt')
    expect(html).toContain('Play Daily')
    expect(html).toContain('<button')
  })

  it('renders a compact keyboard-native Daily launcher for the home screen', () => {
    const challenge = dailyChallengeFor(NOW)
    const html = renderToStaticMarkup(
      <DailyChallengeLaunch
        challenge={challenge}
        progress={challengeProgress(EMPTY_DAILY_PROGRESS, challenge)}
        onPlay={vi.fn()}
      />,
    )
    expect(html).toContain('daily-launch')
    expect(html).toContain('<button')
    expect(html).toContain('Today’s Daily Deck')
    expect(html).toContain('fresh unseen path')
  })

  it('disables the Daily action when its selected network mode is not ready', () => {
    const challenge = dailyChallengeFor(NOW)
    const html = renderToStaticMarkup(
      <DailyChallengeLaunch
        challenge={challenge}
        progress={challengeProgress(EMPTY_DAILY_PROGRESS, challenge)}
        onPlay={vi.fn()}
        disabled
      />,
    )
    expect(html).toContain('disabled=""')
  })

  it('renders completed mission feedback without hiding replayability', () => {
    let now = NOW
    while (dailyChallengeFor(now).mission.id !== 'high-risk-hold') {
      now = new Date(now.getTime() + 86_400_000)
    }
    const challenge = dailyChallengeFor(now)
    const state = recordDailyChallengeRound(EMPTY_DAILY_PROGRESS, {
      deckId: challenge.deck.id,
      dailyChallengeId: challenge.id,
      outcome: 'survived',
      score: 500,
      multiplier: 5,
    }, now)
    const html = renderToStaticMarkup(
      <DailyChallengeCard
        challenge={challenge}
        progress={challengeProgress(state, challenge)}
        onPlay={vi.fn()}
      />,
    )

    expect(html).toContain('Cleared')
    expect(html).toContain('Mission cleared in 1 attempt')
    expect(html).toContain('Run again')
  })

  it('renders honest empty and unlocked mastery states for every deck', () => {
    const profile = profileWithPulseMastery()
    const mastery = deriveDeckMastery(profile)
    const html = renderToStaticMarkup(<DeckMasteryPanel mastery={mastery} />)

    expect(html).toContain('Deck mastery')
    expect(html).toContain('No purchase, boost, or tradable value')
    expect(html).toContain('No cosmetics yet')
    expect(html).toContain('Signal pennant')
    expect(html).toContain('Pressure trail')
    expect(html).toContain('Pulse')
    expect(html.match(/<progress/g)).toHaveLength(4)
  })

  it('composes Daily and mastery into one integration surface', () => {
    const profile = profileWithPulseMastery()
    const challenge = dailyChallengeFor(NOW)
    const html = renderToStaticMarkup(
      <ProgressionPanel
        challenge={challenge}
        progress={challengeProgress(EMPTY_DAILY_PROGRESS, challenge)}
        mastery={deriveDeckMastery(profile)}
      />,
    )
    expect(html).toContain('progression-panel')
    expect(html).toContain('Daily Deck')
    expect(html).toContain('Deck mastery')
  })
})
