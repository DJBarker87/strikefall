import { describe, expect, it, vi } from 'vitest'
import { roundCreatedEvent, signedEvent } from './_fixtures'
import type { RankedClock, TimerHandle } from './client'
import type { RankedClientError } from './errors'
import {
  connectRankedEventStream,
  type EventSourceFactoryOptions,
  type EventSourceLike,
} from './stream'

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

class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  closed = false

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  close() {
    this.closed = true
  }

  emit(type: string, event: Event = new Event(type)) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  roundEvent(event: unknown, lastEventId: string) {
    this.emit('round_event', new MessageEvent('round_event', {
      data: JSON.stringify(event),
      lastEventId,
    }))
  }
}

function harness() {
  const sources: FakeEventSource[] = []
  const factoryCalls: EventSourceFactoryOptions[] = []
  const factory = vi.fn((_: string, options: EventSourceFactoryOptions) => {
    factoryCalls.push(options)
    const source = new FakeEventSource()
    sources.push(source)
    return source
  })
  return { sources, factoryCalls, factory }
}

describe('ranked signed event stream', () => {
  it('uses Last-Event-ID across reconnects and deduplicates/reorders snapshot events', () => {
    const { sources, factoryCalls, factory } = harness()
    const delivered: number[] = []
    const states: string[] = []
    const stream = connectRankedEventStream({
      url: '/v1/solo-rounds/round-1/stream',
      protocolVersion: 'strikefall/ranked-replay/v3',
      eventSource: factory,
      onEvent: ({ sequence }) => delivered.push(sequence),
      onState: ({ state }) => states.push(state),
    })
    const source = sources[0]
    expect(source).toBeDefined()
    source?.emit('open')
    source?.roundEvent(roundCreatedEvent(0), '0')
    source?.emit('error')
    source?.emit('open')
    source?.roundEvent(roundCreatedEvent(0), '0')
    source?.roundEvent(signedEvent(2, {
      type: 'battle_frame',
      data: { point: { step: 2, varianceElapsed: '2', logReturn: '1', price: '100', intervalHigh: '100', intervalLow: '100' } },
    }), '2')
    expect(stream.snapshot()).toMatchObject({
      state: 'reconnecting',
      lastSequence: 0,
      bufferedSequences: [2],
    })
    source?.roundEvent(signedEvent(1, {
      type: 'battle_frame',
      data: { point: { step: 1, varianceElapsed: '1', logReturn: '0', price: '100', intervalHigh: '100', intervalLow: '100' } },
    }), '1')

    expect(delivered).toEqual([0, 1, 2])
    expect(stream.snapshot()).toMatchObject({
      state: 'open',
      lastSequence: 2,
      lastEventId: '2',
      bufferedSequences: [],
    })
    stream.reconnect()
    expect(factoryCalls).toEqual([
      { withCredentials: false, lastEventId: null },
      { withCredentials: false, lastEventId: '2' },
    ])
    expect(states).toContain('reconnecting')
    stream.close()
  })

  it('invalidates a sequence gap that cannot be filled inside the grace window', () => {
    const clock = new ManualClock()
    const { sources, factory } = harness()
    const errors: RankedClientError[] = []
    const stream = connectRankedEventStream({
      url: '/stream',
      protocolVersion: 'strikefall/ranked-replay/v3',
      eventSource: factory,
      clock,
      gapAfterMs: 250,
      onEvent: vi.fn(),
      onError: (error) => errors.push(error),
    })
    sources[0]?.roundEvent(signedEvent(1, {
      type: 'battle_frame',
      data: { point: { step: 1, varianceElapsed: '1', logReturn: '0', price: '100', intervalHigh: '100', intervalLow: '100' } },
    }), '1')
    clock.advance(251)

    expect(stream.snapshot()).toMatchObject({ state: 'invalid', bufferedSequences: [1] })
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe('stream_gap')
  })

  it('moves from reconnecting to explicitly offline after an outage', () => {
    const clock = new ManualClock()
    const { sources, factory } = harness()
    const stream = connectRankedEventStream({
      url: '/stream',
      protocolVersion: 'strikefall/ranked-replay/v3',
      eventSource: factory,
      clock,
      offlineAfterMs: 500,
      onEvent: vi.fn(),
    })
    sources[0]?.emit('error')
    expect(stream.snapshot().state).toBe('reconnecting')
    clock.advance(501)
    expect(stream.snapshot().state).toBe('offline')
    expect(sources[0]?.closed).toBe(true)
  })

  it('rejects malformed event ids and payloads before delivery', () => {
    const { sources, factory } = harness()
    const delivered = vi.fn()
    const stream = connectRankedEventStream({
      url: '/stream',
      protocolVersion: 'strikefall/ranked-replay/v3',
      eventSource: factory,
      onEvent: delivered,
    })
    sources[0]?.roundEvent(roundCreatedEvent(0), '01')
    expect(delivered).not.toHaveBeenCalled()
    expect(stream.snapshot().state).toBe('invalid')
    expect(stream.snapshot().reason).toContain('canonical Last-Event-ID')
  })
})
