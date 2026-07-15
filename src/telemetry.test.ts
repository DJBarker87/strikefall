import { describe, expect, it } from 'vitest'
import {
  TELEMETRY_STORAGE_KEY,
  clearLocalTelemetry,
  readLocalTelemetry,
  type StrikefallTelemetryEvent,
  type TelemetryStorage,
} from './telemetry'

class MemoryStorage implements TelemetryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

function event(id: string): StrikefallTelemetryEvent {
  return {
    id,
    name: 'round_completed',
    at: '2026-07-14T12:00:00.000Z',
    sessionId: 'session',
    roundId: 'round',
    payload: { score: 42 },
  }
}

describe('bounded local telemetry storage', () => {
  it('reads the local event queue without a network-capable export path', () => {
    const storage = new MemoryStorage()
    storage.setItem(TELEMETRY_STORAGE_KEY, JSON.stringify([event('one'), event('two')]))
    expect(readLocalTelemetry(storage).map(({ id }) => id)).toEqual(['one', 'two'])
  })

  it('fails closed on malformed storage and clears the queue on request', () => {
    const storage = new MemoryStorage()
    storage.setItem(TELEMETRY_STORAGE_KEY, '{bad json')
    expect(readLocalTelemetry(storage)).toEqual([])
    storage.setItem(TELEMETRY_STORAGE_KEY, JSON.stringify([event('one')]))
    clearLocalTelemetry(storage)
    expect(readLocalTelemetry(storage)).toEqual([])
  })
})
