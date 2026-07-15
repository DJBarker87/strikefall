import { describe, expect, it } from 'vitest'
import { createShareClipLayout, isClipRectInside, shareClipDimensions } from './clipLayout'
import type { ShareClipFormat } from './types'

describe('device-formatted clip layouts', () => {
  const formats: ShareClipFormat[] = ['portrait-9x16', 'square-1x1', 'landscape-16x9']

  it.each(formats)('keeps every public overlay region inside %s', (format) => {
    const layout = createShareClipLayout(format)
    for (const rect of [layout.header, layout.arena, layout.story, layout.facts, layout.footer]) {
      expect(isClipRectInside(rect, layout)).toBe(true)
    }
  })

  it('ships efficient, exact 9:16, 1:1, and 16:9 recording surfaces', () => {
    expect(shareClipDimensions('portrait-9x16')).toEqual([720, 1280])
    expect(shareClipDimensions('square-1x1')).toEqual([720, 720])
    expect(shareClipDimensions('landscape-16x9')).toEqual([1280, 720])
  })
})
