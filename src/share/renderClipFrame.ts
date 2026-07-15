import type { ShareRect } from './layout'
import { createShareClipLayout } from './clipLayout'
import type { ShareClipLayout } from './clipLayout'
import type { DramaticMomentAccent, ShareCardData, ShareClipFormat } from './types'

export interface ShareClipFrameSource {
  width: number
  height: number
}

const COLORS = {
  background: '#030706',
  surface: '#0a1714',
  raised: '#10221e',
  line: '#25423a',
  lineStrong: '#3d6559',
  ink: '#f1f7ee',
  soft: '#c0d0c9',
  muted: '#8ba099',
  primary: '#c7f36b',
  strike: '#ff7447',
  danger: '#ff5f66',
  success: '#65e3aa',
  violet: '#ab8cff',
} as const

function accentColor(accent: DramaticMomentAccent): string {
  return COLORS[accent]
}

function roundedRect(
  context: CanvasRenderingContext2D,
  rect: ShareRect,
  radius: number,
): void {
  const bounded = Math.min(radius, rect.width / 2, rect.height / 2)
  context.beginPath()
  context.moveTo(rect.x + bounded, rect.y)
  context.lineTo(rect.x + rect.width - bounded, rect.y)
  context.quadraticCurveTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + bounded)
  context.lineTo(rect.x + rect.width, rect.y + rect.height - bounded)
  context.quadraticCurveTo(
    rect.x + rect.width,
    rect.y + rect.height,
    rect.x + rect.width - bounded,
    rect.y + rect.height,
  )
  context.lineTo(rect.x + bounded, rect.y + rect.height)
  context.quadraticCurveTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - bounded)
  context.lineTo(rect.x, rect.y + bounded)
  context.quadraticCurveTo(rect.x, rect.y, rect.x + bounded, rect.y)
  context.closePath()
}

function panel(
  context: CanvasRenderingContext2D,
  rect: ShareRect,
  radius: number,
  fill: string = COLORS.surface,
): void {
  roundedRect(context, rect, radius)
  context.fillStyle = fill
  context.fill()
  context.strokeStyle = COLORS.line
  context.lineWidth = 2
  context.stroke()
}

function wrapLines(
  context: CanvasRenderingContext2D,
  value: string,
  maximumWidth: number,
  maximumLines: number,
): string[] {
  const words = value.trim().split(/\s+/)
  const lines: string[] = []
  let line = ''
  let consumed = 0
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (!line || context.measureText(candidate).width <= maximumWidth) {
      line = candidate
      consumed += 1
      continue
    }
    lines.push(line)
    if (lines.length >= maximumLines) break
    line = word
    consumed += 1
  }
  if (line && lines.length < maximumLines) lines.push(line)
  if (consumed < words.length && lines.length > 0) {
    const last = lines.length - 1
    let clipped = lines[last] ?? ''
    while (clipped && context.measureText(`${clipped}…`).width > maximumWidth) {
      clipped = clipped.slice(0, -1).trimEnd()
    }
    lines[last] = `${clipped}…`
  }
  return lines
}

function drawBackground(
  context: CanvasRenderingContext2D,
  layout: ShareClipLayout,
  deckHue: number,
): void {
  context.fillStyle = COLORS.background
  context.fillRect(0, 0, layout.width, layout.height)
  const glow = context.createRadialGradient(
    layout.width * 0.2,
    0,
    0,
    layout.width * 0.2,
    0,
    layout.height * 0.62,
  )
  glow.addColorStop(0, `hsla(${deckHue} 72% 48% / 0.26)`)
  glow.addColorStop(1, 'rgba(3, 7, 6, 0)')
  context.fillStyle = glow
  context.fillRect(0, 0, layout.width, layout.height)

  context.strokeStyle = 'rgba(173, 223, 199, 0.07)'
  context.lineWidth = 1
  const spacing = 44
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
}

function drawBolt(context: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  context.save()
  context.fillStyle = COLORS.primary
  context.shadowColor = 'rgba(199, 243, 107, 0.38)'
  context.shadowBlur = 15
  context.beginPath()
  context.moveTo(x + size * 0.44, y)
  context.lineTo(x + size * 0.94, y)
  context.lineTo(x + size * 0.6, y + size * 0.43)
  context.lineTo(x + size * 0.9, y + size * 0.43)
  context.lineTo(x + size * 0.12, y + size)
  context.lineTo(x + size * 0.43, y + size * 0.55)
  context.lineTo(x + size * 0.12, y + size * 0.55)
  context.closePath()
  context.fill()
  context.restore()
}

