import { describe, expect, it } from 'vitest'
import { canonicalDigest, canonicalStringify } from './canonical'
import { sha256Hex, sha256HexSync } from './crypto'

describe('canonical proof encoding', () => {
  it('sorts object keys recursively without changing array order', () => {
    const left = { z: 3, nested: { beta: true, alpha: 'x' }, list: [3, 1, 2] }
    const right = { list: [3, 1, 2], nested: { alpha: 'x', beta: true }, z: 3 }
    expect(canonicalStringify(left)).toBe(canonicalStringify(right))
    expect(canonicalStringify({ list: [1, 2] })).not.toBe(
      canonicalStringify({ list: [2, 1] }),
    )
  })

  it('normalizes negative zero and follows JSON omission semantics', () => {
    expect(canonicalStringify({ zero: -0, omitted: undefined, array: [undefined] })).toBe(
      '{"array":[null],"zero":0}',
    )
  })

  it('rejects values that cannot produce portable proof bytes', () => {
    expect(() => canonicalStringify({ invalid: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalStringify({ invalid: 1n })).toThrow(TypeError)
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(() => canonicalStringify(circular)).toThrow(TypeError)
  })

  it('matches published SHA-256 vectors in fallback and Web Crypto paths', async () => {
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(sha256HexSync('abc')).toBe(expected)
    expect(await sha256Hex('abc')).toBe(expected)
    expect(await sha256Hex('abc', { forceFallback: true })).toBe(expected)
    expect(sha256HexSync('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    const unicode = 'Strikefall ⚡ deterministic replay '.repeat(100)
    expect(await sha256Hex(unicode, { forceFallback: true })).toBe(await sha256Hex(unicode))
  })

  it('produces the same digest for differently inserted keys', async () => {
    await expect(canonicalDigest({ second: 2, first: 1 })).resolves.toBe(
      await canonicalDigest({ first: 1, second: 2 }),
    )
  })
})
