import { useEffect, useRef } from 'react'
import type { RoundState } from '../game'
import type { PlayerEscapeTelemetry } from '../hooks/useStrikefallGame'
import type { AlphaApiClient } from './client'
import type { AlphaTelemetryEvent } from './types'

export interface RankedAlphaTelemetryOptions {
  readonly enabled: boolean
  readonly api: AlphaApiClient | null
  readonly active: boolean
  readonly round: RoundState
  readonly escape: PlayerEscapeTelemetry | null
  readonly replayReceipt: 'idle' | 'pending' | 'recorded' | 'failed'
}

interface TelemetryMemory {
  readonly observed: Set<string>
  readonly startedAt: Map<string, number>
}

function eventId(): string | null {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : null
}

export function createRankedAlphaEvent(
  name: AlphaTelemetryEvent['name'],
  properties: AlphaTelemetryEvent['properties'],
  occurredAtMs = Date.now(),
): AlphaTelemetryEvent | null {
  const id = eventId()
  if (!id) return null
  return { eventId: id, name, occurredAtMs, properties }
}

function serverDeckId(round: RoundState): string {
  return round.deck.id.replaceAll('-', '_')
}

/**
 * Emits no retroactive events: a transition first observed while consent is
 * off is marked consumed, and switching consent on later starts with the next
 * transition. Upload failures are not placed in a hidden retry queue.
 */
export function useRankedAlphaTelemetry(options: RankedAlphaTelemetryOptions): void {
  const memory = useRef<TelemetryMemory>({ observed: new Set(), startedAt: new Map() })

  useEffect(() => {
    if (!options.active || options.round.phase === 'home') return
    const now = Date.now()
    const roundId = options.round.roundId
    const deckId = serverDeckId(options.round)
    const events: AlphaTelemetryEvent[] = []
    const observe = (
      key: string,
      name: AlphaTelemetryEvent['name'],
      properties: AlphaTelemetryEvent['properties'],
    ) => {
      if (memory.current.observed.has(key)) return
      memory.current.observed.add(key)
      if (!options.enabled || !options.api) return
      const event = createRankedAlphaEvent(name, properties, now)
      if (event) events.push(event)
    }

    const startKey = `${roundId}:started`
    if (!memory.current.observed.has(startKey)) {
      memory.current.startedAt.set(roundId, now)
    }
    observe(startKey, 'round_started', { deckId, roundId })

    const player = options.round.contenders.find((contender) => contender.isPlayer)
    const authoritativeLock = options.round.feed.some(
      (event) => event.id === `${roundId}-ranked-lock`,
    )
    if (authoritativeLock && player) {
      observe(`${roundId}:locked`, 'placement_locked', {
        deckId,
        roundId,
        side: player.side,
      })
    }

    if (options.escape?.roundId === roundId) {
      observe(`${roundId}:escape`, 'escape_used', {
        deckId,
        roundId,
        step: options.escape.frame,
      })
    }

    if (options.round.phase === 'result' && options.round.summary) {
      const startedAt = memory.current.startedAt.get(roundId) ?? now - 1_000
      observe(`${roundId}:completed`, 'round_completed', {
        deckId,
        durationMs: Math.max(1_000, Math.min(300_000, now - startedAt)),
        outcome: options.round.summary.outcome,
        rank: options.round.summary.rank,
        roundId,
      })
    }

    if (options.replayReceipt === 'recorded') {
      observe(`${roundId}:verified`, 'replay_verified', { deckId, roundId })
    }

    for (const event of events) {
      void options.api?.sendTelemetry([event]).catch(() => {
        // Consent-aware telemetry never blocks play and has no implicit retry.
      })
    }

    if (memory.current.observed.size > 1_000) {
      const keepRound = [...memory.current.observed].filter((key) => key.startsWith(`${roundId}:`))
      memory.current.observed.clear()
      for (const key of keepRound) memory.current.observed.add(key)
      const currentStartedAt = memory.current.startedAt.get(roundId)
      memory.current.startedAt.clear()
      if (currentStartedAt !== undefined) memory.current.startedAt.set(roundId, currentStartedAt)
    }
  }, [
    options.active,
    options.api,
    options.enabled,
    options.escape,
    options.replayReceipt,
    options.round,
  ])
}
