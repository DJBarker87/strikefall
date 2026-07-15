import { describe, expect, it } from 'vitest'
import {
  CLUSTER_CASCADE_SPACING_MS,
  countdownAnnouncement,
  countdownCueSecond,
  createClusterHitCues,
} from './cues'

describe('battle audio cues', () => {
  it('builds one ordered hit per unique cluster contender at an 80 ms cadence', () => {
    expect(createClusterHitCues(['bot-4', 'player', 'bot-9', 'bot-4'])).toEqual([
      {
        clusterIndex: 0,
        clusterSize: 3,
        contenderId: 'bot-4',
        delayMs: 0,
        player: false,
      },
      {
        clusterIndex: 1,
        clusterSize: 3,
        contenderId: 'player',
        delayMs: CLUSTER_CASCADE_SPACING_MS,
        player: true,
      },
      {
        clusterIndex: 2,
        clusterSize: 3,
        contenderId: 'bot-9',
        delayMs: CLUSTER_CASCADE_SPACING_MS * 2,
        player: false,
      },
    ])
  })

  it('keeps custom cluster spacing inside the 60–100 ms readability window', () => {
    expect(createClusterHitCues(['a', 'b'], 12).map((cue) => cue.delayMs)).toEqual([0, 60])
    expect(createClusterHitCues(['a', 'b'], 180).map((cue) => cue.delayMs)).toEqual([0, 100])
  })

  it('covers every final battle second while preserving the short setup count', () => {
    expect(Array.from({ length: 10 }, (_, index) => (
      countdownCueSecond('battle', (10 - index) * 1_000)
    ))).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    expect(countdownCueSecond('battle', 10_001)).toBeNull()
    expect(countdownCueSecond('placement', 3_000)).toBe(3)
    expect(countdownCueSecond('placement', 3_001)).toBeNull()
    expect(countdownCueSecond('result', 1_000)).toBeNull()
    expect(countdownCueSecond('battle', 0)).toBeNull()
  })

  it('announces only the accessible battle bookends to avoid screen-reader noise', () => {
    expect(countdownAnnouncement('battle', 10_000)).toBe('Final ten seconds.')
    expect(countdownAnnouncement('battle', 7_000)).toBe('')
    expect(countdownAnnouncement('battle', 3_000)).toBe('3 seconds remaining.')
    expect(countdownAnnouncement('battle', 1_000)).toBe('1 second remaining.')
    expect(countdownAnnouncement('placement', 3_000)).toBe('')
  })
})
