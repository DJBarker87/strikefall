import { describe, expect, it, vi } from 'vitest'
import {
  H3,
  createResponse,
  jsonResponse,
  replayBundle,
  result,
  reveal,
} from './_fixtures'
import { createRankedClient, type RankedClock, type TimerHandle } from './client'
import { createRankedRoundController } from './controller'
import { RankedSubmissionDisabledError } from './errors'
import type { EventSourceLike } from './stream'
import { parseUnsignedDecimalString } from './validation'

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
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()
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

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type))
  }
}

describe('ranked attempt controller', () => {
  it('degrades an interrupted ranked round to unmistakably unranked local practice', async () => {
    const clock = new ManualClock()
    const source = new FakeEventSource()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(createResponse(), { status: 201 }),
    )
    const controller = createRankedRoundController({
      client: createRankedClient({ baseUrl: '/api', fetch: fetchMock, clock }),
      eventSource: () => source,
      clock,
      streamOfflineAfterMs: 400,
    })

    await expect(controller.start()).resolves.toMatchObject({ roundId: 'round-1' })
    source.emit('open')
    expect(controller.state()).toMatchObject({
      mode: 'ranked',
      connection: 'live',
      rankedSubmissionAllowed: true,
    })
    source.emit('error')
    expect(controller.state().connection).toBe('reconnecting')
    clock.advance(401)
    expect(controller.state()).toMatchObject({
      mode: 'local_practice',
      phase: 'active',
      connection: 'offline',
      rankedSubmissionAllowed: false,
    })

    controller.completeLocalPractice({
      score: 123.5,
      outcome: 'survived',
      completedAtMs: 2_000,
    })
    expect(controller.state()).toMatchObject({
      mode: 'local_practice',
      phase: 'completed',
      localResult: { score: 123.5 },
    })
    await expect(controller.updateFlag({
      side: 'upper',
      barrier: parseUnsignedDecimalString('110000000000000'),
    })).rejects.toBeInstanceOf(RankedSubmissionDisabledError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('degrades a ranked mutation network failure and never retries a local score', async () => {
    const source = new FakeEventSource()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse(), { status: 201 }))
      .mockRejectedValueOnce(new TypeError('offline'))
    const controller = createRankedRoundController({
      client: createRankedClient({ baseUrl: '/api', fetch: fetchMock }),
      eventSource: () => source,
    })
    await controller.start()
    await expect(controller.escape({ clientSequence: 1 })).rejects.toMatchObject({
      code: 'network_error',
    })
    expect(controller.state()).toMatchObject({
      mode: 'local_practice',
      rankedSubmissionAllowed: false,
    })
    controller.completeLocalPractice({ score: 50, outcome: 'escaped', completedAtMs: 3_000 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidates a resolved round when its replay no longer matches its create anchor', async () => {
    const source = new FakeEventSource()
    const changedReplay = replayBundle()
    changedReplay.commitment = H3
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse(), { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({
        roundId: 'round-1',
        status: 'resolved',
        result: result(),
        reveal: reveal(),
      }))
      .mockResolvedValueOnce(jsonResponse(changedReplay))
    const controller = createRankedRoundController({
      client: createRankedClient({ baseUrl: '/api', fetch: fetchMock }),
      eventSource: () => source,
    })
    await controller.start()

    await expect(controller.finalize()).rejects.toMatchObject({ code: 'protocol_mismatch' })
    expect(controller.state()).toMatchObject({
      mode: 'invalid',
      connection: 'invalid',
      rankedSubmissionAllowed: false,
      replayValidity: 'invalid',
    })
  })

  it('marks a fully anchored and independently accepted replay valid', async () => {
    const source = new FakeEventSource()
    const verifier = vi.fn(() => true)
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse(), { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({
        roundId: 'round-1',
        status: 'resolved',
        result: result(),
        reveal: reveal(),
      }))
      .mockResolvedValueOnce(jsonResponse(replayBundle()))
    const controller = createRankedRoundController({
      client: createRankedClient({ baseUrl: '/api', fetch: fetchMock }),
      eventSource: () => source,
      verifyReplay: verifier,
    })
    await controller.start()
    await expect(controller.finalize()).resolves.toMatchObject({ roundId: 'round-1' })
    expect(verifier).toHaveBeenCalledOnce()
    expect(controller.state()).toMatchObject({
      mode: 'ranked',
      phase: 'completed',
      connection: 'resolved',
      rankedSubmissionAllowed: false,
      replayValidity: 'valid',
    })
  })

  it('throws a bounded verification failure when an independently checked replay is rejected', async () => {
    const source = new FakeEventSource()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse(), { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({
        roundId: 'round-1',
        status: 'resolved',
        result: result(),
        reveal: reveal(),
      }))
      .mockResolvedValueOnce(jsonResponse(replayBundle()))
    const controller = createRankedRoundController({
      client: createRankedClient({ baseUrl: '/api', fetch: fetchMock }),
      eventSource: () => source,
      verifyReplay: () => false,
    })
    await controller.start()

    await expect(controller.finalize()).rejects.toMatchObject({
      code: 'verification_failed',
      check: 'replay_consistency',
    })
    expect(controller.state()).toMatchObject({
      mode: 'invalid',
      connection: 'invalid',
      rankedSubmissionAllowed: false,
      replayValidity: 'invalid',
    })
  })
})
