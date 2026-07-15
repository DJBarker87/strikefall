import { type RankedClock, type TimerHandle, systemRankedClock } from './client'
import { RankedClientError, errorMessage } from './errors'
import { protocolAdapter } from './protocol'
import type { RankedProtocolVersion, SignedRoundEvent } from './types'

export type RankedStreamState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'offline'
  | 'invalid'
  | 'closed'

export interface RankedStreamSnapshot {
  state: RankedStreamState
  lastSequence: number | null
  lastEventId: string | null
  bufferedSequences: readonly number[]
  reason: string | null
}

export interface EventSourceLike {
  close(): void
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

export interface EventSourceFactoryOptions {
  withCredentials: boolean
  /**
   * A polyfill may send this as `Last-Event-ID`. Native EventSource preserves
   * the same value automatically while it reconnects its existing instance.
   */
  lastEventId: string | null
}

export type EventSourceFactory = (
  url: string,
  options: EventSourceFactoryOptions,
) => EventSourceLike

export interface RankedEventStreamOptions {
  url: string
  protocolVersion: RankedProtocolVersion
  eventSource?: EventSourceFactory
  clock?: RankedClock
  withCredentials?: boolean
  initialLastSequence?: number
  offlineAfterMs?: number
  gapAfterMs?: number
  onEvent(event: SignedRoundEvent): void
  onState?(snapshot: RankedStreamSnapshot): void
  onError?(error: RankedClientError): void
}

export interface RankedEventStream {
  snapshot(): RankedStreamSnapshot
  reconnect(): void
  close(): void
}

function defaultEventSourceFactory(
  url: string,
  options: EventSourceFactoryOptions,
): EventSourceLike {
  if (typeof globalThis.EventSource !== 'function') {
    throw new TypeError('An EventSource implementation is required')
  }
  return new globalThis.EventSource(url, { withCredentials: options.withCredentials })
}

function initialSequence(value: number | undefined): number {
  if (value === undefined) return -1
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new TypeError('initialLastSequence must be -1 or a safe unsigned integer')
  }
  return value
}

function positiveDelay(value: number | undefined, fallback: number, label: string): number {
  const parsed = value ?? fallback
  if (!Number.isFinite(parsed) || parsed <= 0) throw new TypeError(`${label} must be positive`)
  return parsed
}

