import { describe, expect, it } from 'vitest'
import { resolvePracticeRoundSettings } from './useStrikefallGame'

describe('Practice round controller settings', () => {
  it('keeps active lobby size and difficulty across an implicit rematch', () => {
    expect(
      resolvePracticeRoundSettings(true, { botCount: 9, difficulty: 'hard' }),
    ).toEqual({ botCount: 9, difficulty: 'hard' })
  })

  it('resets an unconfigured fresh run to the full normal field', () => {
    expect(
      resolvePracticeRoundSettings(false, { botCount: 9, difficulty: 'hard' }),
    ).toEqual({ botCount: 19, difficulty: 'normal' })
  })

  it('uses explicit fresh-run and rematch overrides without coupling the settings', () => {
    expect(
      resolvePracticeRoundSettings(
        false,
        { botCount: 19, difficulty: 'normal' },
        9,
        'easy',
      ),
    ).toEqual({ botCount: 9, difficulty: 'easy' })
    expect(
      resolvePracticeRoundSettings(
        true,
        { botCount: 9, difficulty: 'hard' },
        19,
      ),
    ).toEqual({ botCount: 19, difficulty: 'hard' })
  })
})
