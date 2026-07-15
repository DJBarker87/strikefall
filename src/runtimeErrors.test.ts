import { describe, expect, it, vi } from 'vitest'
import type { ClientErrorProperties } from './telemetry'
import { createClientRuntimeErrorReporter } from './runtimeErrors'

class FakeRuntimeTarget {
  readonly listeners = new Map<string, Set<EventListener>>()

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe('client runtime error reporting', () => {
  it('deduplicates the same Error across Window and React without serializing diagnostics', () => {
    const local: ClientErrorProperties[] = []
    const reporter = createClientRuntimeErrorReporter({
      emitLocal: (properties) => local.push(properties),
      resolveSurface: () => 'arena',
    })
    const error = Object.assign(new Error('private failure message'), {
      filename: '/private/player/path.ts',
    })

    expect(reporter.captureWindowError({ error })).toBe(true)
    expect(reporter.report({ cause: error, code: 'render_failure' })).toBe(false)
    expect(local).toEqual([{ code: 'uncaught_exception', surface: 'arena' }])
    expect(Object.keys(local[0] ?? {})).toEqual(['code', 'surface'])
    expect(JSON.stringify(local)).not.toContain('private')
    expect(JSON.stringify(local)).not.toContain('stack')
  })

  it('installs one global listener pair and reference-counts cleanup', () => {
    const emitted = vi.fn()
    const reporter = createClientRuntimeErrorReporter({
      emitLocal: emitted,
      resolveSurface: () => 'replay',
    })
    const target = new FakeRuntimeTarget()
    const firstCleanup = reporter.install(target as unknown as Window)
    const secondCleanup = reporter.install(target as unknown as Window)

    expect(target.listeners.get('error')?.size).toBe(1)
    expect(target.listeners.get('unhandledrejection')?.size).toBe(1)
    target.emit('unhandledrejection', { reason: 'private rejection' } as unknown as Event)
    expect(emitted).toHaveBeenCalledWith({
      code: 'unhandled_rejection',
      surface: 'replay',
    })

    firstCleanup()
    expect(target.listeners.get('error')?.size).toBe(1)
    secondCleanup()
    expect(target.listeners.get('error')?.size).toBe(0)
    expect(target.listeners.get('unhandledrejection')?.size).toBe(0)
  })

  it('stops sharing immediately when the registered transport is removed', () => {
    const local = vi.fn()
    const shared = vi.fn()
    const reporter = createClientRuntimeErrorReporter({ emitLocal: local })
    const stopSharing = reporter.setTransport(shared)

    reporter.report({ cause: new Error('first'), code: 'render_failure', surface: 'arena' })
    stopSharing()
    reporter.report({ cause: new Error('second'), code: 'render_failure', surface: 'arena' })

    expect(local).toHaveBeenCalledTimes(2)
    expect(shared).toHaveBeenCalledTimes(1)
  })
})
