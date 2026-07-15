import { type RankedClock, type TimerHandle, systemRankedClock } from './client'
import { resolveBearerToken, type BearerTokenSource } from './auth'
import type {
  EventSourceFactory,
  EventSourceFactoryOptions,
  EventSourceLike,
} from './stream'

export interface AuthenticatedFetchEventSourceOptions {
  bearerToken: BearerTokenSource
  fetch?: typeof globalThis.fetch
  clock?: RankedClock
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

interface ParsedEvent {
  type: string
  data: string
  lastEventId: string
}

function positiveDelay(value: number | undefined, fallback: number, label: string): number {
  const delay = value ?? fallback
  if (!Number.isFinite(delay) || delay <= 0) throw new TypeError(`${label} must be positive`)
  return Math.round(delay)
}

class SseParser {
  private buffer = ''
  private data: string[] = []
  private eventType = ''
  private lastEventId: string

  constructor(
    initialLastEventId: string | null,
    private readonly dispatch: (event: ParsedEvent) => void,
    private readonly setRetry: (delayMs: number) => void,
    private readonly setLastEventId: (lastEventId: string) => void,
  ) {
    this.lastEventId = initialLastEventId ?? ''
  }

  push(chunk: string): void {
    this.buffer += chunk
    this.drain(false)
  }

  finish(): void {
    this.drain(true)
  }

  private drain(atEnd: boolean): void {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer)
      if (match === null) break
      if (!atEnd && match[0] === '\r' && match.index === this.buffer.length - 1) break
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.line(line)
    }
    if (atEnd && this.buffer.length > 0) {
      this.line(this.buffer)
      this.buffer = ''
    }
  }

  private line(line: string): void {
    if (line.length === 0) {
      if (this.data.length === 0) {
        this.eventType = ''
        return
      }
      this.dispatch({
        type: this.eventType || 'message',
        data: this.data.join('\n'),
        lastEventId: this.lastEventId,
      })
      this.data = []
      this.eventType = ''
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'data':
        this.data.push(value)
        break
      case 'event':
        this.eventType = value
        break
      case 'id':
        if (!value.includes('\0')) {
          this.lastEventId = value
          this.setLastEventId(value)
        }
        break
      case 'retry':
        if (/^[0-9]+$/.test(value)) this.setRetry(Number(value))
        break
    }
  }
}

class AuthenticatedFetchEventSource implements EventSourceLike {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly clock: RankedClock
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly withCredentials: boolean
  private lastEventId: string | null
  private reconnectAttempt = 0
  private serverRetryMs: number | null = null
  private reconnectTimer: TimerHandle | null = null
  private controller: AbortController | null = null
  private closed = false

  constructor(
    private readonly url: string,
    private readonly bearerToken: BearerTokenSource,
    factoryOptions: EventSourceFactoryOptions,
    dependencies: Omit<Required<AuthenticatedFetchEventSourceOptions>, 'bearerToken'>,
  ) {
    this.fetchImpl = dependencies.fetch
    this.clock = dependencies.clock
    this.reconnectBaseMs = dependencies.reconnectBaseMs
    this.reconnectMaxMs = dependencies.reconnectMaxMs
    this.withCredentials = factoryOptions.withCredentials
    this.lastEventId = factoryOptions.lastEventId
    void this.connect()
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.reconnectTimer !== null) this.clock.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.controller?.abort()
    this.controller = null
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return
    const exponential = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * (2 ** Math.min(this.reconnectAttempt, 16)),
    )
    const delay = this.serverRetryMs ?? exponential
    this.reconnectAttempt += 1
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private async connect(): Promise<void> {
    if (this.closed) return
    const controller = new AbortController()
    this.controller = controller
    try {
      const token = await resolveBearerToken(this.bearerToken)
      if (this.closed) return
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`,
      }
      if (this.lastEventId !== null) headers['last-event-id'] = this.lastEventId
      // `window.fetch` is receiver-sensitive in Chromium. Calling the stored
      // function as `this.fetchImpl(...)` supplies this EventSource instance
      // as the receiver and fails with `TypeError: Illegal invocation` before
      // any network request leaves the browser.
      const fetchImpl = this.fetchImpl
      const response = await fetchImpl(this.url, {
        method: 'GET',
        headers,
        credentials: this.withCredentials ? 'include' : 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) {
        throw new Error(`ranked stream transport returned HTTP ${response.status}`)
      }
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        throw new Error('ranked stream transport did not return event-stream content')
      }
      if (this.closed) return
      this.reconnectAttempt = 0
      this.emit('open', new Event('open'))
      const parser = new SseParser(
        this.lastEventId,
        ({ type, data, lastEventId }) => {
          this.emit(type, new MessageEvent(type, { data, lastEventId }))
        },
        (delayMs) => {
          this.serverRetryMs = Math.min(this.reconnectMaxMs, Math.max(1, delayMs))
        },
        (lastEventId) => {
          this.lastEventId = lastEventId.length === 0 ? null : lastEventId
        },
      )
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parser.push(decoder.decode(value, { stream: true }))
      }
      parser.push(decoder.decode())
      parser.finish()
      if (!this.closed) {
        this.emit('error', new Event('error'))
        this.scheduleReconnect()
      }
    } catch {
      if (!this.closed && !controller.signal.aborted) {
        this.emit('error', new Event('error'))
        this.scheduleReconnect()
      }
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }
}

/**
 * EventSource-compatible fetch transport for authenticated ranked SSE.
 * Bearer credentials are header-only and are resolved again on every retry.
 */
export function createAuthenticatedFetchEventSourceFactory(
  options: AuthenticatedFetchEventSourceOptions,
): EventSourceFactory {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch implementation is required')
  const clock = options.clock ?? systemRankedClock
  const reconnectBaseMs = positiveDelay(options.reconnectBaseMs, 500, 'reconnectBaseMs')
  const reconnectMaxMs = positiveDelay(options.reconnectMaxMs, 10_000, 'reconnectMaxMs')
  if (reconnectMaxMs < reconnectBaseMs) {
    throw new TypeError('reconnectMaxMs must be at least reconnectBaseMs')
  }
  return (url, factoryOptions) => new AuthenticatedFetchEventSource(
    url,
    options.bearerToken,
    factoryOptions,
    { fetch: fetchImpl, clock, reconnectBaseMs, reconnectMaxMs },
  )
}