function drawHeader(
  context: CanvasRenderingContext2D,
  data: ShareCardData,
  layout: ShareClipLayout,
): void {
  const mark = layout.format === 'portrait-9x16' ? 42 : 34
  drawBolt(context, layout.header.x, layout.header.y + (layout.header.height - mark) / 2, mark)
  context.textBaseline = 'middle'
  context.textAlign = 'left'
  context.fillStyle = COLORS.ink
  context.font = `900 ${layout.format === 'portrait-9x16' ? 27 : 23}px "Arial Narrow", sans-serif`
  context.fillText('STRIKEFALL', layout.header.x + mark + 16, layout.header.y + layout.header.height * 0.44)
  context.fillStyle = COLORS.muted
  context.font = `700 ${layout.format === 'portrait-9x16' ? 12 : 10}px ui-monospace, monospace`
  context.fillText('ONE FLAG · ONE LINE', layout.header.x + mark + 16, layout.header.y + layout.header.height * 0.75)

  context.textAlign = 'right'
  context.fillStyle = COLORS.soft
  context.font = `800 ${layout.format === 'portrait-9x16' ? 18 : 15}px ui-monospace, monospace`
  context.fillText(data.deckName.toUpperCase(), layout.header.x + layout.header.width, layout.header.y + layout.header.height * 0.44)
  context.fillStyle = COLORS.muted
  context.font = `700 ${layout.format === 'portrait-9x16' ? 11 : 9}px ui-monospace, monospace`
  context.fillText(data.deckKicker.toUpperCase(), layout.header.x + layout.header.width, layout.header.y + layout.header.height * 0.75)
}

