import { createShareCardLayout } from './layout'
import type { ShareCardLayout, ShareRect } from './layout'
import type { DramaticMomentAccent, ShareCardData, ShareCardFormat } from './types'

export interface ShareCanvasSurface {
  width: number
  height: number
  getContext(contextId: '2d'): CanvasRenderingContext2D | null
  toBlob?: (callback: BlobCallback, type?: string, quality?: number) => void
  convertToBlob?: (options?: ImageEncodeOptions) => Promise<Blob>
}

export interface ShareCardRenderEnvironment {
  createCanvas(width: number, height: number): ShareCanvasSurface
}

export interface ShareCardRenderOptions {
  format?: ShareCardFormat
  environment?: ShareCardRenderEnvironment
}

export type ShareCardRenderResult =
  | {
      status: 'ready'
      canvas: ShareCanvasSurface
      layout: ShareCardLayout
    }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; error: Error }

export type ShareCardExportResult =
  | { status: 'ready'; blob: Blob; layout: ShareCardLayout }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; error: Error }

interface SharePalette {
  background: string
  backgroundDeep: string
  surface: string
  surfaceRaised: string
  line: string
  lineStrong: string
  ink: string
  inkSoft: string
  muted: string
  primary: string
  strike: string
  danger: string
  success: string
  violet: string
}

// Canvas exports cannot resolve application CSS variables once detached. These
// values intentionally mirror the central Strikefall tokens in styles.css.
const PALETTE: SharePalette = {
  background: '#06100e',
  backgroundDeep: '#030706',
  surface: '#0a1714',
  surfaceRaised: '#10221e',
  line: '#25423a',
  lineStrong: '#3d6559',
  ink: '#f1f7ee',
  inkSoft: '#c0d0c9',
  muted: '#8ba099',
  primary: '#c7f36b',
  strike: '#ff7447',
  danger: '#ff5f66',
  success: '#65e3aa',
  violet: '#ab8cff',
}

function defaultEnvironment(): ShareCardRenderEnvironment | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  return {
    createCanvas(width, height) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      return canvas
    },
  }
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function accentColor(accent: DramaticMomentAccent): string {
  return PALETTE[accent]
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const bounded = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + bounded, y)
  context.lineTo(x + width - bounded, y)
  context.quadraticCurveTo(x + width, y, x + width, y + bounded)
  context.lineTo(x + width, y + height - bounded)
  context.quadraticCurveTo(x + width, y + height, x + width - bounded, y + height)
  context.lineTo(x + bounded, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - bounded)
  context.lineTo(x, y + bounded)
  context.quadraticCurveTo(x, y, x + bounded, y)
  context.closePath()
}

function fillPanel(
  context: CanvasRenderingContext2D,
  rect: ShareRect,
  radius: number,
  fill = PALETTE.surface,
): void {
  roundedRect(context, rect.x, rect.y, rect.width, rect.height, radius)
  context.fillStyle = fill
  context.fill()
  context.strokeStyle = PALETTE.line
  context.lineWidth = 2
  context.stroke()
}

function wrapLines(
  context: CanvasRenderingContext2D,
  text: string,
  maximumWidth: number,
  maximumLines: number,
): string[] {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (context.measureText(candidate).width <= maximumWidth || !line) {
      line = candidate
      continue
    }
    lines.push(line)
    line = word
    if (lines.length === maximumLines - 1) break
  }
  if (line && lines.length < maximumLines) lines.push(line)
  const consumed = lines.join(' ').split(/\s+/).length
  if (consumed < words.length && lines.length > 0) {
    const last = lines.length - 1
    let truncated = lines[last] ?? ''
    while (truncated && context.measureText(`${truncated}…`).width > maximumWidth) {
      truncated = truncated.slice(0, -1).trimEnd()
    }
    lines[last] = `${truncated}…`
  }
  return lines
}

