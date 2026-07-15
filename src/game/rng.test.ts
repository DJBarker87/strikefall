import { describe, expect, it } from 'vitest'
import { createRng, deriveSeed, hashSeed, shuffleWithRng } from './rng'

describe('seeded RNG', () => {
  it('replays the same stream exactly', () => {
    const first = createRng('same-seed')
    const second = createRng('same-seed')
    expect(Array.from({ length: 20 }, () => first.next())).toEqual(
      Array.from({ length: 20 }, () => second.next()),
    )
  })

  it('domain-separates bot and path streams', () => {
    const root = 'round-42'
    expect(deriveSeed(root, 'path')).not.toBe(deriveSeed(root, 'bots'))
    expect(createRng(deriveSeed(root, 'path')).next()).not.toBe(
      createRng(deriveSeed(root, 'bots')).next(),
    )
  })

  it('keeps hashes and shuffles deterministic', () => {
    expect(hashSeed('Strikefall')).toBe(hashSeed('Strikefall'))
    expect(shuffleWithRng([1, 2, 3, 4, 5], createRng('shuffle'))).toEqual(
      shuffleWithRng([1, 2, 3, 4, 5], createRng('shuffle')),
    )
  })

  it('produces finite normal samples and refuses empty picks', () => {
    const rng = createRng('normal')
    const samples = Array.from({ length: 1_000 }, () => rng.normal())
    expect(samples.every(Number.isFinite)).toBe(true)
    expect(Math.abs(samples.reduce((sum, value) => sum + value, 0) / samples.length)).toBeLessThan(0.15)
    expect(() => rng.pick([])).toThrow(RangeError)
  })
})
