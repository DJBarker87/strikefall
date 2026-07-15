import { describe, expect, it } from 'vitest'
import { isRankedReplayId, parseRankedReplayId } from './id'
import { createRankedReplayShareUrl } from './shareUrl'

const ROUND_ID = '53af8a60-edc5-4fbc-a372-85fa1a0a7fdf'

describe('ranked replay share URLs', () => {
  it('keeps only the same-origin replay route and validated ID', () => {
    const url = createRankedReplayShareUrl(
      ROUND_ID,
      'https://player:secret@strikefall.gg/arena?token=bearer&seed=42#salt=private',
    )

    expect(url).toBe(`https://strikefall.gg/replay/${ROUND_ID}`)
    expect(url).not.toMatch(/token|seed|salt|secret|player/)
  })

  it.each([
    '',
    '../settings',
    '53AF8A60-EDC5-4FBC-A372-85FA1A0A7FDF',
    '53af8a60-edc5-1fbc-a372-85fa1a0a7fdf',
    '53af8a60-edc5-4fbc-7372-85fa1a0a7fdf',
    `${ROUND_ID}?seed=42`,
  ])('rejects a malformed or non-v4 replay ID: %s', (value) => {
    expect(isRankedReplayId(value)).toBe(false)
    expect(() => parseRankedReplayId(value)).toThrow('canonical lower-case UUID v4')
    expect(() => createRankedReplayShareUrl(value, 'https://strikefall.gg')).toThrow()
  })

  it('rejects non-web origins', () => {
    expect(() => createRankedReplayShareUrl(ROUND_ID, 'file:///tmp/index.html?token=x'))
      .toThrow('HTTP or HTTPS')
  })
})
