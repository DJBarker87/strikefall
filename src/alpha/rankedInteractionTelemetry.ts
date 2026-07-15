import type { RoundState } from '../game'
import type { AlphaApiClient } from './client'
import type { AlphaTelemetryEvent } from './types'
import { createRankedAlphaEvent } from './useRankedAlphaTelemetry'

export type RankedInteractionTelemetryInput =
  | { readonly name: 'dead_player_response'; readonly action: 'spectate' | 'rematch' }
  | { readonly name: 'share_opened' }
  | { readonly name: 'clip_exported' }

function serverDeckId(round: RoundState): string {
  return round.deck.id.replaceAll('-', '_')
}

export function createRankedInteractionTelemetryEvent(
  round: RoundState,
  input: RankedInteractionTelemetryInput,
  occurredAtMs = Date.now(),
): AlphaTelemetryEvent | null {
  const common = {
    deckId: serverDeckId(round),
    roundId: round.roundId,
  }
  if (input.name === 'dead_player_response') {
    return createRankedAlphaEvent(input.name, {
      ...common,
      action: input.action,
    }, occurredAtMs)
  }
  return createRankedAlphaEvent(input.name, common, occurredAtMs)
}

/**
 * Interaction telemetry is deliberately best-effort. It never delays the
 * player's rematch/share action and never creates a retry queue after consent
 * is withdrawn.
 */
export function sendRankedInteractionTelemetry(options: {
  readonly enabled: boolean
  readonly api: Pick<AlphaApiClient, 'sendTelemetry'> | null
  readonly round: RoundState
  readonly input: RankedInteractionTelemetryInput
  readonly occurredAtMs?: number
}): void {
  if (!options.enabled || !options.api) return
  const event = createRankedInteractionTelemetryEvent(
    options.round,
    options.input,
    options.occurredAtMs,
  )
  if (!event) return
  void options.api.sendTelemetry([event]).catch(() => {
    // Product analytics must never block or alter a game interaction.
  })
}
