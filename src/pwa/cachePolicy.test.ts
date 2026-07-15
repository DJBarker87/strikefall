import { describe, expect, it } from 'vitest'
import {
  isPracticeNetworkOnlyPath,
  shouldPracticeWorkerHandle,
} from './cachePolicy'

describe('practice service worker cache boundary', () => {
  it.each([
    '/api',
    '/api/v1/solo-rounds',
    '/ranked',
    '/ranked/live',
    '/replay',
    '/replay/0190-public-id',
  ])('keeps %s network-only', (pathname) => {
    expect(isPracticeNetworkOnlyPath(pathname)).toBe(true)
    expect(shouldPracticeWorkerHandle({
      method: 'GET',
      requestUrl: `https://strikefall.test${pathname}`,
      scopeOrigin: 'https://strikefall.test',
    })).toBe(false)
  })

  it('allows same-origin shell assets without credentials', () => {
    expect(shouldPracticeWorkerHandle({
      method: 'GET',
      requestUrl: 'https://strikefall.test/assets/game-abcd.wasm',
      scopeOrigin: 'https://strikefall.test',
    })).toBe(true)
  })

  it('rejects writes, authorized reads, and cross-origin resources', () => {
    const base = {
      requestUrl: 'https://strikefall.test/assets/game.js',
      scopeOrigin: 'https://strikefall.test',
    }
    expect(shouldPracticeWorkerHandle({ ...base, method: 'POST' })).toBe(false)
    expect(shouldPracticeWorkerHandle({
      ...base,
      method: 'GET',
      hasAuthorization: true,
    })).toBe(false)
    expect(shouldPracticeWorkerHandle({
      method: 'GET',
      requestUrl: 'https://api.strikefall.test/game.js',
      scopeOrigin: 'https://strikefall.test',
    })).toBe(false)
  })
})
