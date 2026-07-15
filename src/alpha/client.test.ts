import { describe, expect, it, vi } from 'vitest'
import { AlphaApiError, createAlphaApiClient, createBearerFetch } from './client'
import {
  ALPHA_TOKEN_STORAGE_KEY,
  clearAlphaToken,
  readAlphaToken,
  writeAlphaToken,
  type AlphaTokenStorage,
} from './storage'

const TOKEN = `sf_alpha_${'ab'.repeat(32)}`

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function session() {
  return {
    handle: 'Rider-CAFE1234',
    expiresAtMs: 1_800_000_000_000,
    telemetryConsent: false,
    experiments: { escape: 'midpoint' },
  }
}

describe('closed-alpha API client', () => {
  it('issues without auth, then authenticates session requests without putting tokens in URLs', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      seen.push({ url, authorization: new Headers(init?.headers).get('authorization') })
      return url.endsWith('/v1/sessions')
        ? json({ token: TOKEN, session: session() }, 201)
        : json(session())
    })
    let token: string | null = null
    const client = createAlphaApiClient({
      baseUrl: 'https://alpha.example.test/',
      token: () => token,
      fetch: fetchMock,
    })
    const issued = await client.issueSession({ inviteCode: 'INVITE123', telemetryConsent: false })
    token = issued.token
    expect((await client.session()).handle).toBe('Rider-CAFE1234')
    expect(seen[0]).toEqual({ url: 'https://alpha.example.test/v1/sessions', authorization: null })
    expect(seen[1]?.authorization).toBe(`Bearer ${TOKEN}`)
    expect(seen.every(({ url }) => !url.includes(TOKEN))).toBe(true)
  })

  it('strictly parses fixed-score leaderboard pages and self rank', async () => {
    const client = createAlphaApiClient({
      baseUrl: '/api',
      token: () => TOKEN,
      fetch: vi.fn<typeof fetch>(async () => json({
        deckId: 'balanced_tape',
        deckVersion: 1,
        window: 'weekly',
        generatedAtMs: 1_700_000_000_000,
        entries: [{
          rank: 1,
          handle: 'Rider-ONE',
          score: '420000000000000',
          outcome: 'survived',
          roundId: 'round-1',
          resolvedAtMs: 1_700_000_000_000,
          isSelf: true,
        }],
        selfEntry: {
          rank: 1,
          handle: 'Rider-ONE',
          score: '420000000000000',
          outcome: 'survived',
          roundId: 'round-1',
          resolvedAtMs: 1_700_000_000_000,
          isSelf: true,
        },
        nextCursor: null,
      })),
    })
    const leaderboard = await client.leaderboard('balanced_tape', { window: 'weekly', limit: 20 })
    expect(leaderboard.entries[0]).toMatchObject({ rank: 1, score: '420000000000000' })
    expect(leaderboard.selfEntry?.isSelf).toBe(true)
  })

  it('preserves bounded server errors without exposing the bearer', async () => {
    const client = createAlphaApiClient({
      baseUrl: '/api',
      token: () => TOKEN,
      fetch: vi.fn<typeof fetch>(async () => json({
        code: 'forbidden',
        message: 'request is not permitted: a valid closed-alpha invite is required',
        retryAfterMs: null,
      }, 403)),
    })
    await expect(client.session()).rejects.toMatchObject({
      name: 'AlphaApiError',
      status: 403,
      code: 'forbidden',
    })
    await expect(client.session()).rejects.not.toHaveProperty('message', expect.stringContaining(TOKEN))
  })

  it('wraps fetch with an Authorization header while retaining caller headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(headers.get('x-test')).toBe('yes')
      return new Response(null, { status: 204 })
    })
    const authorized = createBearerFetch(() => TOKEN, fetchMock)
    await authorized('/v1/test', { headers: { 'x-test': 'yes' } })
    await expect(createBearerFetch(() => null, fetchMock)('/v1/test')).rejects.toBeInstanceOf(AlphaApiError)
  })
})

describe('alpha bearer storage', () => {
  function memory(): AlphaTokenStorage {
    const values = new Map<string, string>()
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: (key) => { values.delete(key) },
    }
  }

  it('stores only well-formed opaque tokens and clears them', () => {
    const storage = memory()
    expect(writeAlphaToken(TOKEN, storage)).toBe(true)
    expect(readAlphaToken(storage)).toBe(TOKEN)
    clearAlphaToken(storage)
    expect(readAlphaToken(storage)).toBeNull()
    expect(() => writeAlphaToken('Bearer not-a-token', storage)).toThrow(/format/)
  })

  it('rejects malformed persisted material', () => {
    const storage = memory()
    storage.setItem(ALPHA_TOKEN_STORAGE_KEY, '<script>')
    expect(readAlphaToken(storage)).toBeNull()
  })
})