function drawBrandMark(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): void {
  context.save()
  context.fillStyle = PALETTE.primary
  context.shadowColor = 'rgba(199, 243, 107, 0.32)'
  context.shadowBlur = size * 0.38
  context.beginPath()
  context.moveTo(x + size * 0.46, y)
  context.lineTo(x + size * 0.9, y)
  context.lineTo(x + size * 0.58, y + size * 0.42)
  context.lineTo(x + size * 0.88, y + size * 0.42)
  context.lineTo(x + size * 0.14, y + size)
  context.lineTo(x + size * 0.43, y + size * 0.55)
  context.lineTo(x + size * 0.12, y + size * 0.55)
  context.closePath()
  context.fill()
  context.restore()
}

function drawBackground(
  context: CanvasRenderingContext2D,
  layout: ShareCardLayout,
  deckHue: number,
): void {
  context.fillStyle = PALETTE.backgroundDeep
  context.fillRect(0, 0, layout.width, layout.height)
  const wash = context.createRadialGradient(
    layout.width * 0.18,
    0,
    0,
    layout.width * 0.18,
    0,
    layout.width * 0.85,
  )
  wash.addColorStop(0, `hsla(${deckHue} 70% 45% / 0.24)`)
  wash.addColorStop(1, 'rgba(3, 7, 6, 0)')
  context.fillStyle = wash
  context.fillRect(0, 0, layout.width, layout.height)

  const spacing = Math.max(48, Math.round(layout.width / 18))
  context.strokeStyle = 'rgba(173, 223, 199, 0.08)'
  context.lineWidth = 1
  for (let x = spacing / 2; x < layout.width; x += spacing) {
    context.beginPath()
    context.moveTo(x, 0)
    context.lineTo(x, layout.height)
    context.stroke()
  }
  for (let y = spacing / 2; y < layout.height; y += spacing) {
    context.beginPath()
    context.moveTo(0, y)
    context.lineTo(layout.width, y)
    context.stroke()
  }

  const vignette = context.createLinearGradient(0, 0, 0, layout.height)
  vignette.addColorStop(0, 'rgba(6, 16, 14, 0.1)')
  vignette.addColorStop(0.62, 'rgba(6, 16, 14, 0.18)')
  vignette.addColorStop(1, 'rgba(3, 7, 6, 0.94)')
  context.fillStyle = vignette
  context.fillRect(0, 0, layout.width, layout.height)
}

function drawHeader(
  context: CanvasRenderingContext2D,
  data: ShareCardData,
  layout: ShareCardLayout,
): void {
  const { header } = layout
  const markSize = Math.min(52, header.height * 0.55)
  drawBrandMark(context, header.x, header.y + (header.height - markSize) / 2, markSize)
  context.textBaseline = 'middle'
  context.textAlign = 'left'
  context.fillStyle = PALETTE.ink
  context.font = `900 ${Math.round(markSize * 0.54)}px "Arial Narrow", "Avenir Next Condensed", sans-serif`
  context.fillText(data.brand, header.x + markSize + 22, header.y + header.height * 0.43)
  context.fillStyle = PALETTE.muted
  context.font = `700 ${Math.round(markSize * 0.22)}px ui-monospace, monospace`
  context.fillText('ONE FLAG · ONE LINE', header.x + markSize + 22, header.y + header.height * 0.72)

  context.textAlign = 'right'
  context.fillStyle = PALETTE.inkSoft
  context.font = `800 ${Math.max(18, Math.round(markSize * 0.34))}px ui-monospace, monospace`
  context.fillText(data.deckName.toUpperCase(), header.x + header.width, header.y + header.height * 0.43)
  context.fillStyle = PALETTE.muted
  context.font = `700 ${Math.max(13, Math.round(markSize * 0.22))}px ui-monospace, monospace`
  context.fillText(data.deckKicker.toUpperCase(), header.x + header.width, header.y + header.height * 0.72)
}

