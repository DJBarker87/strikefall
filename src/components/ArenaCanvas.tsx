import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import type { Candle, Contender, FlagSide, GamePhase, RoundState } from '../game/types'
import {
  estimateSurvivalProbability,
  getContenderEscapeQuote,
  legalDistanceBounds,
} from '../game'
import { derivePersonaTell, type PersonaTellState } from './personaTells'

export interface ArenaPlacement {
  side: FlagSide
  /** Distance from the live line, in the same units as Contender.distance. */
  distance: number
  /** Absolute line coordinate derived from the pointer position. */
  barrier: number
}

export interface ArenaCanvasProps {
  round: RoundState
  onPlace?: (placement: ArenaPlacement) => void
  /** Exposes the rendered surface for the bounded, local share-clip recorder. */
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void
  disabled?: boolean
  reducedMotion?: boolean
  mutedFlash?: boolean
  /**
   * Cosmetic-only deck mastery tier. It changes the local player pennant,
   * trail, impact, and frame without entering any scoring or replay input.
   */
  masteryLevel?: number
  /** Display-only choice for the live path: OHLC candles or a plain line. */
  chartStyle?: ChartStyle
  className?: string
  ariaLabel?: string
}

export type ChartStyle = 'candles' | 'line'

interface ArenaPalette {
  background: string
  backgroundLift: string
  grid: string
  line: string
  lineCore: string
  player: string
  danger: string
  safe: string
  text: string
  muted: string
  bot: string
}

interface CanvasSize {
  width: number
  height: number
  dpr: number
}

interface ArenaView {
  left: number
  right: number
  top: number
  bottom: number
  worldMin: number
  worldMax: number
  lineY: number
  distanceScale: number
  maxPlacementDistance: number
}

interface PointerPreview {
  visible: boolean
  dragging: boolean
  y: number
}

/**
 * Mutable camera state: the drawn world window eases toward the fitted target
 * instead of snapping, so kills, spikes, and line drift pan the view gently.
 */
interface ViewEase {
  roundId: string
  worldMin: number
  worldMax: number
  lastNow: number
}

interface ImpactBurst {
  id: string
  contenderId: string
  isPlayer: boolean
  barrier: number
  side: FlagSide
  color: string
  startAt: number
}

interface DrawOptions {
  chartStyle: ChartStyle
  focused: boolean
  masteryLevel: number
  mutedFlash: boolean
  pointer: PointerPreview
  reducedMotion: boolean
}

const TAU = Math.PI * 2
const EPSILON = 0.000_001

// Canvas colors need concrete values. Every fallback can be themed from CSS with
// the matching --arena-* custom property, while these defaults preserve the
// storm-dark art direction when the component is rendered in isolation.
const FALLBACK_PALETTE: ArenaPalette = {
  background: '#050711',
  backgroundLift: '#0d1526',
  grid: '#41516d',
  line: '#55e6ff',
  lineCore: '#effcff',
  player: '#ffd27a',
  danger: '#ff5f67',
  safe: '#6fffc1',
  text: '#f1f7ff',
  muted: '#a8b8ce',
  bot: '#91a4be',
}

const ROOT_STYLE: CSSProperties = {
  display: 'grid',
  width: '100%',
  minHeight: '360px',
  overflow: 'hidden',
}

const VIEWPORT_STYLE: CSSProperties = {
  position: 'relative',
  display: 'block',
  width: '100%',
  height: '100%',
  minHeight: 'inherit',
  margin: 0,
  padding: 0,
  overflow: 'hidden',
  border: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  touchAction: 'none',
}

const CONTROL_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'block',
  width: '100%',
  height: '100%',
  margin: 0,
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  cursor: 'crosshair',
  font: 'inherit',
  touchAction: 'none',
}

const CANVAS_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
}

// This is the standard visually-hidden pattern; the fixed pixel values are
// intentional accessibility mechanics rather than visual spacing tokens.
const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount
}

