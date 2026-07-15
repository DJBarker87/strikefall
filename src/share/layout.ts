import type { ShareCardFormat } from './types'

export interface ShareRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ShareCardLayout {
  format: ShareCardFormat
  width: number
  height: number
  padding: number
  mode: 'stacked' | 'split'
  header: ShareRect
  hero: ShareRect
  chart: ShareRect
  stats: ShareRect
  footer: ShareRect
}

const DIMENSIONS: Readonly<Record<ShareCardFormat, readonly [number, number]>> = {
  'portrait-9x16': [1080, 1920],
  'square-1x1': [1080, 1080],
  'landscape-16x9': [1920, 1080],
}

export function shareCardDimensions(format: ShareCardFormat): readonly [number, number] {
  return DIMENSIONS[format]
}

export function createShareCardLayout(format: ShareCardFormat): ShareCardLayout {
  const [width, height] = DIMENSIONS[format]
  if (format === 'portrait-9x16') {
    return {
      format,
      width,
      height,
      padding: 72,
      mode: 'stacked',
      header: { x: 72, y: 68, width: 936, height: 124 },
      hero: { x: 72, y: 236, width: 936, height: 430 },
      chart: { x: 72, y: 714, width: 936, height: 650 },
      stats: { x: 72, y: 1412, width: 936, height: 280 },
      footer: { x: 72, y: 1740, width: 936, height: 112 },
    }
  }
  if (format === 'square-1x1') {
    return {
      format,
      width,
      height,
      padding: 56,
      mode: 'stacked',
      header: { x: 56, y: 42, width: 968, height: 86 },
      hero: { x: 56, y: 154, width: 968, height: 238 },
      chart: { x: 56, y: 430, width: 968, height: 296 },
      stats: { x: 56, y: 758, width: 968, height: 176 },
      footer: { x: 56, y: 964, width: 968, height: 70 },
    }
  }
  return {
    format,
    width,
    height,
    padding: 72,
    mode: 'split',
    header: { x: 72, y: 52, width: 1776, height: 92 },
    hero: { x: 72, y: 190, width: 720, height: 610 },
    chart: { x: 846, y: 190, width: 1002, height: 540 },
    stats: { x: 846, y: 762, width: 1002, height: 176 },
    footer: { x: 72, y: 966, width: 1776, height: 62 },
  }
}

export function isRectInsideCard(rect: ShareRect, layout: ShareCardLayout): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= layout.width && rect.y + rect.height <= layout.height
}