function drawHero(
  context: CanvasRenderingContext2D,
  data: ShareCardData,
  layout: ShareCardLayout,
): void {
  const { hero } = layout
  const accent = accentColor(data.accent)
  context.fillStyle = accent
  context.font = `800 ${layout.mode === 'split' ? 25 : layout.format === 'portrait-9x16' ? 27 : 21}px ui-monospace, monospace`
  context.textAlign = 'left'
  context.textBaseline = 'top'
  context.fillText(data.kicker, hero.x, hero.y)

  const maximumFont = layout.mode === 'split' ? 92 : layout.format === 'portrait-9x16' ? 104 : 72
  const minimumFont = layout.mode === 'split' ? 54 : 46
  const maximumLines = layout.mode === 'split' ? 4 : layout.format === 'portrait-9x16' ? 3 : 2
  let fontSize = maximumFont
  let lines: string[] = []
  do {
    context.font = `900 ${fontSize}px "Arial Narrow", "Avenir Next Condensed", sans-serif`
    lines = wrapLines(context, data.headline, hero.width, maximumLines)
    const lineHeight = fontSize * 0.9
    if (lines.length * lineHeight <= hero.height * 0.66) break
    fontSize -= 4
  } while (fontSize > minimumFont)

  const titleY = hero.y + (layout.mode === 'split' ? 64 : 58)
  context.fillStyle = PALETTE.ink
  context.font = `900 ${fontSize}px "Arial Narrow", "Avenir Next Condensed", sans-serif`
  lines.forEach((line, index) => context.fillText(line, hero.x, titleY + index * fontSize * 0.9))

  const detailY = Math.min(hero.y + hero.height - 46, titleY + lines.length * fontSize * 0.9 + 30)
  context.fillStyle = PALETTE.inkSoft
  context.font = `600 ${layout.mode === 'split' ? 24 : layout.format === 'portrait-9x16' ? 25 : 19}px ui-sans-serif, system-ui, sans-serif`
  const detailLines = wrapLines(context, data.detail, hero.width, layout.mode === 'split' ? 3 : 2)
  detailLines.forEach((line, index) => context.fillText(line, hero.x, detailY + index * 32))
}