function smoothstep(value: number): number {
  const bounded = clamp(value, 0, 1)
  return bounded * bounded * (3 - 2 * bounded)
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function hashUnit(value: string): number {
  return hashString(value) / 4_294_967_295
}

function median(values: number[]): number {
  if (values.length === 0) return 1
  const sorted = [...values].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 1) + (sorted[middle] ?? 1)) / 2
    : (sorted[middle] ?? 1)
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + safeRadius, y)
  context.lineTo(x + width - safeRadius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  context.lineTo(x + width, y + height - safeRadius)
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  context.lineTo(x + safeRadius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  context.lineTo(x, y + safeRadius)
  context.quadraticCurveTo(x, y, x + safeRadius, y)
  context.closePath()
}

function cssColor(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim()
  return value || fallback
}

function readPalette(canvas: HTMLCanvasElement): ArenaPalette {
  const style = window.getComputedStyle(canvas)
  return {
    background: cssColor(style, '--arena-bg', FALLBACK_PALETTE.background),
    backgroundLift: cssColor(
      style,
      '--arena-bg-lift',
      FALLBACK_PALETTE.backgroundLift,
    ),
    grid: cssColor(style, '--arena-grid', FALLBACK_PALETTE.grid),
    line: cssColor(style, '--arena-line', FALLBACK_PALETTE.line),
    lineCore: cssColor(style, '--arena-line-core', FALLBACK_PALETTE.lineCore),
    player: cssColor(style, '--arena-player', FALLBACK_PALETTE.player),
    danger: cssColor(style, '--arena-danger', FALLBACK_PALETTE.danger),
    safe: cssColor(style, '--arena-safe', FALLBACK_PALETTE.safe),
    text: cssColor(style, '--arena-text', FALLBACK_PALETTE.text),
    muted: cssColor(style, '--arena-muted', FALLBACK_PALETTE.muted),
    bot: cssColor(style, '--arena-bot', FALLBACK_PALETTE.bot),
  }
}

function mapY(value: number, view: ArenaView): number {
  const ratio = (value - view.worldMin) / Math.max(EPSILON, view.worldMax - view.worldMin)
  return lerp(view.bottom, view.top, ratio)
}

function playerFor(round: RoundState): Contender | undefined {
  return round.contenders.find((contender) => contender.isPlayer)
}

function estimateDistanceScale(round: RoundState): number {
  if (round.phase === 'battle' || round.phase === 'result') return 1
  const samples = round.contenders
    .filter((contender) => contender.distance > EPSILON)
    .map(
      (contender) =>
        Math.abs(contender.barrier - round.lineValue) / Math.max(EPSILON, contender.distance),
    )
    .filter((value) => Number.isFinite(value) && value > EPSILON && value < 10_000)
  return clamp(median(samples), 0.000_1, 10_000)
}

function getPlacementMaxDistance(round: RoundState): number {
  const existing = round.contenders
    .map((contender) => contender.distance)
    .filter((distance) => Number.isFinite(distance) && distance > 0)
  return Math.max(1, ...existing) * 1.12
}

function buildView(
  round: RoundState,
  width: number,
  height: number,
  impacts: ImpactBurst[],
  now: number,
  ease?: ViewEase | null,
): ArenaView {
  const compact = width < 560
  const left = compact ? 18 : 32
  const right = width - (compact ? 16 : 28)
  const top = compact ? 52 : 60
  // The placement HUD lives over the bottom of the arena in the product shell.
  // Reserving its touch-height here keeps risky lower flags and instructions
  // visible instead of letting them disappear beneath the control dock.
  const placementInset = round.phase === 'placement' ? (compact ? 142 : 118) : 0
  const bottom = height - (compact ? 48 : 54) - placementInset
  const line = round.lineValue
  const distanceScale = estimateDistanceScale(round)
  const approachValues = round.approach.flatMap((candle) => [candle.low, candle.high])
  const approachRange =
    approachValues.length > 0
      ? Math.max(...approachValues) - Math.min(...approachValues)
      : 0
  const contenderWorldDistances = round.contenders
    .map((contender) => Math.abs(contender.barrier - line))
    .filter((distance) => Number.isFinite(distance) && distance > EPSILON)
  const fallbackSpan = Math.max(
    approachRange * 0.34,
    median(contenderWorldDistances) * 0.65,
    Math.abs(line) * 0.0025,
    0.05,
  )

  let upperExtent = fallbackSpan
  let lowerExtent = fallbackSpan
  const active = round.contenders.filter((contender) => contender.outcome === 'active')
  const player = playerFor(round)

  if (round.phase === 'battle' || round.phase === 'result') {
    const visibleEnd = round.phase === 'result'
      ? round.battleExtrema.length
      : Math.min(round.battleExtrema.length, round.battleIndex + 1)
    // The chart keeps the whole revealed battle on a fixed time axis, so the
    // vertical window has to hold every extreme seen so far, not a recent slice.
    for (const extrema of round.battleExtrema.slice(0, visibleEnd)) {
      upperExtent = Math.max(upperExtent, extrema.high - line)
      lowerExtent = Math.max(lowerExtent, line - extrema.low)
    }
    const upper = active
      .filter((contender) => contender.barrier >= line)
      .sort((first, second) => first.barrier - second.barrier)[0]
    const lower = active
      .filter((contender) => contender.barrier < line)
      .sort((first, second) => second.barrier - first.barrier)[0]
    if (upper) upperExtent = Math.max(upperExtent, upper.barrier - line)
    if (lower) lowerExtent = Math.max(lowerExtent, line - lower.barrier)
    if (player && player.outcome !== 'hit') {
      if (player.barrier >= line) upperExtent = Math.max(upperExtent, player.barrier - line)
      else lowerExtent = Math.max(lowerExtent, line - player.barrier)
    }
    for (const impact of impacts) {
      if (now - impact.startAt > 900) continue
      if (impact.barrier >= line) upperExtent = Math.max(upperExtent, impact.barrier - line)
      else lowerExtent = Math.max(lowerExtent, line - impact.barrier)
    }
  } else {
    for (const contender of round.contenders) {
      if (contender.barrier >= line) upperExtent = Math.max(upperExtent, contender.barrier - line)
      else lowerExtent = Math.max(lowerExtent, line - contender.barrier)
    }
    if (approachValues.length > 0) {
      upperExtent = Math.max(upperExtent, Math.max(...approachValues) - line)
      lowerExtent = Math.max(lowerExtent, line - Math.min(...approachValues))
    }
    if (round.phase !== 'home') {
      // Frame the entire legal strike band for the whole pre-battle sequence.
      // Deck, tape, placement, and lock share one static window, so the zoom
      // never moves while the player reads history or plants their strike.
      try {
        upperExtent = Math.max(
          upperExtent,
          legalDistanceBounds(line, 'upper', round.lineValueFixed).maximum,
        )
        lowerExtent = Math.max(
          lowerExtent,
          legalDistanceBounds(line, 'lower', round.lineValueFixed).maximum,
        )
      } catch {
        // Engine not ready: fall back to the contender-driven extents.
      }
    }
  }

  const padding = round.phase === 'battle' ? 1.45 : 1.24
  let worldMax = line + Math.max(fallbackSpan * 0.72, upperExtent * padding)
  let worldMin = line - Math.max(fallbackSpan * 0.72, lowerExtent * padding)

  if (ease) {
    const stale = ease.roundId !== round.roundId || !(ease.worldMax > ease.worldMin)
    if (stale) {
      ease.roundId = round.roundId
      ease.worldMin = worldMin
      ease.worldMax = worldMax
      ease.lastNow = now
    } else {
      const dt = clamp(now - ease.lastNow, 0, 200)
      ease.lastNow = now
      const blend = 1 - Math.exp(-dt / 340)
      ease.worldMin += (worldMin - ease.worldMin) * blend
      ease.worldMax += (worldMax - ease.worldMax) * blend
      // The camera may lag, but the live line must never leave the frame.
      const margin = (ease.worldMax - ease.worldMin) * 0.05
      if (line > ease.worldMax - margin) ease.worldMax = line + margin
      if (line < ease.worldMin + margin) ease.worldMin = line - margin
    }
    worldMin = ease.worldMin
    worldMax = ease.worldMax
  }

  const lineY = lerp(
    bottom,
    top,
    (line - worldMin) / Math.max(EPSILON, worldMax - worldMin),
  )
  const visibleDistance = Math.max(line - worldMin, worldMax - line) / distanceScale

  return {
    left,
    right,
    top,
    bottom,
    worldMin,
    worldMax,
    lineY,
    distanceScale,
    maxPlacementDistance: Math.max(getPlacementMaxDistance(round), visibleDistance * 0.88),
  }
}

function drawBackground(
  context: CanvasRenderingContext2D,
  round: RoundState,
  width: number,
  height: number,
  view: ArenaView,
  palette: ArenaPalette,
  now: number,
  reducedMotion: boolean,
): void {
  const background = context.createLinearGradient(0, 0, width, height)
  background.addColorStop(0, palette.backgroundLift)
  background.addColorStop(0.46, palette.background)
  background.addColorStop(1, '#02030a')
  context.fillStyle = background
  context.fillRect(0, 0, width, height)

  const deckAccent = `hsl(${round.deck.hue} 82% 62%)`
  context.save()
  context.globalAlpha = 0.1
  const storm = context.createRadialGradient(
    width * 0.62,
    height * 0.2,
    0,
    width * 0.62,
    height * 0.2,
    Math.max(width, height) * 0.72,
  )
  storm.addColorStop(0, deckAccent)
  storm.addColorStop(0.42, palette.backgroundLift)
  storm.addColorStop(1, palette.background)
  context.fillStyle = storm
  context.fillRect(0, 0, width, height)
  context.restore()

  context.save()
  context.strokeStyle = palette.grid
  context.lineWidth = 1
  const span = Math.max(EPSILON, view.worldMax - view.worldMin)
  const decimals = span < 1 ? 3 : span < 10 ? 2 : span < 100 ? 1 : 0
  for (let y = view.top; y <= view.bottom; y += 48) {
    context.globalAlpha = Math.abs(y - view.lineY) < 16 ? 0.17 : 0.09
    context.beginPath()
    context.moveTo(view.left, Math.round(y) + 0.5)
    context.lineTo(view.right, Math.round(y) + 0.5)
    context.stroke()
    if ((y - view.top) % 96 === 0 && y > view.top + 8 && y < view.bottom - 8) {
      const value = view.worldMax - ((y - view.top) / Math.max(EPSILON, view.bottom - view.top)) * span
      context.globalAlpha = 0.3
      context.fillStyle = palette.muted
      context.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.textAlign = 'left'
      context.textBaseline = 'bottom'
      context.fillText(value.toFixed(decimals), view.left + 3, y - 3)
    }
  }
  for (let quarter = 0; quarter <= 4; quarter += 1) {
    const x = lerp(view.left, view.right, quarter / 4)
    context.globalAlpha = quarter === 0 || quarter === 4 ? 0.12 : 0.07
    context.beginPath()
    context.moveTo(Math.round(x) + 0.5, view.top)
    context.lineTo(Math.round(x) + 0.5, view.bottom)
    context.stroke()
  }
  const origin = round.battlePath[0]
  if (
    origin !== undefined &&
    (round.phase === 'lock' || round.phase === 'battle' || round.phase === 'result')
  ) {
    const originY = mapY(origin, view)
    if (originY > view.top && originY < view.bottom) {
      context.globalAlpha = 0.2
      context.strokeStyle = palette.muted
      context.setLineDash([2, 7])
      context.beginPath()
      context.moveTo(view.left, Math.round(originY) + 0.5)
      context.lineTo(view.right, Math.round(originY) + 0.5)
      context.stroke()
      context.setLineDash([])
      context.globalAlpha = 0.34
      context.fillStyle = palette.muted
      context.font = '600 8px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.textAlign = 'right'
      context.textBaseline = 'bottom'
      context.fillText('OPEN', view.right - 3, originY - 2)
    }
  }
  context.restore()

  const stormStrength = round.phase === 'battle' ? 1 : round.phase === 'lock' ? 0.7 : 0.36
  const time = reducedMotion ? 0.36 : now / 1_000
  context.save()
  context.strokeStyle = palette.muted
  context.lineWidth = 1
  context.globalAlpha = 0.09 * stormStrength
  const seed = hashString(round.seed)
  const rainCount = width < 560 ? 28 : 54
  for (let index = 0; index < rainCount; index += 1) {
    const unitX = ((seed + index * 2_653_443_761) >>> 0) / 4_294_967_295
    const unitY = ((seed ^ (index * 1_597_334_677)) >>> 0) / 4_294_967_295
    const x = (unitX * width + time * (18 + (index % 7))) % (width + 30) - 15
    const y = (unitY * height + time * (52 + (index % 11) * 3)) % (height + 30) - 15
    context.beginPath()
    context.moveTo(x, y)
    context.lineTo(x - 4, y + 10)
    context.stroke()
  }
  context.restore()

  const vignette = context.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.16,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72,
  )
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(0,0,0,0.64)')
  context.fillStyle = vignette
  context.fillRect(0, 0, width, height)
}

function drawDeckClock(
  context: CanvasRenderingContext2D,
  round: RoundState,
  width: number,
  palette: ArenaPalette,
): void {
  const compact = width < 560
  const segmentWidth = compact ? 22 : 30
  const gap = 4
  const totalWidth = segmentWidth * 4 + gap * 3
  const startX = (width - totalWidth) / 2
  const maxVariance = Math.max(...round.deck.variance)
  context.save()
  for (let index = 0; index < round.deck.variance.length; index += 1) {
    const variance = round.deck.variance[index] ?? 0
    const height = 3 + (variance / Math.max(EPSILON, maxVariance)) * 7
    const x = startX + index * (segmentWidth + gap)
    const y = 21 - height / 2
    roundedRect(context, x, y, segmentWidth, height, 2)
    context.globalAlpha = index / 4 <= round.phaseProgress ? 0.92 : 0.26
    context.fillStyle = `hsl(${round.deck.hue} 82% 64%)`
    context.fill()
  }
  context.globalAlpha = 0.6
  context.fillStyle = palette.muted
  context.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.textAlign = 'center'
  context.textBaseline = 'top'
  context.fillText('STORM PROFILE', width / 2, 30)
  context.restore()
}

interface FormingCandle {
  price: number
  high: number
  low: number
}

/**
 * Deterministic intra-candle tick path for the printing tape. The price
 * leaves the open, tags one extreme, retraces through the other, and settles
 * at the close, with a small bounded wobble on top. Purely cosmetic: at
 * progress 1 the running OHLC equals the candle exactly.
 */
function formingCandleShape(candle: Candle, progress: number, key: string): FormingCandle {
  const rising = candle.close >= candle.open
  // Rising candles usually set their low early and their high late.
  const upFirst = hashUnit(`${key}:order`) < (rising ? 0.3 : 0.7)
  const firstAt = 0.22 + hashUnit(`${key}:t1`) * 0.2
  const secondAt = 0.58 + hashUnit(`${key}:t2`) * 0.22
  const times = [0, firstAt, secondAt, 1]
  const values = [
    candle.open,
    upFirst ? candle.high : candle.low,
    upFirst ? candle.low : candle.high,
    candle.close,
  ]
  const span = Math.max(EPSILON, candle.high - candle.low)
  const phase = hashUnit(`${key}:phase`) * TAU

  const priceAt = (t: number): number => {
    let base = candle.close
    for (let segment = 0; segment < 3; segment += 1) {
      if (t <= (times[segment + 1] ?? 1)) {
        const start = times[segment] ?? 0
        const end = times[segment + 1] ?? 1
        const local = (t - start) / Math.max(EPSILON, end - start)
        base = lerp(values[segment] ?? candle.open, values[segment + 1] ?? candle.close, local)
        break
      }
    }
    const wobble = Math.sin(t * 31 + phase) * span * 0.07 * Math.sin(Math.PI * t)
    return clamp(base + wobble, candle.low, candle.high)
  }

  const price = priceAt(progress)
  let high = Math.max(candle.open, price)
  let low = Math.min(candle.open, price)
  const samples = 24
  for (let sample = 1; sample < samples; sample += 1) {
    const value = priceAt((sample / samples) * progress)
    high = Math.max(high, value)
    low = Math.min(low, value)
  }
  // Land the exact extremes the moment the path passes their anchors so the
  // finished candle matches its true OHLC with no completion pop.
  if (progress >= firstAt) {
    high = Math.max(high, values[1] ?? high)
    low = Math.min(low, values[1] ?? low)
  }
  if (progress >= secondAt) {
    high = Math.max(high, values[2] ?? high)
    low = Math.min(low, values[2] ?? low)
  }
  return { price, high, low }
}

