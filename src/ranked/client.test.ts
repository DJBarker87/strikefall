import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  H3,
  createResponse,
  deck,
  jsonResponse,
  placement,
  replayBundle,
} from './_fixtures'
import { createRankedClient, replayAnchorFromCreate } from './client'
import { RankedPayloadError, UnsupportedRankedProtocolError } from './errors'
import { parseUnsignedDecimalString } from './validation'

afterEach(() => {
  vi.useRealTimers()
})

describe('ranked HTTP client', () => {
  it('calls every authoritative round endpoint and validates successful responses', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(deck()))
      .mockResolvedValueOnce(jsonResponse(createResponse(), { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({
        eventSequence: 4,
        placement: placement(),
        inputFreezeAtMs: 1_700_000_014_000,
      }))
      .mockResolvedValueOnce(jsonResponse({
        eventSequence: 100,
        escape: {
          step: 120,
          bankedScore: '200000000000000',
          lineValue: '103000000000000',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        roundId: 'round-1',
        status: 'battle',
        result: null,
        reveal: null,
      }))
      .mockResolvedValueOnce(jsonResponse(replayBundle()))
      .mockResolvedValueOnce(jsonResponse({
        eventSequence: 500,
        alreadyAcknowledged: false,
      }))
    const client = createRankedClient({
      baseUrl: 'https://rounds.strikefall.test/',
      fetch: fetchMock,
      bearerToken: 'alpha-session-token',
    })

    await expect(client.getDeck('balanced_tape', 3)).resolves.toMatchObject({
      id: 'balanced_tape',
      totalIntegratedVariance: '6400000000',
    })
    const created = await client.createRound({ deckId: 'balanced_tape', deckVersion: 3 })
    expect(created.playerPlacement).toMatchObject({ contenderId: 0, isBot: false })
    await expect(client.updateFlag('round-1', {
      side: 'upper',
      barrier: parseUnsignedDecimalString('110000000000000'),
      clientSequence: 2,
    })).resolves.toMatchObject({ eventSequence: 4 })
    await expect(client.escape('round-1', { clientSequence: 3 })).resolves.toMatchObject({
      escape: { step: 120 },
    })
    await expect(client.getResult('round-1')).resolves.toMatchObject({ status: 'battle' })
    const replay = await client.getReplay('round-1', {
      anchor: replayAnchorFromCreate(created),
    })
    expect(replay).toMatchObject({ roundId: 'round-1' })
    await expect(client.acknowledgeReplay('round-1', {
      proofDigest: replay.result.proofDigest,
      verifierVersion: 'strikefall-web/verifier-v1',
    })).resolves.toEqual({ eventSequence: 500, alreadyAcknowledged: false })

    expect(client.protocolForRound('round-1')).toBe('strikefall/ranked-replay/v3')
    expect(client.streamUrl('round id')).toBe(
      'https://rounds.strikefall.test/v1/solo-rounds/round%20id/stream',
    )
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://rounds.strikefall.test/v1/decks/balanced_tape/3',
      'https://rounds.strikefall.test/v1/solo-rounds',
      'https://rounds.strikefall.test/v1/solo-rounds/round-1/flag',
      'https://rounds.strikefall.test/v1/solo-rounds/round-1/escape',
      'https://rounds.strikefall.test/v1/solo-rounds/round-1/result',
      'https://rounds.strikefall.test/v1/solo-rounds/round-1/replay',
      'https://rounds.strikefall.test/v1/solo-rounds/round-1/replay-verified',
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer alpha-session-token',
      )
    }
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      side: 'upper',
      barrier: '110000000000000',
      clientSequence: 2,
    })
  })

  it('exposes structured HTTP and rate-limit retry hints from JSON or Retry-After', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        code: 'flag_rate_limited',
        message: 'retry shortly',
        retryAfterMs: 375,
      }, { status: 429 }))
      .mockResolvedValueOnce(new Response('not json', {
        status: 503,
        headers: { 'retry-after': '2' },
      }))
    const client = createRankedClient({ baseUrl: '/api', fetch: fetchMock })

    const first = client.updateFlag('round-1', {
      side: 'upper',
      barrier: parseUnsignedDecimalString('110000000000000'),
    })
    await expect(first).rejects.toMatchObject({
      status: 429,
      apiCode: 'flag_rate_limited',
      retryAfterMs: 375,
    })
    await expect(client.getResult('round-1')).rejects.toMatchObject({
      status: 503,
      retryAfterMs: 2_000,
    })
  })

  it('distinguishes caller aborts from request timeouts', async () => {
    vi.useFakeTimers()
    const hangingFetch = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    }))
    const client = createRankedClient({
      baseUrl: '/api',
      fetch: hangingFetch,
      timeoutMs: 50,
    })

    const caller = new AbortController()
    const aborted = client.getResult('round-1', { signal: caller.signal })
    const abortedAssertion = expect(aborted).rejects.toMatchObject({
      code: 'aborted',
    })
    caller.abort()
    await abortedAssertion

    const timedOut = client.getResult('round-1')
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({
      code: 'timeout',
    })
    await vi.advanceTimersByTimeAsync(51)
    await timeoutAssertion
  })

  it('resolves rotated bearer credentials per request and fails before fetch without one', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(deck()))
      .mockResolvedValueOnce(jsonResponse(deck()))
    const tokens = ['session-one', 'session-two']
    const client = createRankedClient({
      baseUrl: '/api',
      fetch: fetchMock,
      bearerToken: () => tokens.shift() ?? '',
    })
    await client.getDeck('balanced_tape', 3)
    await client.getDeck('balanced_tape', 3)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer session-one',
    )
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer session-two',
    )

    const missingFetch = vi.fn<typeof fetch>()
    const missing = createRankedClient({
      baseUrl: '/api',
      fetch: missingFetch,
      bearerToken: '',
    })
    await expect(missing.getDeck('balanced_tape', 3)).rejects.toMatchObject({
      code: 'authentication_unavailable',
    })
    expect(missingFetch).not.toHaveBeenCalled()
  })

  it('rejects malformed fixed strings before they can enter gameplay', async () => {
    const malformed = createResponse()
    malformed.deck.totalIntegratedVariance = '06400000000'
    const client = createRankedClient({
      baseUrl: '/api',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(malformed)),
    })
    await expect(client.createRound()).rejects.toBeInstanceOf(RankedPayloadError)
  })

  it('accepts only the two mandatory and one optional shipped treatment keys', async () => {
    const malformed = createResponse()
    ;(malformed as unknown as { experimentAssignments: Record<string, string> })
      .experimentAssignments = {
        ...malformed.experimentAssignments,
        impact_fx_v1: 'enhanced',
      }
    const client = createRankedClient({
      baseUrl: '/api',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(malformed)),
    })
    await expect(client.createRound()).rejects.toBeInstanceOf(RankedPayloadError)
  })

  it('rejects local-practice and obsolete protocol markers at the adapter boundary', async () => {
    const client = createRankedClient({
      baseUrl: '/api',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(createResponse('strikefall/replay/v1')),
      ),
    })
    await expect(client.createRound()).rejects.toBeInstanceOf(UnsupportedRankedProtocolError)
  })

  it('invalidates a replay whose anchored proof identity changes', async () => {
    const changed = replayBundle()
    changed.commitment = H3
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse(), { status: 201 }))
      .mockResolvedValueOnce(jsonResponse(changed))
    const client = createRankedClient({ baseUrl: '/api', fetch: fetchMock })
    const created = await client.createRound()
    await expect(client.getReplay(created.roundId, {
      anchor: replayAnchorFromCreate(created),
    })).rejects.toMatchObject({ code: 'protocol_mismatch' })
  })

  it('invalidates a replay whose versioned treatment anchor changes', async () => {
    const changed = replayBundle()
    changed.experimentAssignments = {
      ...changed.experimentAssignments,
      'risk-display:v2': 'probability',
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse(), { status: 201 }))
      .mockResolvedValueOnce(jsonResponse(changed))
    const client = createRankedClient({ baseUrl: '/api', fetch: fetchMock })
    const created = await client.createRound()
    await expect(client.getReplay(created.roundId, {
      anchor: replayAnchorFromCreate(created),
    })).rejects.toMatchObject({ code: 'protocol_mismatch' })
  })
})
