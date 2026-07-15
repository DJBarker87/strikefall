import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import replayFixture from '../../crates/strikefall-protocol/tests/fixtures/ranked_replay_v3.json'
import { parseReplayBundle } from '../ranked/validation'
import type { RankedReplayVerificationReport } from '../ranked/verifier'
import { RankedReplayReportView } from './RankedReplayViewer'
import { deriveRankedReplayView, formatReplayFixed } from './derive'

function verifiedReport(): RankedReplayVerificationReport {
  return {
    valid: true,
    protocolVersion: 'strikefall/ranked-replay/v3',
    browserChecks: [
      'external create-response anchors',
      'canonical result proof digest',
      'every Ed25519 event signature',
    ],
    delegatedChecks: [
      'deck_catalog',
      'path_regeneration',
      'bot_roster',
      'bot_placement_audit',
      'final_placements',
      'locked_scores',
      'touches',
      'round_result',
      'bot_escape_audit',
      'event_semantics',
    ],
    regenerationVerifier: 'strikefall-wasm/verify_replay_bundle_against/v2',
    digests: {
      deck: replayFixture.reveal.deckDigest as never,
      path: replayFixture.reveal.pathDigest as never,
      commitment: replayFixture.commitment as never,
      lockedScores: replayFixture.events[0]?.digest as never,
      resultProof: replayFixture.result.proofDigest as never,
      events: [],
    },
  }
}

describe('ranked replay view derivation', () => {
  it('keeps canonical decimals intact while deriving display-only readings', () => {
    const bundle = parseReplayBundle(structuredClone(replayFixture))
    const originalScore = bundle.result.score
    const view = deriveRankedReplayView(bundle, verifiedReport())

    expect(view.result.score.raw).toBe(replayFixture.result.score)
    expect(view.result.score.display).toBe(formatReplayFixed(replayFixture.result.score as never, 0))
    expect(bundle.result.score).toBe(originalScore)
    expect(view.path.initial).toEqual({ raw: '100000000000000', display: '100.00' })
    expect(formatReplayFixed('999999999999' as never, 2)).toBe('1.00')
  })

  it('derives ordered standings and only proof-bearing dramatic timeline events', () => {
    const bundle = parseReplayBundle(structuredClone(replayFixture))
    const view = deriveRankedReplayView(bundle, verifiedReport())
    const dramaticEvents = bundle.events.filter(({ kind }) => [
      'flag_hit',
      'flag_cluster',
      'escape_accepted',
    ].includes(kind.type))

    expect(view.standings).toHaveLength(20)
    expect(view.standings.map(({ rank }) => rank)).toEqual(
      [...view.standings.map(({ rank }) => rank)].sort((left, right) => left - right),
    )
    expect(view.player).toMatchObject({
      contenderId: 0,
      name: 'YOU',
      rank: bundle.result.rank,
      isPlayer: true,
    })
    expect(view.timeline).toHaveLength(dramaticEvents.length)
    expect(view.timeline.some(({ kind, title }) => kind === 'hit' && title.includes('struck'))).toBe(true)
    expect(view.timeline.some(({ kind }) => kind === 'cluster')).toBe(true)
    expect(view.timeline.some(({ kind }) => kind === 'escape')).toBe(true)
    expect(view.timeline.every(({ signature, digest }) => (
      signature.raw.length === 128 && digest.raw.length === 64
    ))).toBe(true)
    expect(view.botAudit).toHaveLength(19)
    expect(view.botAudit.every(({ botLabel, decisions }) => (
      botLabel === 'BOT'
      && decisions.length >= 1
      && decisions.length <= 3
      && decisions.every(({ candidateCount, candidates }) => (
        candidateCount === 12 && candidates.length === 12
      ))
    ))).toBe(true)
  })

  it('renders verified proof, standings, signed drama, and reveal summaries', () => {
    const bundle = parseReplayBundle(structuredClone(replayFixture))
    const view = deriveRankedReplayView(bundle, verifiedReport())
    const html = renderToStaticMarkup(
      <RankedReplayReportView
        view={view}
        onBack={() => undefined}
        onShare={() => undefined}
      />,
    )

    expect(html).toContain('Verified in this browser')
    expect(html).toContain(`${view.deck.displayName} · deck v${view.deck.version}`)
    expect(html).toContain('Commitment')
    expect(html).toContain('Publisher key')
    expect(html).toContain('Standings')
    expect(html).toContain('Collision timeline')
    expect(html).toContain('Bot decision audit')
    expect(html).toContain('BOT')
    expect(html).toContain('candidate scores')
    expect(html).toContain('observed')
    expect(html).toContain('acted')
    expect(html).toContain('Reaction')
    expect(html).toContain('Chosen utility')
    expect(html).toContain('Inspect revealed material')
    expect(html).toContain(view.reveal.pathSeed)
    expect(html).toContain('Share verified replay')
    expect(html).toContain('Play a fresh round')
  })
})