function drawCandles(
  context: CanvasRenderingContext2D,
  round: RoundState,
  view: ArenaView,
  palette: ArenaPalette,
  reducedMotion: boolean,
): void {
  if (round.approach.length === 0) return
  if (round.phase === 'home' || round.phase === 'deck') return
  const battle = round.phase === 'battle' || round.phase === 'result'
  // Once the storm is live the battle chart owns the full time axis; the
  // approach tape would only sit underneath it as noise.
  if (battle) return
  const availableWidth = view.right - view.left
  const chartRight = battle ? lerp(view.left, view.right, 0.48) : lerp(view.left, view.right, 0.82)
  const chartWidth = chartRight - view.left
  const spacing = chartWidth / Math.max(1, round.approach.length)
  const bodyWidth = clamp(spacing * 0.52, 3, 11)
  // The tape prints like a live feed: one candle forms at a time from a
  // deterministic intra-candle tick path — the price runs to one extreme,
  // retraces through the other, then settles at the close — so the body
  // flips direction mid-formation exactly like a real live candle.
  const revealFront = round.phase === 'approach' && !reducedMotion
    ? round.phaseProgress * (round.approach.length + 0.75)
    : round.approach.length
  const baseAlpha = battle ? 0.16 : round.phase === 'placement' ? 0.42 : 0.88
  context.save()
  for (let index = 0; index < round.approach.length; index += 1) {
    const candle = round.approach[index]
    if (!candle) continue
    const progress = clamp(revealFront - index, 0, 1)
    if (progress <= 0) continue
    const forming = progress < 1 && round.phase === 'approach'
    let closeValue = candle.close
    let highValue = candle.high
    let lowValue = candle.low
    if (forming) {
      const shape = formingCandleShape(candle, progress, `${round.seed}:approach:${index}`)
      closeValue = shape.price
      highValue = shape.high
      lowValue = shape.low
    }
    const x = view.left + spacing * (index + 0.5)
    const highY = mapY(highValue, view)
    const lowY = mapY(lowValue, view)
    const openY = mapY(candle.open, view)
    const closeY = mapY(closeValue, view)
    const rising = closeValue >= candle.open
    const color = rising ? palette.safe : palette.danger

    context.globalAlpha = forming ? Math.min(1, baseAlpha + 0.12) : baseAlpha
    context.strokeStyle = color
    context.lineWidth = 1.1
    context.beginPath()
    context.moveTo(x, highY)
    context.lineTo(x, lowY)
    context.stroke()

    const top = Math.min(openY, closeY)
    const height = Math.max(2, Math.abs(closeY - openY))
    if (forming) {
      context.shadowColor = color
      context.shadowBlur = 12
    }
    context.beginPath()
    context.rect(x - bodyWidth / 2, top, bodyWidth, height)
    if (rising) {
      context.fillStyle = palette.backgroundLift
      context.fill()
      context.strokeStyle = color
      context.lineWidth = 1.3
      context.stroke()
    } else {
      context.fillStyle = color
      context.fill()
      context.strokeStyle = palette.background
      context.lineWidth = 0.8
      context.stroke()
    }
    context.shadowBlur = 0

    if (forming) {
      // Tick marker riding the forming close, mirroring the battle head dot.
      context.globalAlpha = 0.95
      context.fillStyle = palette.lineCore
      context.beginPath()
      context.arc(x, closeY, 2.2, 0, TAU)
      context.fill()
    }
  }
  // This tape is the lead-in, not the round: watermark it as history and rule
  // a NOW divider where the player's option will go live.
  const tapeCenterX = (view.left + chartRight) / 2
  context.globalAlpha = 0.07
  context.fillStyle = palette.muted
  context.font = `900 ${clamp((chartRight - view.left) * 0.11, 22, 44)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText('HISTORY', tapeCenterX, (view.top + view.bottom) / 2)

  context.globalAlpha = 0.28
  context.strokeStyle = palette.muted
  context.setLineDash([3, 6])
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(Math.round(chartRight) + 0.5, view.top + 14)
  context.lineTo(Math.round(chartRight) + 0.5, view.bottom)
  context.stroke()
  context.setLineDash([])
  context.globalAlpha = 0.7
  context.fillStyle = palette.text
  context.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.textAlign = 'center'
  context.textBaseline = 'top'
  context.fillText('NOW', chartRight, view.top + 2)
  if (round.phase === 'placement') {
    context.globalAlpha = 0.5
    context.fillStyle = palette.muted
    context.textAlign = 'left'
    context.fillText('YOUR OPTION GOES LIVE HERE →', chartRight + 20, view.top + 2)
  }

  context.globalAlpha = 0.34
  context.fillStyle = palette.muted
  context.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.textAlign = 'left'
  context.textBaseline = 'bottom'
  context.fillText('HISTORY · THE TAPE BEFORE YOUR ROUND', view.left, view.bottom - 4)
  context.restore()

  if (!battle && availableWidth > 0 && revealFront >= round.approach.length) {
    const last = round.approach.at(-1)
    if (last) {
      const x = chartRight
      const y = mapY(last.close, view)
      context.save()
      context.fillStyle = palette.lineCore
      context.shadowColor = palette.line
      context.shadowBlur = 12
      context.beginPath()
      context.arc(x, y, 3, 0, TAU)
      context.fill()
      context.restore()
    }
  }
}

interface BattleTracePoint {
  value: number
  high: number
  low: number
}

function battlePoints(round: RoundState): BattleTracePoint[] {
  if (round.battlePath.length === 0) {
    return [{ value: round.lineValue, high: round.lineValue, low: round.lineValue }]
  }
  const requestedEnd = round.phase === 'result' ? round.battlePath.length : round.battleIndex + 1
  const end = clamp(requestedEnd, 1, round.battlePath.length)
  return round.battlePath.slice(0, end).map((value, index) => {
    const previous = round.battlePath[index - 1] ?? value
    const extrema = round.battleExtrema[index] ?? {
      high: Math.max(previous, value),
      low: Math.min(previous, value),
    }
    return { value, ...extrema }
  })
}

/**
 * The battle chart owns a fixed time axis: frame 0 starts at the left rail and
 * the final frame lands at 70% width, so the line marches toward the flag rail
 * instead of scrolling. One projection is shared by the line, the candles, and
 * the barrier rules so time reads identically in every mode.
 */
function battleChartX(frame: number, round: RoundState, view: ArenaView): number {
  const steps = Math.max(2, round.battlePath.length)
  const endX = lerp(view.left, view.right, 0.7)
  return lerp(view.left + 6, endX, clamp(frame / (steps - 1), 0, 1))
}

function drawLineHead(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  view: ArenaView,
  palette: ArenaPalette,
  now: number,
  reducedMotion: boolean,
): void {
  const pulse = reducedMotion ? 0 : (Math.sin(now / 170) + 1) / 2
  context.save()
  context.setLineDash([5, 8])
  context.strokeStyle = palette.line
  context.globalAlpha = 0.2
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(x + 8, y)
  context.lineTo(view.right, y)
  context.stroke()
  context.setLineDash([])

  context.globalAlpha = 0.18 + pulse * 0.1
  context.fillStyle = palette.line
  context.beginPath()
  context.arc(x, y, 12 + pulse * 3, 0, TAU)
  context.fill()
  context.globalAlpha = 1
  context.fillStyle = palette.lineCore
  context.shadowColor = palette.line
  context.shadowBlur = 18
  context.beginPath()
  context.arc(x, y, 4.2, 0, TAU)
  context.fill()
  context.restore()
}

function drawLiveLine(
  context: CanvasRenderingContext2D,
  round: RoundState,
  view: ArenaView,
  palette: ArenaPalette,
  now: number,
  reducedMotion: boolean,
): { x: number; y: number } {
  const path = battlePoints(round)
  const xForIndex = (index: number): number =>
    path.length === 1
      ? battleChartX(0, round, view)
      : battleChartX(index, round, view)

  const trace = (): void => {
    context.beginPath()
    for (let index = 0; index < path.length; index += 1) {
      const x = xForIndex(index)
      const y = mapY(path[index]?.value ?? round.lineValue, view)
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
  }

  context.save()
  context.strokeStyle = palette.lineCore
  context.lineWidth = 1
  context.globalAlpha = 0.22
  for (let index = 1; index < path.length; index += 1) {
    const point = path[index]
    if (!point) continue
    const x = xForIndex(index)
    context.beginPath()
    context.moveTo(x, mapY(point.high, view))
    context.lineTo(x, mapY(point.low, view))
    context.stroke()
  }
  context.lineJoin = 'round'
  context.lineCap = 'round'
  context.strokeStyle = palette.line
  context.globalAlpha = 0.16
  context.lineWidth = 14
  context.shadowColor = palette.line
  context.shadowBlur = 22
  trace()
  context.stroke()

  context.globalAlpha = 0.72
  context.lineWidth = 4
  context.shadowBlur = 11
  trace()
  context.stroke()

  context.globalAlpha = 1
  context.strokeStyle = palette.lineCore
  context.lineWidth = 1.4
  context.shadowBlur = 5
  trace()
  context.stroke()
  context.restore()

  const headX = xForIndex(path.length - 1)
  const currentY = mapY(round.lineValue, view)
  drawLineHead(context, headX, currentY, view, palette, now, reducedMotion)
  return { x: headX, y: currentY }
}

/** Frames folded into one battle candle (241 frames ≈ 40 candles a round). */
const BATTLE_CANDLE_FRAMES = 6

function drawLiveCandles(
  context: CanvasRenderingContext2D,
  round: RoundState,
  view: ArenaView,
  palette: ArenaPalette,
  now: number,
  reducedMotion: boolean,
): { x: number; y: number } {
  const path = battlePoints(round)
  const lastIndex = path.length - 1
  const buckets = Math.max(1, Math.ceil(lastIndex / BATTLE_CANDLE_FRAMES))
  const spacing =
    battleChartX(BATTLE_CANDLE_FRAMES, round, view) - battleChartX(0, round, view)
  const bodyWidth = clamp(spacing * 0.62, 2.5, 12)

  context.save()
  context.lineCap = 'round'
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const startFrame = bucket * BATTLE_CANDLE_FRAMES
    const endFrame = Math.min(lastIndex, startFrame + BATTLE_CANDLE_FRAMES)
    if (endFrame <= startFrame) continue
    const open = path[startFrame]?.value ?? round.lineValue
    const close = path[endFrame]?.value ?? open
    let high = Math.max(open, close)
    let low = Math.min(open, close)
    for (let frame = startFrame + 1; frame <= endFrame; frame += 1) {
      const point = path[frame]
      if (!point) continue
      high = Math.max(high, point.high)
      low = Math.min(low, point.low)
    }

    // Anchor every candle at its bucket's final center so the forming candle
    // fills in place instead of sliding right as frames accumulate.
    const bucketEnd = Math.min(round.battlePath.length - 1, startFrame + BATTLE_CANDLE_FRAMES)
    const x = (battleChartX(startFrame, round, view) + battleChartX(bucketEnd, round, view)) / 2
    const rising = close >= open
    const color = rising ? palette.safe : palette.danger
    const live = round.phase === 'battle' && endFrame === lastIndex

    context.strokeStyle = color
    context.globalAlpha = live ? 0.95 : 0.66
    context.lineWidth = 1.2
    context.shadowBlur = 0
    context.beginPath()
    context.moveTo(x, mapY(high, view))
    context.lineTo(x, mapY(low, view))
    context.stroke()

    const openY = mapY(open, view)
    const closeY = mapY(close, view)
    const top = Math.min(openY, closeY)
    const height = Math.max(2, Math.abs(closeY - openY))
    context.globalAlpha = live ? 1 : 0.88
    context.fillStyle = color
    if (live) {
      context.shadowColor = color
      context.shadowBlur = 14
    }
    context.beginPath()
    context.rect(x - bodyWidth / 2, top, bodyWidth, height)
    context.fill()
    context.shadowBlur = 0
    context.globalAlpha = live ? 0.9 : 0.4
    context.strokeStyle = palette.background
    context.lineWidth = 0.8
    context.stroke()
  }
  context.restore()

  const headX = battleChartX(lastIndex, round, view)
  const currentY = mapY(round.lineValue, view)
  drawLineHead(context, headX, currentY, view, palette, now, reducedMotion)
  return { x: headX, y: currentY }
}

/**
 * Staggered entrance for bot pennants: hidden while the tape prints, then a
 * quick deterministic pop-in as the placement window opens.
 */
function botRevealFactor(
  contender: Contender,
  round: RoundState,
  reducedMotion: boolean,
): number {
  if (contender.isPlayer) return 1
  if (round.phase === 'home' || round.phase === 'deck' || round.phase === 'approach') return 0
  if (round.phase !== 'placement' || reducedMotion) return 1
  const delay = hashUnit(`${contender.id}:reveal`) * 0.18
  return clamp((round.phaseProgress - delay) / 0.06, 0, 1)
}

function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}

/**
 * A planted flag is a price barrier, not a moment: rule its level across the
 * full chart so survival reads as "the line never touches my line."
 */
function drawBarrierLines(
  context: CanvasRenderingContext2D,
  round: RoundState,
  view: ArenaView,
  palette: ArenaPalette,
  now: number,
  reducedMotion: boolean,
): void {
  if (round.phase === 'home' || round.phase === 'deck' || round.phase === 'approach') return
  const player = playerFor(round)

  context.save()
  for (const contender of round.contenders) {
    if (contender.isPlayer || contender.outcome !== 'active') continue
    if (botRevealFactor(contender, round, reducedMotion) < 1) continue
    const y = mapY(contender.barrier, view)
    if (y < view.top || y > view.bottom) continue
    context.strokeStyle = contender.color || palette.bot
    context.globalAlpha = 0.14
    context.lineWidth = 1
    context.setLineDash([2, 6])
    context.beginPath()
    context.moveTo(view.left, Math.round(y) + 0.5)
    context.lineTo(view.right, Math.round(y) + 0.5)
    context.stroke()
  }
  context.setLineDash([])

  if (player && player.outcome === 'active' && player.distance > EPSILON) {
    const y = mapY(player.barrier, view)
    if (y >= view.top && y <= view.bottom) {
      // Live odds on the line itself: strike odds while placing, hold odds
      // while the storm runs.
      let oddsLabel = ''
      let danger = 0
      if (round.phase === 'placement' || round.phase === 'lock') {
        try {
          const survival = estimateSurvivalProbability(
            player.distance,
            round.lineValue,
            player.side,
            round.lineValueFixed,
          )
          oddsLabel = ` · ${Math.round((1 - survival) * 100)}% STRIKE ODDS`
          danger = 1 - survival
        } catch {
          oddsLabel = ''
        }
      } else if (round.phase === 'battle') {
        try {
          const quote = getContenderEscapeQuote(round, 'player')
          if (quote) {
            oddsLabel = ` · HOLDS ${quote.percentOfMaximum.toFixed(0)}%`
            danger = 1 - quote.survivalProbability
          }
        } catch {
          oddsLabel = ''
        }
      }
      const lineHeadY = mapY(round.lineValue, view)
      const proximity = round.phase === 'battle'
        ? clamp(1 - Math.abs(lineHeadY - y) / 64, 0, 1)
        : 0
      const tension = Math.max(proximity, round.phase === 'battle' ? clamp((danger - 0.6) * 2.5, 0, 1) : 0)
      const flicker = tension > 0 && !reducedMotion ? (Math.sin(now / 90) + 1) / 2 : 0

      // Shade the far side of the barrier: the storm reaching that band is a strike.
      const bandHeight = 26 + tension * 10
      const shadeTop = player.side === 'upper' ? Math.max(view.top, y - bandHeight) : y
      const shade = context.createLinearGradient(
        0,
        player.side === 'upper' ? y : y + bandHeight,
        0,
        player.side === 'upper' ? y - bandHeight : y,
      )
      shade.addColorStop(0, `rgba(255,95,103,${0.16 + tension * 0.18})`)
      shade.addColorStop(1, 'rgba(255,95,103,0)')
      context.fillStyle = shade
      context.fillRect(view.left, shadeTop, view.right - view.left, bandHeight)

      context.strokeStyle = tension > 0.5 ? palette.danger : palette.player
      context.globalAlpha = 0.66 + tension * (0.2 + flicker * 0.14)
      context.lineWidth = 1.6 + tension * 1.2
      context.shadowColor = tension > 0.5 ? palette.danger : palette.player
      context.shadowBlur = 8 + tension * 10
      context.beginPath()
      context.moveTo(view.left, Math.round(y) + 0.5)
      context.lineTo(view.right, Math.round(y) + 0.5)
      context.stroke()
      context.shadowBlur = 0

      context.globalAlpha = 0.9
      context.fillStyle = tension > 0.5 ? palette.danger : palette.player
      context.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.textAlign = 'left'
      context.textBaseline = player.side === 'upper' ? 'bottom' : 'top'
      context.fillText(
        `YOUR ${player.side === 'upper' ? 'CALL' : 'PUT'} @ ${player.barrier.toFixed(2)}${oddsLabel}`,
        view.left + 4,
        y + (player.side === 'upper' ? -4 : 4),
      )
    }
  }
  context.restore()
}

function flagXForIdentity(id: string, isPlayer: boolean, view: ArenaView): number {
  if (isPlayer) return view.right - 34
  // Bot barriers carry the meaningful vertical position. Give their pennants a
  // much wider deterministic horizontal field so a 20-contender cluster stays
  // readable without implying a different risk or changing any round input.
  const spread = Math.min(360, (view.right - view.left) * 0.44)
  return view.right - 54 - hashUnit(id) * spread
}

function flagX(contender: Contender, view: ArenaView): number {
  return flagXForIdentity(contender.id, contender.isPlayer, view)
}

function drawCrowdHeat(
  context: CanvasRenderingContext2D,
  round: RoundState,
  contenders: Contender[],
  view: ArenaView,
  palette: ArenaPalette,
): void {
  if (round.phase === 'home' || round.phase === 'deck' || round.phase === 'approach') return
  const active = contenders
    .filter((contender) => contender.outcome === 'active')
    .map((contender) => ({ contender, x: flagX(contender, view), y: mapY(contender.barrier, view) }))
    .sort((first, second) => first.y - second.y)
  if (active.length < 2) return

  const groups: typeof active[] = []
  for (const item of active) {
    const current = groups.at(-1)
    if (current && Math.abs((current.at(-1)?.y ?? item.y) - item.y) < 18) current.push(item)
    else groups.push([item])
  }

  context.save()
  for (const group of groups) {
    if (group.length < 2) continue
    const centerX = group.reduce((total, item) => total + item.x, 0) / group.length
    const centerY = group.reduce((total, item) => total + item.y, 0) / group.length
    const radius = 34 + group.length * 7
    context.save()
    context.translate(centerX, centerY)
    context.scale(1.8, 0.62)
    const haze = context.createRadialGradient(0, 0, 0, 0, 0, radius)
    haze.addColorStop(0, palette.danger)
    haze.addColorStop(0.46, palette.danger)
    haze.addColorStop(1, 'rgba(0,0,0,0)')
    context.globalAlpha = clamp(0.04 + group.length * 0.018, 0.07, 0.18)
    context.fillStyle = haze
    context.beginPath()
    context.arc(0, 0, radius, 0, TAU)
    context.fill()
    context.restore()
  }
  context.restore()
}

function pennantPath(
  context: CanvasRenderingContext2D,
  contender: Contender,
  width: number,
  height: number,
): void {
  const direction = contender.persona === 'Contrarian' ? -1 : 1
  const startX = direction > 0 ? 0 : -width
  const endX = direction > 0 ? width : 0
  context.beginPath()
  switch (contender.persona) {
    case 'Sniper':
      context.moveTo(0, -height / 2)
      context.lineTo(endX, 0)
      context.lineTo(0, height / 2)
      break
    case 'Greedlord':
      context.moveTo(startX, -height / 2)
      context.lineTo(endX, -height / 2)
      context.lineTo(endX - direction * width * 0.2, 0)
      context.lineTo(endX, height / 2)
      context.lineTo(startX, height / 2)
      break
    case 'Momentum':
      context.moveTo(startX, -height / 2)
      context.lineTo(endX - direction * width * 0.2, -height / 2)
      context.lineTo(endX, 0)
      context.lineTo(endX - direction * width * 0.2, height / 2)
      context.lineTo(startX, height / 2)
      context.lineTo(startX + direction * width * 0.18, 0)
      break
    case 'Chaos':
      context.moveTo(startX, -height / 2)
      context.lineTo(startX + direction * width * 0.42, -height * 0.22)
      context.lineTo(endX, -height / 2)
      context.lineTo(endX - direction * width * 0.16, height * 0.08)
      context.lineTo(startX + direction * width * 0.58, height / 2)
      context.lineTo(startX, height / 2)
      break
    default:
      context.moveTo(startX, -height / 2)
      context.lineTo(endX, -height / 2)
      context.lineTo(endX, height / 2)
      context.lineTo(startX, height / 2)
  }
  context.closePath()
}

function drawMimicEcho(
  context: CanvasRenderingContext2D,
  contender: Contender,
  width: number,
  height: number,
  palette: ArenaPalette,
): void {
  context.save()
  context.strokeStyle = palette.lineCore
  for (let echo = 2; echo >= 1; echo -= 1) {
    context.save()
    context.translate(-echo * 6, (contender.side === 'upper' ? 1 : -1) * echo * 2.5)
    context.globalAlpha = 0.13 + echo * 0.08
    context.lineWidth = 1
    context.setLineDash([3, 3 + echo])
    pennantPath(context, contender, width, height)
    context.stroke()
    context.restore()
  }
  context.restore()
}

function drawTellBadge(
  context: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
  palette: ArenaPalette,
): void {
  context.save()
  context.font = '900 9px ui-monospace, SFMono-Regular, Menlo, monospace'
  const width = Math.max(42, Math.ceil(context.measureText(label).width) + 12)
  roundedRect(context, x, y, width, 18, 5)
  context.globalAlpha = 0.94
  context.fillStyle = palette.backgroundLift
  context.fill()
  context.globalAlpha = 0.88
  context.strokeStyle = palette.lineCore
  context.lineWidth = 1.2
  context.stroke()
  context.globalAlpha = 1
  context.fillStyle = palette.text
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(label, x + width / 2, y + 9.5)
  context.restore()
}

function drawGreedlordFlash(
  context: CanvasRenderingContext2D,
  contender: Contender,
  width: number,
  height: number,
  palette: ArenaPalette,
): void {
  context.save()
  context.globalAlpha = 0.92
  context.strokeStyle = palette.lineCore
  context.lineWidth = 3.2
  context.shadowColor = palette.lineCore
  context.shadowBlur = 13
  pennantPath(context, contender, width, height)
  context.stroke()
  context.shadowBlur = 0
  context.lineWidth = 1.5
  for (const [fromX, fromY, toX, toY] of [
    [width + 3, -height * 0.72, width + 8, -height * 1.05],
    [width + 5, 0, width + 11, 0],
    [width + 3, height * 0.72, width + 8, height * 1.05],
  ] as const) {
    context.beginPath()
    context.moveTo(fromX, fromY)
    context.lineTo(toX, toY)
    context.stroke()
  }
  context.restore()
}

function drawChaosTicks(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: ArenaPalette,
): void {
  context.save()
  context.globalAlpha = 0.86
  context.strokeStyle = palette.lineCore
  context.lineWidth = 1.2
  context.setLineDash([3, 2])
  for (let index = 0; index < 3; index += 1) {
    const y = -height * 0.55 + index * height * 0.55
    context.beginPath()
    context.moveTo(width + 2 + index * 2, y)
    context.lineTo(width + 8 + index * 2, y)
    context.stroke()
  }
  context.setLineDash([])
  context.restore()
}

function drawFlag(
  context: CanvasRenderingContext2D,
  contender: Contender,
  view: ArenaView,
  palette: ArenaPalette,
  now: number,
  reducedMotion: boolean,
  masteryLevel: number,
  tell: PersonaTellState,
  entrance = 1,
): void {
  const x = flagX(contender, view)
  const y = mapY(contender.barrier, view)
  const player = contender.isPlayer
  const width = player ? 43 : contender.persona === 'Turtle' ? 34 : 30
  const height = player ? 21 : 15
  const active = contender.outcome === 'active'
  const survived = contender.outcome === 'survived'
  const escaped = contender.outcome === 'escaped'
  const color = player ? palette.player : contender.color || palette.bot
  const pulse = active && player && !reducedMotion ? 1 + Math.sin(now / 230) * 0.04 : 1
  const entranceScale = entrance >= 1 ? 1 : Math.max(0.05, easeOutBack(entrance))

  context.save()
  context.translate(x + tell.chaosOffset.x, y + tell.chaosOffset.y)
  context.scale(pulse * entranceScale, pulse * entranceScale)

  if (escaped) {
    context.globalAlpha = player ? 0.92 : 0.58
    context.strokeStyle = player ? palette.lineCore : palette.line
    context.fillStyle = palette.backgroundLift
    context.lineWidth = player ? 2.2 : 1.4
    context.shadowColor = palette.line
    context.shadowBlur = player ? 16 : 7
    context.beginPath()
    context.arc(0, 0, player ? 12 : 8, 0, TAU)
    context.fill()
    context.stroke()
    context.shadowBlur = 0
    context.beginPath()
    context.moveTo(-4, 0)
    context.lineTo(5, 0)
    context.moveTo(2, -4)
    context.lineTo(6, 0)
    context.lineTo(2, 4)
    context.stroke()
    context.fillStyle = player ? palette.player : palette.muted
    context.font = `800 ${player ? 10 : 8}px ui-monospace, SFMono-Regular, Menlo, monospace`
    context.textAlign = 'center'
    context.textBaseline = 'bottom'
    context.fillText(player ? 'BANKED' : 'OUT', 0, -15)
    context.restore()
    return
  }

  if (!active && !survived) {
    context.globalAlpha = 0.52
    context.strokeStyle = palette.danger
    context.lineWidth = 1.5
    context.beginPath()
    context.moveTo(-5, -5)
    context.lineTo(5, 5)
    context.moveTo(5, -5)
    context.lineTo(-5, 5)
    context.stroke()
    context.restore()
    return
  }

  context.strokeStyle = player ? palette.lineCore : color
  context.lineWidth = player ? 2.2 : 1.2
  context.globalAlpha = player ? 0.92 : 0.62
  context.beginPath()
  context.moveTo(0, -height * 0.9)
  context.lineTo(0, height * 0.95)
  context.stroke()

  if (tell.mimicEcho) {
    drawMimicEcho(context, contender, width, height, palette)
  }

  context.globalAlpha = active ? 0.96 : 0.82
  context.fillStyle = color
  context.strokeStyle = player ? palette.lineCore : palette.background
  context.lineWidth = player ? 1.5 : 1
  context.shadowColor = color
  context.shadowBlur = player ? 18 : survived ? 14 : 6
  pennantPath(context, contender, width, height)
  context.fill()
  context.shadowBlur = 0
  context.stroke()

  if (tell.greedlordFlash) {
    drawGreedlordFlash(context, contender, width, height, palette)
  }

  if (tell.chaosTicks) {
    drawChaosTicks(context, width, height, palette)
  }

  if (player && masteryLevel >= 1) {
    // Signal pennant: a color-independent split-chevron earned at Scout.
    context.globalAlpha = 0.92
    context.strokeStyle = palette.lineCore
    context.lineWidth = 1.45
    context.beginPath()
    context.moveTo(width * 0.42, -height * 0.42)
    context.lineTo(width * 0.68, 0)
    context.lineTo(width * 0.42, height * 0.42)
    context.stroke()
    context.fillStyle = palette.line
    context.beginPath()
    context.arc(width * 0.79, 0, 2.2, 0, TAU)
    context.fill()
  }

  if (contender.persona === 'Mimic' && !player) {
    context.globalAlpha = 0.52
    context.strokeStyle = palette.lineCore
    context.beginPath()
    context.moveTo(5, -height * 0.2)
    context.lineTo(width - 5, -height * 0.2)
    context.stroke()
  }

  context.globalAlpha = 0.94
  context.fillStyle = palette.background
  context.font = `800 ${player ? 10 : 8}px ui-monospace, SFMono-Regular, Menlo, monospace`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(player ? 'YOU' : `${contender.risk.toFixed(1)}×`, width / 2, 0)

  context.globalAlpha = player ? 0.96 : 0.78
  context.fillStyle = player ? palette.player : palette.muted
  context.font = `800 ${player ? 11 : 9}px ui-monospace, SFMono-Regular, Menlo, monospace`
  context.textAlign = 'right'
  context.textBaseline = 'bottom'
  context.fillText(player ? `${contender.risk.toFixed(1)}×` : 'BOT', -5, -height / 2 - 2)

  if (survived) {
    context.globalAlpha = 0.62
    context.strokeStyle = palette.safe
    context.lineWidth = 2
    context.beginPath()
    context.arc(width / 2, 0, Math.max(width, height) * 0.72, 0, TAU)
    context.stroke()
  }
  if (tell.greedlordTaunt) {
    const badgeY = contender.side === 'upper' ? height / 2 + 7 : -height / 2 - 25
    drawTellBadge(context, tell.greedlordTaunt, -21, badgeY, palette)
  }
  if (tell.lateBidSeconds !== null) {
    drawTellBadge(context, `LOCK ${tell.lateBidSeconds}`, -54, -9, palette)
  }
  context.restore()
}

function drawPlayerPressureTrail(
  context: CanvasRenderingContext2D,
  round: RoundState,
  view: ArenaView,
  palette: ArenaPalette,
  now: number,
  reducedMotion: boolean,
): void {
  const player = round.contenders.find(
    (contender) => contender.isPlayer && contender.outcome === 'active',
  )
  if (!player) return
  const x = flagX(player, view)
  const y = mapY(player.barrier, view)
  const pulse = reducedMotion ? 0.5 : (Math.sin(now / 260) + 1) / 2
  const direction = player.side === 'upper' ? 1 : -1

  context.save()
  context.lineCap = 'round'
  for (let index = 0; index < 3; index += 1) {
    const offset = 9 + index * 8 + pulse * 3
    context.globalAlpha = 0.22 - index * 0.045
    context.strokeStyle = index === 0 ? palette.player : palette.line
    context.lineWidth = 2.2 - index * 0.45
    context.beginPath()
    context.moveTo(x - 8 - offset, y + direction * (index - 1) * 4)
    context.quadraticCurveTo(
      x - offset * 0.58,
      y - direction * (5 + index * 2),
      x - 5,
      y,
    )
    context.stroke()
  }
  context.restore()
}

function drawFlags(
  context: CanvasRenderingContext2D,
  round: RoundState,
  view: ArenaView,
  palette: ArenaPalette,
  now: number,
  reducedMotion: boolean,
  mutedFlash: boolean,
  masteryLevel: number,
): void {
  drawCrowdHeat(context, round, round.contenders, view, palette)
  if (masteryLevel >= 2) {
    drawPlayerPressureTrail(context, round, view, palette, now, reducedMotion)
  }
  const ordered = [...round.contenders].sort((first, second) => {
    if (first.isPlayer) return 1
    if (second.isPlayer) return -1
    return first.barrier - second.barrier
  })
  for (const contender of ordered) {
    const entrance = botRevealFactor(contender, round, reducedMotion)
    if (entrance <= 0) continue
    const tell = derivePersonaTell(contender, {
      animationTimeMs: now,
      mutedFlash,
      phase: round.phase,
      phaseDuration: round.phaseDuration,
      reducedMotion,
      timeRemaining: round.timeRemaining,
    })
    drawFlag(context, contender, view, palette, now, reducedMotion, masteryLevel, tell, entrance)
  }
}

function drawImpacts(
  context: CanvasRenderingContext2D,
  impacts: ImpactBurst[],
  view: ArenaView,
  palette: ArenaPalette,
  now: number,
  mutedFlash: boolean,
  reducedMotion: boolean,
  masteryLevel: number,
): void {
  for (const impact of impacts) {
    const rawAge = reducedMotion ? 0.32 : (now - impact.startAt) / 760
    if (rawAge < 0 || rawAge > 1) continue
    const age = clamp(rawAge, 0, 1)
    const x = flagXForIdentity(impact.contenderId, impact.isPlayer, view)
    const y = mapY(impact.barrier, view)
    const outward = impact.side === 'upper' ? -Math.PI / 2 : Math.PI / 2
    const expansion = smoothstep(age)

    context.save()
    context.translate(x, y)
    const flashAlpha = (mutedFlash ? 0.08 : 0.26) * (1 - smoothstep(age * 2.4))
    context.globalAlpha = flashAlpha
    context.fillStyle = palette.lineCore
    context.beginPath()
    context.arc(0, 0, 18 + expansion * 34, 0, TAU)
    context.fill()

    const masteredImpact = impact.isPlayer && masteryLevel >= 3
    context.globalAlpha = (1 - age) * (masteredImpact ? 0.94 : 0.72)
    context.strokeStyle = impact.color || palette.danger
    context.lineWidth = (masteredImpact ? 3.2 : 2.2) - age
    context.beginPath()
    context.arc(0, 0, 7 + expansion * (masteredImpact ? 44 : 30), 0, TAU)
    context.stroke()

    if (masteredImpact) {
      context.globalAlpha = (1 - age) * 0.5
      context.strokeStyle = palette.player
      context.lineWidth = 1.2
      context.beginPath()
      context.arc(0, 0, 14 + expansion * 58, 0, TAU)
      context.stroke()
    }

    const shardCount = masteredImpact ? 34 : 22
    for (let index = 0; index < shardCount; index += 1) {
      const random = hashUnit(`${impact.id}:${index}`)
      const secondRandom = hashUnit(`${index}:${impact.id}:speed`)
      const angle = outward + (random - 0.5) * 2.35
      const distance = expansion * (18 + secondRandom * 66)
      const shardX = Math.cos(angle) * distance
      const shardY = Math.sin(angle) * distance + age * age * 16
      const length = 2 + secondRandom * 6
      context.globalAlpha = (1 - age) * (0.34 + secondRandom * 0.62)
      context.strokeStyle = index % 3 === 0 ? palette.lineCore : impact.color || palette.danger
      context.lineWidth = index % 4 === 0 ? 2 : 1
      context.beginPath()
      context.moveTo(shardX, shardY)
      context.lineTo(
        shardX - Math.cos(angle) * length,
        shardY - Math.sin(angle) * length,
      )
      context.stroke()
    }
    context.restore()
  }
}

function drawStormboundFrame(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: ArenaPalette,
): void {
  context.save()
  const gradient = context.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, palette.player)
  gradient.addColorStop(0.45, palette.line)
  gradient.addColorStop(1, palette.safe)
  context.strokeStyle = gradient
  context.lineWidth = 2
  context.globalAlpha = 0.72
  context.shadowColor = palette.line
  context.shadowBlur = 13
  roundedRect(context, 5, 5, width - 10, height - 10, 14)
  context.stroke()
  context.shadowBlur = 0
  context.globalAlpha = 0.35
  context.setLineDash([3, 9])
  roundedRect(context, 10, 10, width - 20, height - 20, 11)
  context.stroke()
  context.restore()
}

function drawPointerPreview(
  context: CanvasRenderingContext2D,
  pointer: PointerPreview,
  round: RoundState,
  view: ArenaView,
  palette: ArenaPalette,
): void {
  if (!pointer.visible || round.phase !== 'placement') return
  const y = clamp(pointer.y, view.top, view.bottom)
  const side: FlagSide = y <= view.lineY ? 'upper' : 'lower'
  context.save()
  context.setLineDash([4, 5])
  context.strokeStyle = palette.player
  context.globalAlpha = pointer.dragging ? 0.68 : 0.32
  context.lineWidth = 1
  context.beginPath()
  // Preview the full barrier rule: the flag claims a level for the whole
  // round, not a point, so the guide spans the entire chart.
  context.moveTo(view.left, y)
  context.lineTo(view.right, y)
  context.stroke()
  context.setLineDash([])
  context.fillStyle = palette.player
  context.globalAlpha = pointer.dragging ? 0.9 : 0.5
  context.beginPath()
  context.arc(view.right - 8, y, pointer.dragging ? 4 : 3, 0, TAU)
  context.fill()
  // Quote the drag level live: the odds of the storm reaching this exact line.
  const optionKind = side === 'upper' ? 'CALL' : 'PUT'
  let dragLabel = optionKind
  try {
    const worldValue = view.worldMax
      - ((y - view.top) / Math.max(EPSILON, view.bottom - view.top))
        * (view.worldMax - view.worldMin)
    const distance = Math.abs(worldValue - round.lineValue)
    if (distance > EPSILON) {
      const survival = estimateSurvivalProbability(distance, round.lineValue, side)
      dragLabel = `${optionKind} ${worldValue.toFixed(2)} · ${Math.round((1 - survival) * 100)}% STRIKE ODDS`
    }
  } catch {
    dragLabel = optionKind
  }
  context.fillStyle = pointer.dragging ? palette.player : palette.muted
  context.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.textAlign = 'right'
  context.textBaseline = side === 'upper' ? 'bottom' : 'top'
  context.fillText(dragLabel, view.right - 16, y + (side === 'upper' ? -5 : 5))
  context.restore()
}

const PHASE_LABELS: Record<GamePhase, string> = {
  home: 'STORM IDLE',
  deck: 'DECK REVEAL',
  approach: 'READ THE TAPE',
  placement: 'PLANT YOUR FLAG',
  lock: 'FLAGS LOCKED',
  battle: 'STORM LIVE',
  result: 'ROUND COMPLETE',
}

function drawHeader(
  context: CanvasRenderingContext2D,
  round: RoundState,
  width: number,
  view: ArenaView,
  palette: ArenaPalette,
): void {
  const compact = width < 560
  const active = round.contenders.filter((contender) => contender.outcome === 'active').length
  context.save()
  roundedRect(context, view.left, 12, compact ? 118 : 144, 30, 8)
  context.globalAlpha = 0.7
  context.fillStyle = palette.background
  context.fill()
  context.globalAlpha = 1
  context.fillStyle = round.phase === 'battle' ? palette.lineCore : palette.text
  context.font = `800 ${compact ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  context.fillText(PHASE_LABELS[round.phase], view.left + 10, 27)

  const rightWidth = compact ? 92 : 112
  roundedRect(context, view.right - rightWidth, 12, rightWidth, 30, 8)
  context.globalAlpha = 0.7
  context.fillStyle = palette.background
  context.fill()
  context.globalAlpha = 1
  context.textAlign = 'right'
  context.fillStyle = palette.text
  context.font = `800 ${compact ? 11 : 12}px ui-monospace, SFMono-Regular, Menlo, monospace`
  context.fillText(`${active}/${round.contenders.length}`, view.right - 10, 24)
  context.fillStyle = palette.muted
  context.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.fillText('FLAGS LIVE', view.right - 10, 34)
  context.restore()
}

function drawCenteredPanel(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: ArenaPalette,
  eyebrow: string,
  title: string,
  detail: string,
  accent: string,
): void {
  const panelWidth = Math.min(width - 40, 430)
  const panelHeight = Math.min(150, height * 0.28)
  const x = (width - panelWidth) / 2
  const y = (height - panelHeight) / 2
  context.save()
  context.shadowColor = accent
  context.shadowBlur = 28
  roundedRect(context, x, y, panelWidth, panelHeight, 16)
  context.globalAlpha = 0.86
  context.fillStyle = palette.background
  context.fill()
  context.shadowBlur = 0
  context.globalAlpha = 0.72
  context.strokeStyle = accent
  context.lineWidth = 1
  context.stroke()

  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = accent
  context.globalAlpha = 0.9
  context.font = '800 11px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.fillText(eyebrow, width / 2, y + 28)
  context.fillStyle = palette.text
  context.globalAlpha = 1
  context.font = `900 ${clamp(width * 0.055, 25, 40)}px ui-sans-serif, system-ui, sans-serif`
  context.fillText(title, width / 2, y + panelHeight * 0.53)
  context.fillStyle = palette.muted
  context.font = '600 12px ui-sans-serif, system-ui, sans-serif'
  context.fillText(detail, width / 2, y + panelHeight - 27)
  context.restore()
}

function drawPhaseOverlay(
  context: CanvasRenderingContext2D,
  round: RoundState,
  width: number,
  height: number,
  view: ArenaView,
  palette: ArenaPalette,
): void {
  const deckAccent = `hsl(${round.deck.hue} 82% 65%)`
  if (round.phase === 'deck') {
    drawCenteredPanel(
      context,
      width,
      height,
      palette,
      round.deck.kicker.toUpperCase(),
      round.deck.name,
      round.deck.tacticalHint,
      deckAccent,
    )
    return
  }
  if (round.phase === 'lock') {
    drawCenteredPanel(
      context,
      width,
      height,
      palette,
      'NO MORE MOVES',
      'FLAGS LOCKED',
      'Hold the line. Every touch is final.',
      palette.player,
    )
    return
  }
  if (round.phase === 'result' && round.summary) {
    const survived = round.summary.outcome === 'survived'
    const escaped = round.summary.outcome === 'escaped'
    drawCenteredPanel(
      context,
      width,
      height,
      palette,
      `RANK ${round.summary.rank} · ${round.summary.survived} SURVIVED`,
      survived ? 'YOU HELD' : escaped ? 'SCORE BANKED' : 'FLAG DOWN',
      `${Math.round(round.summary.score)} points · ${round.summary.multiplier.toFixed(1)}× risk`,
      survived ? palette.safe : escaped ? palette.line : palette.danger,
    )
    return
  }
  if (round.phase === 'home') {
    drawCenteredPanel(
      context,
      width,
      height,
      palette,
      'THE STORM IS WAITING',
      'STRIKEFALL',
      'Read the setup. Plant where others will not.',
      palette.line,
    )
    return
  }

  context.save()
  const bottomY =
    round.phase === 'placement'
      ? Math.min(height - (width < 560 ? 128 : 106), view.bottom + (width < 560 ? 62 : 44))
      : height - 18
  context.textAlign = 'center'
  context.textBaseline = 'bottom'
  if (round.phase === 'placement') {
    context.fillStyle = palette.text
    context.font = `800 ${width < 560 ? 12 : 13}px ui-sans-serif, system-ui, sans-serif`
    context.fillText('DRAG ABOVE OR BELOW THE LINE', width / 2, bottomY)
    context.fillStyle = palette.muted
    context.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.fillText('CLOSER PAYS MORE · CROWDS PAY LESS', width / 2, bottomY - 16)
  } else if (round.phase === 'battle' && round.timeRemaining <= 10_000) {
    context.fillStyle = palette.danger
    context.font = `900 ${width < 560 ? 16 : 19}px ui-monospace, SFMono-Regular, Menlo, monospace`
    context.fillText(
      `FINAL PRESSURE · ${Math.max(0, Math.ceil(round.timeRemaining / 1_000))}`,
      width / 2,
      bottomY,
    )
  } else if (round.phase === 'approach') {
    context.fillStyle = palette.muted
    context.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.fillText(round.deck.description.toUpperCase(), width / 2, bottomY)
  }
  context.restore()

  if (round.contenders.length === 0) {
    context.save()
    context.fillStyle = palette.muted
    context.font = '700 13px ui-sans-serif, system-ui, sans-serif'
    context.textAlign = 'center'
    context.fillText('Building the lobby…', width / 2, (view.top + view.bottom) / 2)
    context.restore()
  }
}

function drawFocusRing(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: ArenaPalette,
): void {
  context.save()
  context.strokeStyle = palette.player
  context.lineWidth = 3
  context.globalAlpha = 0.95
  roundedRect(context, 2.5, 2.5, width - 5, height - 5, 12)
  context.stroke()
  context.restore()
}

function drawArena(
  canvas: HTMLCanvasElement,
  round: RoundState,
  size: CanvasSize,
  palette: ArenaPalette,
  impacts: ImpactBurst[],
  options: DrawOptions,
  now: number,
  viewEase?: ViewEase | null,
): ArenaView | null {
  const context = canvas.getContext('2d')
  if (!context || size.width <= 1 || size.height <= 1) return null
  context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
  context.clearRect(0, 0, size.width, size.height)
  const view = buildView(round, size.width, size.height, impacts, now, viewEase)
  drawBackground(
    context,
    round,
    size.width,
    size.height,
    view,
    palette,
    now,
    options.reducedMotion,
  )
  drawDeckClock(context, round, size.width, palette)
  drawCandles(context, round, view, palette, options.reducedMotion)
  drawBarrierLines(context, round, view, palette, now, options.reducedMotion)
  if (options.chartStyle === 'candles') {
    drawLiveCandles(context, round, view, palette, now, options.reducedMotion)
  } else {
    drawLiveLine(context, round, view, palette, now, options.reducedMotion)
  }
  drawFlags(
    context,
    round,
    view,
    palette,
    now,
    options.reducedMotion,
    options.mutedFlash,
    options.masteryLevel,
  )
  drawImpacts(
    context,
    impacts,
    view,
    palette,
    now,
    options.mutedFlash,
    options.reducedMotion,
    options.masteryLevel,
  )
  drawPointerPreview(context, options.pointer, round, view, palette)
  drawHeader(context, round, size.width, view, palette)
  drawPhaseOverlay(context, round, size.width, size.height, view, palette)
  if (options.masteryLevel >= 4) {
    drawStormboundFrame(context, size.width, size.height, palette)
  }
  if (options.focused) drawFocusRing(context, size.width, size.height, palette)
  return view
}

function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

function phaseStatus(round: RoundState): string {
  const active = round.contenders.filter((contender) => contender.outcome === 'active').length
  const player = playerFor(round)
  const playerStatus = player
    ? player.outcome === 'hit'
      ? 'Your flag was hit.'
      : player.outcome === 'survived'
        ? 'Your flag survived.'
        : player.outcome === 'escaped'
          ? `You escaped with ${player.escape?.bankedScore ?? 0} points banked.`
        : `Your flag is ${player.side}, ${player.risk.toFixed(1)} times risk reward.`
    : 'Your flag is not planted yet.'
  return `${PHASE_LABELS[round.phase]}. ${active} of ${round.contenders.length} flags live. ${playerStatus}`
}

export function ArenaCanvas({
  round,
  onPlace,
  onCanvasReady,
  disabled = false,
  reducedMotion,
  mutedFlash = false,
  masteryLevel = 0,
  chartStyle = 'candles',
  className,
  ariaLabel = 'Strikefall arena',
}: ArenaCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const controlRef = useRef<HTMLDivElement>(null)
  const sizeRef = useRef<CanvasSize>({ width: 0, height: 0, dpr: 1 })
  const viewRef = useRef<ArenaView | null>(null)
  const renderOnceRef = useRef<(() => void) | null>(null)
  const pointerRef = useRef<PointerPreview>({ visible: false, dragging: false, y: 0 })
  const viewEaseRef = useRef<ViewEase>({ roundId: '', worldMin: 0, worldMax: 0, lastNow: 0 })
  const impactsRef = useRef<ImpactBurst[]>([])
  const previousOutcomesRef = useRef<Map<string, Contender['outcome']>>(new Map())
  const previousRoundRef = useRef(round.roundId)
  const [viewportRevision, setViewportRevision] = useState(0)
  const [focused, setFocused] = useState(false)
  const systemReducedMotion = useSystemReducedMotion()
  const shouldReduceMotion = reducedMotion ?? systemReducedMotion
  const cosmeticMasteryLevel = clamp(Math.floor(masteryLevel), 0, 4)
  const instructionsId = useId()
  const canPlace = !disabled && round.phase === 'placement' && Boolean(onPlace)
  const player = playerFor(round)
  const ariaMaximum = getPlacementMaxDistance(round)
  const signedPlayerDistance = player
    ? (player.side === 'upper' ? 1 : -1) * player.distance
    : 0

  const status = useMemo(
    () => phaseStatus(round),
    [round.phase, round.contenders],
  )

  useEffect(() => {
    onCanvasReady?.(canvasRef.current)
    return () => onCanvasReady?.(null)
  }, [onCanvasReady])

  useEffect(() => {
    const control = controlRef.current
    const canvas = canvasRef.current
    if (!control || !canvas) return

    const resize = (): void => {
      const bounds = control.getBoundingClientRect()
      const width = Math.max(1, Math.round(bounds.width || control.clientWidth || 720))
      const height = Math.max(1, Math.round(bounds.height || control.clientHeight || 560))
      const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5)
      const backingWidth = Math.round(width * dpr)
      const backingHeight = Math.round(height * dpr)
      if (canvas.width !== backingWidth) canvas.width = backingWidth
      if (canvas.height !== backingHeight) canvas.height = backingHeight
      sizeRef.current = { width, height, dpr }
      setViewportRevision((revision) => revision + 1)
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(control)
    window.addEventListener('resize', resize, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [])

  useEffect(() => {
    if (previousRoundRef.current !== round.roundId) {
      previousRoundRef.current = round.roundId
      previousOutcomesRef.current = new Map(
        round.contenders.map((contender) => [contender.id, contender.outcome]),
      )
      impactsRef.current = []
      return
    }

    const newHits = round.contenders
      .filter(
        (contender) =>
          contender.outcome === 'hit' &&
          previousOutcomesRef.current.get(contender.id) !== 'hit',
      )
      .sort((first, second) => (first.hitAt ?? 0) - (second.hitAt ?? 0))
    const now = performance.now()
    const additions = newHits.map<ImpactBurst>((contender, index) => ({
      id: `${round.roundId}:${contender.id}:${contender.hitAt ?? now}`,
      contenderId: contender.id,
      isPlayer: contender.isPlayer,
      barrier: contender.barrier,
      side: contender.side,
      color: contender.isPlayer ? FALLBACK_PALETTE.player : contender.color,
      startAt: now + (shouldReduceMotion ? 0 : index * 200),
    }))
    if (additions.length > 0) {
      impactsRef.current = [...impactsRef.current.slice(-18), ...additions]
    }
    previousOutcomesRef.current = new Map(
      round.contenders.map((contender) => [contender.id, contender.outcome]),
    )
  }, [round.contenders, round.roundId, shouldReduceMotion])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || sizeRef.current.width <= 1) return
    const palette = readPalette(canvas)
    let frame = 0
    let active = true

    const render = (now: number): void => {
      if (!active) return
      const recentImpacts = impactsRef.current.filter(
        (impact) => now - impact.startAt < 1_000,
      )
      impactsRef.current = recentImpacts
      viewRef.current = drawArena(
        canvas,
        round,
        sizeRef.current,
        palette,
        recentImpacts,
        {
          chartStyle,
          focused,
          masteryLevel: cosmeticMasteryLevel,
          mutedFlash,
          pointer: pointerRef.current,
          reducedMotion: shouldReduceMotion,
        },
        now,
        shouldReduceMotion ? null : viewEaseRef.current,
      )
      if (!shouldReduceMotion && document.visibilityState !== 'hidden') {
        frame = window.requestAnimationFrame(render)
      }
    }

    renderOnceRef.current = () => render(performance.now())
    render(performance.now())
    const resume = (): void => {
      if (document.visibilityState === 'visible' && !shouldReduceMotion) {
        window.cancelAnimationFrame(frame)
        frame = window.requestAnimationFrame(render)
      }
    }
    document.addEventListener('visibilitychange', resume)
    return () => {
      active = false
      renderOnceRef.current = null
      document.removeEventListener('visibilitychange', resume)
      window.cancelAnimationFrame(frame)
    }
  }, [chartStyle, cosmeticMasteryLevel, focused, mutedFlash, round, shouldReduceMotion, viewportRevision])

  const emitPlacement = useCallback(
    (clientY: number): void => {
      if (!canPlace || !onPlace) return
      const control = controlRef.current
      const view = viewRef.current
      if (!control || !view) return
      const bounds = control.getBoundingClientRect()
      const localY = clamp(clientY - bounds.top, view.top, view.bottom)
      const worldValue = lerp(
        view.worldMax,
        view.worldMin,
        (localY - view.top) / Math.max(EPSILON, view.bottom - view.top),
      )
      const side: FlagSide = localY <= view.lineY ? 'upper' : 'lower'
      const rawDistance = Math.abs(worldValue - round.lineValue) / view.distanceScale
      const minimum = Math.max(0.01, view.maxPlacementDistance * 0.025)
      const distance = clamp(rawDistance, minimum, view.maxPlacementDistance)
      const barrier =
        round.lineValue + (side === 'upper' ? 1 : -1) * distance * view.distanceScale
      onPlace({
        side,
        distance: Number(distance.toFixed(6)),
        barrier: Number(barrier.toFixed(6)),
      })
    },
    [canPlace, onPlace, round.lineValue],
  )

  const emitSignedDistance = useCallback(
    (signedDistance: number): void => {
      if (!canPlace || !onPlace) return
      const view = viewRef.current
      const distanceScale = view?.distanceScale ?? 1
      const maximum = view?.maxPlacementDistance ?? ariaMaximum
      const minimum = Math.max(0.01, maximum * 0.025)
      const side: FlagSide = signedDistance >= 0 ? 'upper' : 'lower'
      const distance = clamp(Math.abs(signedDistance), minimum, maximum)
      const barrier =
        round.lineValue + (side === 'upper' ? 1 : -1) * distance * distanceScale
      onPlace({
        side,
        distance: Number(distance.toFixed(6)),
        barrier: Number(barrier.toFixed(6)),
      })
    },
    [ariaMaximum, canPlace, onPlace, round.lineValue],
  )

  const updatePointer = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, shouldEmit: boolean): void => {
      const control = controlRef.current
      const view = viewRef.current
      if (!control || !view) return
      const bounds = control.getBoundingClientRect()
      pointerRef.current.visible = true
      pointerRef.current.y = clamp(event.clientY - bounds.top, view.top, view.bottom)
      if (shouldEmit) emitPlacement(event.clientY)
      if (shouldReduceMotion) renderOnceRef.current?.()
    },
    [emitPlacement, shouldReduceMotion],
  )

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (!canPlace || event.button !== 0) return
      event.preventDefault()
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.style.cursor = 'grabbing'
      pointerRef.current.dragging = true
      updatePointer(event, true)
    },
    [canPlace, updatePointer],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (!canPlace) return
      updatePointer(event, pointerRef.current.dragging)
    },
    [canPlace, updatePointer],
  )

  const finishPointer = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (!pointerRef.current.dragging) return
      updatePointer(event, true)
      pointerRef.current.dragging = false
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      event.currentTarget.style.cursor = canPlace ? 'crosshair' : 'default'
      if (shouldReduceMotion) renderOnceRef.current?.()
    },
    [canPlace, shouldReduceMotion, updatePointer],
  )

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (!canPlace) return
      const maximum = viewRef.current?.maxPlacementDistance ?? ariaMaximum
      const step = Math.max(0.01, maximum * (event.shiftKey ? 0.12 : 0.035))
      const current = player
        ? (player.side === 'upper' ? 1 : -1) * player.distance
        : maximum * 0.44
      let next: number | null = null
      if (event.key === 'ArrowUp') next = current + step
      else if (event.key === 'ArrowDown') next = current - step
      else if (event.key === 'PageUp') next = current + step * 4
      else if (event.key === 'PageDown') next = current - step * 4
      else if (event.key === ' ' || event.code === 'Space') next = -current
      else if (event.key === 'Enter') next = current
      if (next === null) return
      event.preventDefault()
      const minimum = Math.max(0.01, maximum * 0.025)
      if (Math.abs(next) < minimum) next = event.key === 'ArrowDown' ? -minimum : minimum
      emitSignedDistance(next)
    },
    [ariaMaximum, canPlace, emitSignedDistance, player],
  )

  const rootClassName = ['arena-canvas', className].filter(Boolean).join(' ')

  return (
    <div
      className={rootClassName}
      data-mastery-level={cosmeticMasteryLevel}
      style={ROOT_STYLE}
    >
      <div
        ref={controlRef}
        className="arena-canvas__viewport"
        style={{
          ...VIEWPORT_STYLE,
          touchAction: canPlace ? 'none' : 'pan-y',
        }}
        role={canPlace ? undefined : 'img'}
        aria-label={canPlace ? undefined : `${ariaLabel} ${PHASE_LABELS[round.phase]}.`}
      >
        <canvas
          ref={canvasRef}
          className="arena-canvas__surface"
          style={CANVAS_STYLE}
          aria-hidden="true"
        />
        {canPlace && (
          <button
            className="arena-canvas__control"
            type="button"
            style={{
              ...CONTROL_STYLE,
              cursor: pointerRef.current.dragging ? 'grabbing' : 'crosshair',
            }}
            role="slider"
            aria-label={`${ariaLabel}. Drag or use the arrow keys to plant your flag.`}
            aria-describedby={instructionsId}
            aria-orientation="vertical"
            aria-valuemin={-ariaMaximum}
            aria-valuemax={ariaMaximum}
            aria-valuenow={signedPlayerDistance}
            aria-valuetext={player
              ? `${player.side}, distance ${player.distance.toFixed(2)}, ${player.risk.toFixed(1)} times risk reward`
              : undefined}
            aria-keyshortcuts="ArrowUp ArrowDown PageUp PageDown Space Enter"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointer}
            onPointerCancel={finishPointer}
            onPointerEnter={handlePointerMove}
            onPointerLeave={() => {
              if (!pointerRef.current.dragging) {
                pointerRef.current.visible = false
                if (shouldReduceMotion) renderOnceRef.current?.()
              }
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
        )}
      </div>
      <span id={instructionsId} className="arena-canvas__instructions" style={VISUALLY_HIDDEN_STYLE}>
        During placement, drag vertically. Arrow keys make fine moves, Page Up and Page Down
        make coarse moves, and Space switches side. Closer flags pay more. Crowded flags pay
        less.
      </span>
      <span
        className="arena-canvas__status"
        style={VISUALLY_HIDDEN_STYLE}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {status}
      </span>
    </div>
  )
}

export default ArenaCanvas
