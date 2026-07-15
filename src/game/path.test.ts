import { describe, expect, it } from 'vitest'
import {
  displayNumberToFixed,
  fixedToDisplayNumber,
  getActiveScoringEngine,
  pathSeedToU64,
  rustDeckId,
} from '../engine'
import { DECKS, getDeck } from './decks'
import {
  BATTLE_INTEGRATED_VARIANCE,
  candleizeCanonicalPath,
  generateApproach,
  generateBattlePath,
  generateRoundPaths,
  getPathExtrema,
  sampleBridgeExtrema,
  varianceSchedule,
} from './path'

const balanced = getDeck('balanced-tape')!
const compression = getDeck('compression-break')!

describe('regime deck paths', () => {
  it('is exactly deterministic for a seed and fresh across seeds', () => {
    const first = generateRoundPaths('fixture-a', balanced)
    expect(generateRoundPaths('fixture-a', balanced)).toEqual(first)
    expect(generateRoundPaths('fixture-b', balanced).battlePath).not.toEqual(first.battlePath)
  })

  it('is a lossless display projection of the active Rust/WASM path for every deck', () => {
    const client = getActiveScoringEngine().client
    if (!client) throw new Error('SolMath WASM test runtime is not active')
    for (const deck of DECKS) {
      const seed = `wasm-parity-${deck.id}`
      const raw = client.generateRoundPath({
        deckId: rustDeckId(deck.id),
        deckVersion: deck.version,
        seed: pathSeedToU64(seed),
        initialSpot: displayNumberToFixed(50),
      })
      const projected = generateRoundPaths(seed, deck)
      expect(projected.approach).toEqual(candleizeCanonicalPath(raw.approach, 18))
      expect(projected.battlePath).toEqual(
        raw.battle.map((point) => fixedToDisplayNumber(point.price)),
      )
      expect(projected.battlePathFixed).toEqual(
        raw.battle.map((point) => point.price),
      )
      expect(projected.battleExtrema).toEqual(
        raw.battle.map((point) => ({
          high: fixedToDisplayNumber(point.intervalHigh),
          low: fixedToDisplayNumber(point.intervalLow),
        })),
      )
      expect(projected.battleExtremaFixed).toEqual(
        raw.battle.map((point) => ({
          high: point.intervalHigh,
          low: point.intervalLow,
        })),
      )
      expect(projected.lineValueFixed).toBe(raw.battle[0]?.price)
    }
  })

  it('joins the battle to the final approach close', () => {
    const paths = generateRoundPaths('joined', compression, 20, 101)
    expect(paths.approach).toHaveLength(20)
    expect(paths.battlePath).toHaveLength(101)
    expect(paths.battleExtrema).toHaveLength(101)
    expect(paths.battlePath[0]).toBe(paths.approach.at(-1)?.close)
    expect(paths.lineValue).toBe(paths.battlePath[0])
  })

  it('retains every conditional interval wick around both public endpoints', () => {
    const { battlePath, battleExtrema } = generateRoundPaths('bridge-wicks', balanced)
    for (let index = 1; index < battlePath.length; index += 1) {
      const previous = battlePath[index - 1] as number
      const current = battlePath[index] as number
      const extrema = battleExtrema[index]!
      expect(extrema.high).toBeGreaterThanOrEqual(Math.max(previous, current))
      expect(extrema.low).toBeLessThanOrEqual(Math.min(previous, current))
      expect(extrema.low).toBeGreaterThan(0)
    }
  })

  it('inverts the known symmetric bridge-extremum law', () => {
    const extrema = sampleBridgeExtrema(100, 100, 0.01, Math.exp(-2), Math.exp(-2))
    expect(Math.log(extrema.high / 100)).toBeCloseTo(0.1, 5)
    expect(Math.log(extrema.low / 100)).toBeCloseTo(-0.1, 5)
  })

  it('creates valid OHLC candles with visible wicks', () => {
    const candles = generateApproach('candles', balanced, 24)
    for (const candle of candles) {
      expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close))
      expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close))
      expect(candle.low).toBeGreaterThan(0)
    }
  })

  it('allocates equal total variance but preserves each deck shape', () => {
    const flat = varianceSchedule(balanced, 240, BATTLE_INTEGRATED_VARIANCE)
    const backLoaded = varianceSchedule(compression, 240, BATTLE_INTEGRATED_VARIANCE)
    expect(flat.reduce((sum, value) => sum + value, 0)).toBeCloseTo(BATTLE_INTEGRATED_VARIANCE, 12)
    expect(backLoaded.reduce((sum, value) => sum + value, 0)).toBeCloseTo(BATTLE_INTEGRATED_VARIANCE, 12)
    expect(backLoaded.slice(180).reduce((sum, value) => sum + value, 0)).toBeGreaterThan(
      backLoaded.slice(0, 60).reduce((sum, value) => sum + value, 0) * 8,
    )
    const runway = balanced.openingRunway!
    const firstQuarter = flat.slice(0, 60).reduce((sum, value) => sum + value, 0)
    expect(flat.slice(0, runway.steps).reduce((sum, value) => sum + value, 0)).toBeCloseTo(
      firstQuarter * runway.varianceShareBps / 10_000,
      12,
    )
    expect(flat.every((increment) => increment > 0)).toBe(true)
  })

  it('keeps every shipped deck generative and positive', () => {
    for (const deck of DECKS) {
      const path = generateBattlePath('all-decks', deck, 50, 80)
      const extrema = getPathExtrema(path)
      expect(path.every((value) => value > 0 && Number.isFinite(value))).toBe(true)
      expect(extrema.range).toBeGreaterThan(0)
    }
  })

  it('rejects invalid generation inputs', () => {
    expect(() => varianceSchedule(balanced, 0, 0.1)).toThrow(RangeError)
    expect(() => generateBattlePath('bad', balanced, 0)).toThrow(RangeError)
  })
})
