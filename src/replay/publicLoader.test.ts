import { describe, expect, it, vi } from 'vitest'
import { parseRankedReplayId } from './id'
import { createPublicRankedReplayLoader } from './publicLoader'

const ROUND_ID = parseRankedReplayId('123e4567-e89b-42d3-a456-426614174000')

describe('public ranked replay loader', () => {
  it('uses the identity-free route without forwarding credentials', async () => {
    const envelope = { anchor: { roundId: ROUND_ID }, replay: { roundId: ROUND_ID } }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const loader = createPublicRankedReplayLoader({ baseUrl: '/api/', fetch: fetchMock })
    const controller = new AbortController()

    await expect(loader(ROUND_ID, { signal: controller.signal })).resolves.toEqual(envelope)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/public-replays/${ROUND_ID}`,
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }),
    )
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init).not.toHaveProperty('headers')
  })

  it('rejects credential-bearing API origins', () => {
    expect(() => createPublicRankedReplayLoader({
      baseUrl: 'https://token@example.test/api',
      fetch: vi.fn(),
    })).toThrow(/credentials/)
  })

  it('rejects envelopes without the separately trusted anchor', async () => {
    const loader = createPublicRankedReplayLoader({
      baseUrl: '/api',
      fetch: vi.fn(async () => new Response(JSON.stringify({ replay: {} }), { status: 200 })),
    })
    await expect(loader(ROUND_ID, { signal: new AbortController().signal }))
      .rejects.toThrow(/trusted anchor/)
  })
})