function drawChart(
  context: CanvasRenderingContext2D,
  data: ShareCardData,
  layout: ShareCardLayout,
): void {
  const { chart } = layout
  const radius = layout.format === 'portrait-9x16' ? 30 : 24
  fillPanel(context, chart, radius)
  const inset = layout.format === 'portrait-9x16' ? 52 : 38
  const plot = {
    x: chart.x + inset,
    y: chart.y + inset + 28,
    width: chart.width - inset * 2,
    height: chart.height - inset * 2 - 50,
  }

  context.textAlign = 'left'
  context.textBaseline = 'top'
  context.fillStyle = PALETTE.muted
  context.font = `700 ${layout.format === 'portrait-9x16' ? 18 : 15}px ui-monospace, monospace`
  context.fillText('REVEALED PATH', plot.x, chart.y + inset - 10)
  context.textAlign = 'right'
  context.fillText(data.chart.side === 'upper' ? 'FLAG ABOVE' : 'FLAG BELOW', plot.x + plot.width, chart.y + inset - 10)

  context.strokeStyle = 'rgba(61, 101, 89, 0.42)'
  context.lineWidth = 1
  for (let index = 0; index <= 4; index += 1) {
    const y = plot.y + plot.height * index / 4
    context.beginPath()
    context.moveTo(plot.x, y)
    context.lineTo(plot.x + plot.width, y)
    context.stroke()
  }

  const flagY = plot.y + (1 - data.chart.flag) * plot.height
  context.save()
  context.setLineDash([14, 10])
  context.strokeStyle = accentColor(data.accent)
  context.lineWidth = 3
  context.beginPath()
  context.moveTo(plot.x, flagY)
  context.lineTo(plot.x + plot.width, flagY)
  context.stroke()
  context.restore()

  const points = data.chart.points
  if (points.length > 1) {
    const glow = accentColor(data.accent)
    context.beginPath()
    points.forEach((point, index) => {
      const x = plot.x + index / (points.length - 1) * plot.width
      const y = plot.y + (1 - point) * plot.height
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    context.strokeStyle = glow
    context.lineWidth = layout.format === 'portrait-9x16' ? 7 : 5
    context.shadowColor = glow
    context.shadowBlur = 22
    context.stroke()
    context.shadowBlur = 0
  }

  const finalY = plot.y + (1 - data.chart.final) * plot.height
  context.fillStyle = PALETTE.ink
  context.beginPath()
  context.arc(plot.x + plot.width, finalY, 8, 0, Math.PI * 2)
  context.fill()
}

function drawStats(
  context: CanvasRenderingContext2D,
  data: ShareCardData,
  layout: ShareCardLayout,
): void {
  const { stats } = layout
  const gap = layout.format === 'portrait-9x16' ? 18 : 14
  const cellWidth = (stats.width - gap * 3) / 4
  data.stats.forEach((stat, index) => {
    const rect = { x: stats.x + index * (cellWidth + gap), y: stats.y, width: cellWidth, height: stats.height }
    fillPanel(context, rect, layout.format === 'portrait-9x16' ? 24 : 18, PALETTE.surfaceRaised)
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = PALETTE.muted
    context.font = `700 ${layout.format === 'portrait-9x16' ? 17 : 14}px ui-monospace, monospace`
    context.fillText(stat.label, rect.x + rect.width / 2, rect.y + rect.height * 0.32)
    context.fillStyle = index === 1 ? accentColor(data.accent) : PALETTE.ink
    context.font = `900 ${layout.format === 'portrait-9x16' ? 38 : 29}px ui-monospace, monospace`
    context.fillText(stat.value, rect.x + rect.width / 2, rect.y + rect.height * 0.62)
  })
}

function drawFooter(
  context: CanvasRenderingContext2D,
  data: ShareCardData,
  layout: ShareCardLayout,
): void {
  const { footer } = layout
  context.textBaseline = 'middle'
  context.textAlign = 'left'
  context.fillStyle = PALETTE.inkSoft
  context.font = `700 ${layout.format === 'portrait-9x16' ? 20 : 16}px ui-monospace, monospace`
  context.fillText('PLAY STRIKEFALL', footer.x, footer.y + footer.height / 2)
  context.textAlign = 'right'
  context.fillStyle = PALETTE.muted
  context.fillText(
    `${data.botCount} BOTS · ${data.outcome.toUpperCase().replace('-', ' ')}`,
    footer.x + footer.width,
    footer.y + footer.height / 2,
  )
}

function drawResultCard(
  context: CanvasRenderingContext2D,
  data: ShareCardData,
  layout: ShareCardLayout,
): void {
  drawBackground(context, layout, data.deckHue)
  drawHeader(context, data, layout)
  drawHero(context, data, layout)
  drawChart(context, data, layout)
  drawStats(context, data, layout)
  drawFooter(context, data, layout)

  context.strokeStyle = PALETTE.lineStrong
  context.lineWidth = 3
  roundedRect(context, 14, 14, layout.width - 28, layout.height - 28, 28)
  context.stroke()
}

export function renderShareCard(
  data: ShareCardData,
  options: ShareCardRenderOptions = {},
): ShareCardRenderResult {
  const format = options.format ?? 'portrait-9x16'
  const layout = createShareCardLayout(format)
  const environment = options.environment ?? defaultEnvironment()
  if (!environment) {
    return { status: 'unsupported', reason: 'Canvas rendering is unavailable in this environment.' }
  }
  try {
    const canvas = environment.createCanvas(layout.width, layout.height)
    canvas.width = layout.width
    canvas.height = layout.height
    const context = canvas.getContext('2d')
    if (!context) return { status: 'unsupported', reason: 'A 2D canvas context is unavailable.' }
    drawResultCard(context, data, layout)
    return { status: 'ready', canvas, layout }
  } catch (error) {
    return { status: 'error', error: errorOf(error) }
  }
}

async function canvasBlob(canvas: ShareCanvasSurface): Promise<Blob | null> {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' })
  if (!canvas.toBlob) return null
  return new Promise((resolve) => canvas.toBlob?.(resolve, 'image/png'))
}

export async function exportShareCard(
  data: ShareCardData,
  options: ShareCardRenderOptions = {},
): Promise<ShareCardExportResult> {
  const rendered = renderShareCard(data, options)
  if (rendered.status !== 'ready') return rendered
  try {
    const blob = await canvasBlob(rendered.canvas)
    if (!blob) return { status: 'unsupported', reason: 'PNG export is unavailable for this canvas.' }
    return { status: 'ready', blob, layout: rendered.layout }
  } catch (error) {
    return { status: 'error', error: errorOf(error) }
  }
}
