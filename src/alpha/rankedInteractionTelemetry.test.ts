import { describe, expect, it, vi } from 'vitest'
import { createRound } from '../game'
import {
  createRankedInteractionTelemetryEvent,
  sendRankedInteractionTelemetry,
} from './rankedInteractionTelemetry'

describe('ranked interaction telemetry', () => {
  it('creates a fixed dead-player response shape without client timing claims', () => {
    const round = createRound('telemetry-round-7')
    const event = createRankedInteractionTelemetryEvent(round, {
      name: 'dead_player_response',
      action: 'rematch',
    }, 1_700_000_000_000)

    expect(event).toMatchObject({
      name: 'dead_player_response',
      occurredAtMs: 1_700_000_000_000,
      properties: {
        action: 'rematch',
        deckId: round.deck.id.replaceAll('-', '_'),
        roundId: round.roundId,
      },
    })
    expect(Object.keys(event?.properties ?? {}).sort()).toEqual([
      'action',
      'deckId',
      'roundId',
    ])
  })

  it('sends only with consent and swallows transport failure', async () => {
    const round = createRound('telemetry-round-8')
    const sendTelemetry = vi.fn().mockRejectedValue(new Error('offline'))

    sendRankedInteractionTelemetry({
      enabled: false,
      api: { sendTelemetry },
      round,
      input: { name: 'share_opened' },
    })
    expect(sendTelemetry).not.toHaveBeenCalled()

    sendRankedInteractionTelemetry({
      enabled: true,
      api: { sendTelemetry },
      round,
      input: { name: 'clip_exported' },
      occurredAtMs: 1_700_000_000_001,
    })
    expect(sendTelemetry).toHaveBeenCalledTimes(1)
    expect(sendTelemetry.mock.calls[0]?.[0]?.[0]).toMatchObject({
      name: 'clip_exported',
      properties: {
        deckId: round.deck.id.replaceAll('-', '_'),
        roundId: round.roundId,
      },
    })
    await Promise.resolve()
  })
})