function drawArena(
  context: CanvasRenderingContext2D,
  source: ShareClipFrameSource,
  data: ShareCardData,
  layout: ShareClipLayout,
): void {
  const { arena } = layout
  panel(context, arena, 22, '#050b0a')
  const inset = 4
  const available = {
    x: arena.x + inset,
    y: arena.y + inset,
    width: arena.width - inset * 2,
    height: arena.height - inset * 2,
  }
  const sourceWidth = Math.max(1, source.width)
  const sourceHeight = Math.max(1, source.height)
  const scale = Math.min(available.width / sourceWidth, available.height / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  const drawX = available.x + (available.width - drawWidth) / 2
  const drawY = available.y + (available.height - drawHeight) / 2

  context.save()
  roundedRect(context, available, 18)
  context.clip()
  context.fillStyle = '#050711'
  context.fillRect(available.x, available.y, available.width, available.height)
  context.drawImage(
    source as unknown as CanvasImageSource,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
  )
  const shade = context.createLinearGradient(0, available.y, 0, available.y + available.height)
  shade.addColorStop(0, 'rgba(3, 7, 6, 0.02)')
  shade.addColorStop(0.72, 'rgba(3, 7, 6, 0.04)')
  shade.addColorStop(1, 'rgba(3, 7, 6, 0.7)')
  context.fillStyle = shade
  context.fillRect(available.x, available.y, available.width, available.height)
  context.restore()

  const status = data.outcome === 'in-progress' ? 'LIVE BUFFER' : 'MOMENT LOCKED'
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  context.font = '800 11px ui-monospace, monospace'
  context.fillStyle = accentColor(data.accent)
  context.fillText(status, arena.x + 18, arena.y + arena.height - 22)
}

function outcomeLabel(data: ShareCardData): string {
  if (data.outcome === 'in-progress') return 'LIVE'
  return data.outcome.toUpperCase()
}

function drawStory(
  context: CanvasRenderingContext2D,
  data: ShareCardData,
  layout: ShareClipLayout,
): void {
  const { story } = layout
  const portrait = layout.format === 'portrait-9x16'
  panel(context, story, portrait ? 24 : 18, COLORS.surface)
  const x = story.x + (portrait ? 28 : 20)
  const width = story.width - (portrait ? 56 : 40)
  const top = story.y + (portrait ? 26 : 18)
  context.textAlign = 'left'
  context.textBaseline = 'top'
  context.fillStyle = accentColor(data.accent)
  context.font = `800 ${portrait ? 16 : 12}px ui-monospace, monospace`
  context.fillText(`${data.kicker} · ${outcomeLabel(data)}`, x, top)

  context.fillStyle = COLORS.ink
  context.font = `900 ${portrait ? 47 : 30}px "Arial Narrow", sans-serif`
  const headlineLines = wrapLines(context, data.headline, width, portrait ? 3 : 2)
  const headlineY = top + (portrait ? 36 : 24)
  headlineLines.forEach((line, index) => {
    context.fillText(line, x, headlineY + index * (portrait ? 43 : 28))
  })

  const detailY = story.y + story.height - (portrait ? 50 : 34)
  context.fillStyle = COLORS.soft
  context.font = `600 ${portrait ? 16 : 12}px ui-sans-serif, system-ui, sans-serif`
  const details = wrapLines(context, data.detail, width, portrait ? 2 : 1)
  details.forEach((line, index) => context.fillText(line, x, detailY + index * 20))
}

function drawFact(
  context: CanvasRenderingContext2D,
  rect: ShareRect,
  label: string,
  value: string,
  accent: boolean,
  compact: boolean,
): void {
  panel(context, rect, compact ? 14 : 18, COLORS.raised)
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = COLORS.muted
  context.font = `700 ${compact ? 9 : 11}px ui-monospace, monospace`
  context.fillText(label, rect.x + rect.width / 2, rect.y + rect.height * 0.34)
  context.fillStyle = accent ? COLORS.primary : COLORS.ink
  context.font = `900 ${compact ? 19 : 25}px ui-monospace, monospace`
  context.fillText(value, rect.x + rect.width / 2, rect.y + rect.height * 0.66)
}

function drawFacts(
  context: CanvasRenderingContext2D,
  data: ShareCardData,
  layout: ShareClipLayout,
): void {
  const { facts } = layout
  if (layout.format === 'portrait-9x16') {
    const gap = 12
    const width = (facts.width - gap * 2) / 3
    drawFact(context, { x: facts.x, y: facts.y, width, height: facts.height }, 'MULTIPLIER', `${data.multiplier.toFixed(2)}×`, true, false)
    drawFact(context, { x: facts.x + width + gap, y: facts.y, width, height: facts.height }, 'BOT FIELD', `${data.botCount} BOTS`, false, false)
    drawFact(context, { x: facts.x + (width + gap) * 2, y: facts.y, width, height: facts.height }, 'RESULT', outcomeLabel(data), false, false)
    return
  }
  const gap = 8
  const height = (facts.height - gap * 2) / 3
  drawFact(context, { x: facts.x, y: facts.y, width: facts.width, height }, 'MULTIPLIER', `${data.multiplier.toFixed(2)}×`, true, true)
  drawFact(context, { x: facts.x, y: facts.y + height + gap, width: facts.width, height }, 'BOT FIELD', `${data.botCount} BOTS`, false, true)
  drawFact(context, { x: facts.x, y: facts.y + (height + gap) * 2, width: facts.width, height }, 'RESULT', outcomeLabel(data), false, true)
}

function drawFooter(
  context: CanvasRenderingContext2D,
  data: ShareCardData,
  layout: ShareClipLayout,
): void {
  const moment = data.momentKind.replaceAll('-', ' ').toUpperCase()
  context.textBaseline = 'middle'
  context.textAlign = 'left'
  context.fillStyle = COLORS.muted
  context.font = `700 ${layout.format === 'portrait-9x16' ? 13 : 11}px ui-monospace, monospace`
  context.fillText(`MOMENT · ${moment}`, layout.footer.x, layout.footer.y + layout.footer.height / 2)
  context.textAlign = 'right'
  context.fillStyle = COLORS.soft
  context.fillText('PLAY STRIKEFALL', layout.footer.x + layout.footer.width, layout.footer.y + layout.footer.height / 2)
}

/** Draws one privacy-safe, branded clip frame without reading any hidden round data. */
export function renderShareClipFrame(
  context: CanvasRenderingContext2D,
  source: ShareClipFrameSource,
  data: ShareCardData,
  format: ShareClipFormat,
): ShareClipLayout {
  const layout = createShareClipLayout(format)
  drawBackground(context, layout, data.deckHue)
  drawHeader(context, data, layout)
  drawArena(context, source, data, layout)
  drawStory(context, data, layout)
  drawFacts(context, data, layout)
  drawFooter(context, data, layout)
  context.strokeStyle = COLORS.lineStrong
  context.lineWidth = 2
  roundedRect(context, { x: 10, y: 10, width: layout.width - 20, height: layout.height - 20 }, 22)
  context.stroke()
  return layout
}