export function connectRankedEventStream(options: RankedEventStreamOptions): RankedEventStream {
  const clock = options.clock ?? systemRankedClock
  const sourceFactory = options.eventSource ?? defaultEventSourceFactory
  const parser = protocolAdapter(options.protocolVersion)
  const offlineAfterMs = positiveDelay(options.offlineAfterMs, 5_000, 'offlineAfterMs')
  const gapAfterMs = positiveDelay(options.gapAfterMs, 2_500, 'gapAfterMs')
  let source: EventSourceLike | null = null
  let state: RankedStreamState = 'connecting'
  let reason: string | null = null
  let lastSequence = initialSequence(options.initialLastSequence)
  const buffered = new Map<number, SignedRoundEvent>()
  let outageTimer: TimerHandle | null = null
  let gapTimer: TimerHandle | null = null
  let terminal = false

  const snapshot = (): RankedStreamSnapshot => ({
    state,
    lastSequence: lastSequence < 0 ? null : lastSequence,
    lastEventId: lastSequence < 0 ? null : String(lastSequence),
    bufferedSequences: [...buffered.keys()].sort((left, right) => left - right),
    reason,
  })

  const notify = () => options.onState?.(snapshot())

  const clearOutageTimer = () => {
    if (outageTimer !== null) clock.clearTimeout(outageTimer)
    outageTimer = null
  }

  const clearGapTimer = () => {
    if (gapTimer !== null) clock.clearTimeout(gapTimer)
    gapTimer = null
  }

  const fail = (error: RankedClientError, nextState: 'offline' | 'invalid') => {
    if (terminal) return
    terminal = true
    clearOutageTimer()
    clearGapTimer()
    source?.close()
    state = nextState
    reason = error.message
    notify()
    options.onError?.(error)
  }

  const startGapTimer = () => {
    if (gapTimer !== null || terminal) return
    gapTimer = clock.setTimeout(() => {
      gapTimer = null
      const firstBuffered = Math.min(...buffered.keys())
      fail(
        new RankedClientError(
          'stream_gap',
          `Ranked stream missed sequence ${lastSequence + 1} before ${firstBuffered}.`,
        ),
        'invalid',
      )
    }, gapAfterMs)
  }

  const deliver = (event: SignedRoundEvent) => {
    lastSequence = event.sequence
    options.onEvent(event)
  }

  const drain = () => {
    for (;;) {
      const next = buffered.get(lastSequence + 1)
      if (next === undefined) break
      buffered.delete(next.sequence)
      deliver(next)
    }
    if (buffered.size === 0) {
      clearGapTimer()
      if (state === 'reconnecting' && outageTimer === null) {
        state = 'open'
        reason = null
      }
    }
    notify()
  }

  const onOpen = () => {
    if (terminal) return
    clearOutageTimer()
    if (buffered.size > 0) {
      state = 'reconnecting'
      reason = `Waiting for sequence ${lastSequence + 1}`
    } else {
      state = 'open'
      reason = null
    }
    notify()
  }

  const onError = () => {
    if (terminal) return
    state = 'reconnecting'
    reason = 'Connection interrupted; native EventSource is retrying with Last-Event-ID.'
    notify()
    if (outageTimer !== null) return
    outageTimer = clock.setTimeout(() => {
      outageTimer = null
      fail(
        new RankedClientError(
          'network_error',
          `Ranked event stream stayed disconnected for ${offlineAfterMs} ms.`,
        ),
        'offline',
      )
    }, offlineAfterMs)
  }

  const onRoundEvent = (rawEvent: Event) => {
    if (terminal) return
    try {
      const message = rawEvent as MessageEvent<string>
      if (typeof message.data !== 'string') {
        throw new TypeError('round_event data was not text')
      }
      if (!/^(?:0|[1-9][0-9]*)$/.test(message.lastEventId)) {
        throw new TypeError('round_event did not carry a canonical Last-Event-ID')
      }
      const eventId = Number(message.lastEventId)
      if (!Number.isSafeInteger(eventId)) throw new TypeError('round_event id exceeds safe integer range')
      const parsed = parser.parseEvent(JSON.parse(message.data) as unknown)
      if (parsed.sequence !== eventId) {
        throw new TypeError('round_event id does not match its signed sequence')
      }
      if (parsed.sequence <= lastSequence || buffered.has(parsed.sequence)) return
      if (parsed.sequence === lastSequence + 1) {
        deliver(parsed)
        drain()
        return
      }
      buffered.set(parsed.sequence, parsed)
      state = 'reconnecting'
      reason = `Waiting for sequence ${lastSequence + 1}`
      startGapTimer()
      notify()
    } catch (error) {
      fail(
        new RankedClientError(
          'stream_malformed',
          `Malformed ranked stream event: ${errorMessage(error)}`,
          { cause: error },
        ),
        'invalid',
      )
    }
  }

  function attach(): void {
    state = 'connecting'
    reason = null
    notify()
    source = sourceFactory(options.url, {
      withCredentials: options.withCredentials ?? false,
      lastEventId: lastSequence < 0 ? null : String(lastSequence),
    })
    source.addEventListener('open', onOpen)
    source.addEventListener('error', onError)
    source.addEventListener('round_event', onRoundEvent)
  }

  attach()

  return {
    snapshot,
    reconnect() {
      if (terminal) throw new RankedClientError('network_error', 'Ranked stream is terminal.')
      source?.removeEventListener('open', onOpen)
      source?.removeEventListener('error', onError)
      source?.removeEventListener('round_event', onRoundEvent)
      source?.close()
      clearOutageTimer()
      attach()
    },
    close() {
      if (terminal && state === 'closed') return
      terminal = true
      clearOutageTimer()
      clearGapTimer()
      source?.removeEventListener('open', onOpen)
      source?.removeEventListener('error', onError)
      source?.removeEventListener('round_event', onRoundEvent)
      source?.close()
      state = 'closed'
      reason = null
      notify()
    },
  }
}
