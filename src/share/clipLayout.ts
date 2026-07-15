import type { ShareRect } from './layout'
import type { ShareClipFormat } from './types'

export interface ShareClipLayout {
  format: ShareClipFormat
  width: number
  height: number
  padding: number
  header: ShareRect
  arena: ShareRect
  story: ShareRect
  facts: ShareRect
  footer: ShareRect
}

const CLIP_DIMENSIONS: Readonly<Record<ShareClipFormat, readonly [number, number]>> = {
  'portrait-9x16': [720, 1280],
  'square-1x1': [720, 720],
  'landscape-16x9': [1280, 720],
}

export function shareClipDimensions(format: ShareClipFormat): readonly [number, number] {
  return CLIP_DIMENSIONS[format]
}

export function createShareClipLayout(format: ShareClipFormat): ShareClipLayout {
  const [width, height] = shareClipDimensions(format)
  if (format === 'portrait-9x16') {
    return {
      format,
      width,
      height,
      padding: 36,
      header: { x: 36, y: 30, width: 648, height: 72 },
      arena: { x: 36, y: 132, width: 648, height: 500 },
      story: { x: 36, y: 670, width: 648, height: 284 },
      facts: { x: 36, y: 984, width: 648, height: 138 },
      footer: { x: 36, y: 1160, width: 648, height: 72 },
    }
  }
  if (format === 'landscape-16x9') {
    return {
      format,
      width,
      height,
      padding: 32,
      header: { x: 32, y: 20, width: 1216, height: 54 },
      arena: { x: 32, y: 92, width: 784, height: 500 },
      story: { x: 840, y: 92, width: 408, height: 250 },
      facts: { x: 840, y: 360, width: 408, height: 232 },
      footer: { x: 32, y: 640, width: 1216, height: 48 },
    }
  }
  return {
    format,
    width,
    height,
    padding: 30,
    header: { x: 30, y: 22, width: 660, height: 58 },
    arena: { x: 30, y: 98, width: 660, height: 344 },
    story: { x: 30, y: 466, width: 416, height: 154 },
    facts: { x: 464, y: 466, width: 226, height: 154 },
    footer: { x: 30, y: 644, width: 660, height: 48 },
  }
}

export function isClipRectInside(rect: ShareRect, layout: ShareClipLayout): boolean {
  return rect.x >= 0
    && rect.y >= 0
    && rect.x + rect.width <= layout.width
    && rect.y + rect.height <= layout.height
}
