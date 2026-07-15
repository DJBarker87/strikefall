import { describe, expect, it, vi } from 'vitest'
import { roundCreatedEvent, signedEvent } from './_fixtures'
import { createAuthenticatedFetchEventSourceFactory } from './authenticatedEventSource'
import type { RankedClock, TimerHandle } from './client'
import { connectRankedEventStream } from './stream'

class ManualClock implements RankedClock {
  private time = 1_000
  private nextId = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  now = () => this.time

  setTimeout = (callback: () => void, delayMs: number): TimerHandle => {
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, { at: this.time + delayMs, callback })
    return id
  }

  clearTimeout = (handle: TimerHandle) => {
    this.timers.delete(handle)
  }

  advance(delayMs: number): void {
    const target = this.time + delayMs
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (due === undefined) break
      const [id, timer] = due
      this.timers.delete(id)
      this.time = timer.at
      timer.callback()
    }
    this.time = target
  }
}

function eventText(event: unknown, id: number): string {
  return `id: ${id}\nevent: round_event\ndata: ${JSON.stringify(event)}\n\n`
}

function completedSse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

function openSse(text: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      signal.addEventListener('abort', () => {
        controller.error(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

function headersAt(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number): Headers {
  return new Headers(fetchMock.mock.calls[index]?.[1]?.headers)
}

describe('authenticated fetch SSE', () => {
  it('invokes receiver-sensitive browser fetch as a plain function', async () => {
    let receiver: unknown = 'not-called'
    let signal: AbortSignal | undefined
    const receiverSensitiveFetch: typeof fetch = async function (this: unknown, _url, init) {
      receiver = this
      signal = init?.signal ?? undefined
      return openSse(': connected\n\n', signal ?? new AbortController().signal)
    }
    const factory = createAuthenticatedFetchEventSourceFactory({
      bearerToken: 'alpha-session-token',
      fetch: receiverSensitiveFetch,
    })
    const source = factory('https://rounds.strikefall.test/stream', {
      withCredentials: false,
      lastEventId: null,
    })

    await vi.waitFor(() => expect(receiver).not.toBe('not-called'))
    expect(receiver).toBeUndefined()
    source.close()
    expect(signal?.aborted).toBe(true)
  })

  it('keeps bearer credentials in headers and reconnects with Last-Event-ID', async () => {
    const clock = new ManualClock()
    const tokens = ['alpha-token-one', 'alpha-token-two']
    let pendingSignal: AbortSignal | undefined
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completedSse([
        eventText(roundCreatedEvent(0), 0).slice(0, 37),
        eventText(roundCreatedEvent(0), 0).slice(37),
      ]))
      .mockImplementationOnce(async (_url, init) => {
        pendingSignal = init?.signal ?? undefined
        const second = signedEvent(1, {
          type: 'battle_frame',
          data: { point: { step: 1, varianceElapsed: '1', logReturn: '0', price: '100', intervalHigh: '100', intervalLow: '100' } },
        })
        return openSse(
          `${eventText(roundCreatedEvent(0), 0)}${eventText(second, 1)}`,
          pendingSignal ?? new AbortController().signal,
        )
      })
    const factory = createAuthenticatedFetchEventSourceFactory({
      bearerToken: () => tokens.shift() ?? 'rotated-token',
      fetch: fetchMock,
      clock,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1_000,
    })
    const delivered: number[] = []
    const stream = connectRankedEventStream({
      url: 'https://rounds.strikefall.test/v1/solo-rounds/round-1/stream',
      protocolVersion: 'strikefall/ranked-replay/v3',
      eventSource: factory,
      clock,
      offlineAfterMs: 2_000,
      onEvent: ({ sequence }) => delivered.push(sequence),
    })

    await vi.waitFor(() => expect(delivered).toEqual([0]))
    expect(stream.snapshot().state).toBe('reconnecting')
    clock.advance(101)
    await vi.waitFor(() => expect(delivered).toEqual([0, 1]))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toBe('https://rounds.strikefall.test/v1/solo-rounds/round-1/stream')
      expect(String(url)).not.toContain('alpha-token')
    }
    expect(headersAt(fetchMock, 0).get('authorization')).toBe('Bearer alpha-token-one')
    expect(headersAt(fetchMock, 0).get('last-event-id')).toBeNull()
    expect(headersAt(fetchMock, 1).get('authorization')).toBe('Bearer alpha-token-two')
    expect(headersAt(fetchMock, 1).get('last-event-id')).toBe('0')
    expect(headersAt(fetchMock, 1).get('accept')).toBe('text/event-stream')

    stream.close()
    expect(pendingSignal?.aborted).toBe(true)
  })

  it('aborts an in-flight authenticated fetch and never retries after close', async () => {
    const clock = new ManualClock()
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal ?? undefined
      return openSse(': keep-alive\n\n', signal ?? new AbortController().signal)
    })
    const factory = createAuthenticatedFetchEventSourceFactory({
      bearerToken: 'top-secret-token',
      fetch: fetchMock,
      clock,
      reconnectBaseMs: 50,
    })
    const source = factory('https://rounds.strikefall.test/stream', {
      withCredentials: false,
      lastEventId: '17',
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    source.close()
    expect(signal?.aborted).toBe(true)
    clock.advance(10_000)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('top-secret-token')
  })

  it('parses split CRLF frames, multiline data, and server retry hints', async () => {
    const clock = new ManualClock()
    let secondSignal: AbortSignal | undefined
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completedSse([
        'retry: 25\r',
        '\nid: 9\r\nevent: probe\r\ndata: first\r',
        '\ndata: second\r\n\r\n',
      ]))
      .mockImplementationOnce(async (_url, init) => {
        secondSignal = init?.signal ?? undefined
        return openSse(': connected\n\n', secondSignal ?? new AbortController().signal)
      })
    const factory = createAuthenticatedFetchEventSourceFactory({
      bearerToken: 'alpha-session-token',
      fetch: fetchMock,
      clock,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1_000,
    })
    const source = factory('https://rounds.strikefall.test/stream', {
      withCredentials: false,
      lastEventId: null,
    })
    const events: MessageEvent<string>[] = []
    source.addEventListener('probe', (event) => events.push(event as MessageEvent<string>))

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ data: 'first\nsecond', lastEventId: '9' })
    clock.advance(24)
    expect(fetchMock).toHaveBeenCalledOnce()
    clock.advance(1)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(headersAt(fetchMock, 1).get('last-event-id')).toBe('9')

    source.close()
    expect(secondSignal?.aborted).toBe(true)
  })

  it('persists an id-only frame for the next reconnect without dispatching it', async () => {
    const clock = new ManualClock()
    let secondSignal: AbortSignal | undefined
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completedSse(['id: 17\n\n']))
      .mockImplementationOnce(async (_url, init) => {
        secondSignal = init?.signal ?? undefined
        return openSse(': connected\n\n', secondSignal ?? new AbortController().signal)
      })
    const factory = createAuthenticatedFetchEventSourceFactory({
      bearerToken: 'alpha-session-token',
      fetch: fetchMock,
      clock,
      reconnectBaseMs: 50,
    })
    const source = factory('https://rounds.strikefall.test/stream', {
      withCredentials: false,
      lastEventId: null,
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await vi.waitFor(() => {
      clock.advance(50)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    expect(headersAt(fetchMock, 1).get('last-event-id')).toBe('17')

    source.close()
    expect(secondSignal?.aborted).toBe(true)
  })

  it('does not expose a rejected token value through URLs or error events', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const factory = createAuthenticatedFetchEventSourceFactory({
      bearerToken: async () => {
        throw new Error('provider failed')
      },
      fetch: fetchMock,
      reconnectBaseMs: 1_000,
    })
    const source = factory('https://rounds.strikefall.test/stream', {
      withCredentials: false,
      lastEventId: null,
    })
    const errors: Event[] = []
    source.addEventListener('error', (event) => errors.push(event))
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errors[0]?.type).toBe('error')
    expect(JSON.stringify(errors[0])).not.toContain('provider failed')
    source.close()
  })
})
