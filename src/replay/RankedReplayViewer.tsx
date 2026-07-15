import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  Clock3,
  Flag,
  Key,
  RotateCcw,
  Route,
  Share2,
  ShieldCheck,
  Trophy,
  Users,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  RankedClientError,
  RankedPayloadError,
  RankedReplayVerificationError,
} from '../ranked/errors'
import { isRankedReplayId } from './id'
import { createRankedReplayShareUrl } from './shareUrl'
import {
  loadVerifiedRankedReplay,
  type RankedReplayLoader,
  type VerifiedRankedReplay,
} from './verify'
import type {
  RankedReplayViewModel,
  ReplayFingerprint,
  ReplayTimelineItem,
} from './derive'
import type { HexString } from '../ranked/types'
import './replay.css'

export interface RankedReplayViewerProps {
  readonly replayId: string
  readonly loader: RankedReplayLoader
  readonly shareBaseUrl?: string | URL
  readonly onShare?: (safeShareUrl: string) => void | Promise<void>
  /** Starts a new seeded attempt; distinct from navigation used by error states. */
  readonly onPlayFresh?: () => void
  readonly onBack?: () => void
  readonly onVerified?: (receipt: RankedReplayViewerReceipt) => void
  readonly className?: string
}

export interface RankedReplayViewerReceipt {
  readonly roundId: string
  readonly proofDigest: HexString
  readonly verifier: string
}

type ViewerState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly replay: VerifiedRankedReplay }
  | {
    readonly status: 'error'
    readonly kind: 'load' | 'proof'
    readonly title: string
    readonly message: string
    readonly check?: string
  }

type ShareState = 'idle' | 'working' | 'done' | 'error'

function proofFailure(error: unknown): ViewerState | null {
  if (error instanceof RankedReplayVerificationError) {
    return {
      status: 'error',
      kind: 'proof',
      title: error.code === 'verification_unavailable'
        ? 'Verification is unavailable'
        : 'This proof is invalid',
      message: error.code === 'verification_unavailable'
        ? 'Strikefall could not run every required cryptographic and deterministic check. No result has been trusted.'
        : 'The replay failed a cryptographic or deterministic check. Its standings and result remain hidden.',
      check: error.check,
    }
  }
  if (
    error instanceof RankedPayloadError
    || (error instanceof RankedClientError && [
      'malformed_response',
      'protocol_mismatch',
      'unsupported_protocol',
    ].includes(error.code))
  ) {
    return {
      status: 'error',
      kind: 'proof',
      title: 'This replay cannot be trusted',
      message: 'The replay payload does not match the ranked protocol or its trusted pre-round anchor. No result has been shown.',
      check: error instanceof RankedPayloadError ? error.path : error.code,
    }
  }
  return null
}

function replayFailure(error: unknown): ViewerState {
  const proof = proofFailure(error)
  if (proof !== null) return proof
  return {
    status: 'error',
    kind: 'load',
    title: 'Couldn’t load this replay',
    message: 'The replay service may be offline or the round may not be available yet. Try again in a moment.',
  }
}

function Fingerprint({ label, value }: { label: string; value: ReplayFingerprint }) {
  return (
    <span className="ranked-replay-fingerprint">
      <span>{label}</span>
      <code title={value.raw}>{value.display}</code>
    </span>
  )
}

function ViewerLoading() {
  return (
    <section
      className="ranked-replay-shell ranked-replay-loading"
      aria-busy="true"
      aria-label="Loading and verifying ranked replay"
    >
      <h1 className="sr-only">Loading Strikefall replay</h1>
      <div className="ranked-replay-skeleton ranked-replay-skeleton--eyebrow" />
      <div className="ranked-replay-skeleton ranked-replay-skeleton--title" />
      <div className="ranked-replay-skeleton ranked-replay-skeleton--proof" />
      <div className="ranked-replay-loading__grid">
        <div className="ranked-replay-skeleton ranked-replay-skeleton--panel" />
        <div className="ranked-replay-skeleton ranked-replay-skeleton--panel" />
      </div>
      <p role="status">Loading replay, checking signatures, then regenerating the round…</p>
    </section>
  )
}

function ViewerError({
  state,
  onRetry,
  onBack,
}: {
  state: Extract<ViewerState, { status: 'error' }>
  onRetry: () => void
  onBack?: () => void
}) {
  return (
    <section
      className={`ranked-replay-shell ranked-replay-state ranked-replay-state--${state.kind}`}
      role="alert"
    >
      <div className="ranked-replay-state__icon" aria-hidden="true">
        <AlertTriangle size={28} />
      </div>
      <div>
        <p className="ranked-replay-eyebrow">
          {state.kind === 'proof' ? 'Fail-closed proof gate' : 'Replay unavailable'}
        </p>
        <h1>{state.title}</h1>
        <p>{state.message}</p>
        {state.check && <code className="ranked-replay-state__check">Check: {state.check}</code>}
      </div>
      <div className="ranked-replay-state__actions">
        <button className="ranked-replay-button ranked-replay-button--primary" type="button" onClick={onRetry}>
          <RotateCcw size={16} aria-hidden="true" />
          Try again
        </button>
        {onBack && (
          <button className="ranked-replay-button" type="button" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to Strikefall
          </button>
        )}
      </div>
    </section>
  )
}

function InvalidReplayId({ onBack }: { onBack?: () => void }) {
  return (
    <section className="ranked-replay-shell ranked-replay-state ranked-replay-state--proof" role="alert">
      <div className="ranked-replay-state__icon" aria-hidden="true"><AlertTriangle size={28} /></div>
      <div>
        <p className="ranked-replay-eyebrow">Invalid replay link</p>
        <h1>This replay ID isn’t valid</h1>
        <p>Open a share link produced by Strikefall. No network request was made for this address.</p>
      </div>
      {onBack && (
        <div className="ranked-replay-state__actions">
          <button className="ranked-replay-button" type="button" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to Strikefall
          </button>
        </div>
      )}
    </section>
  )
}

function TimelineIcon({ item }: { item: ReplayTimelineItem }) {
  if (item.kind === 'escape') return <Route size={17} aria-hidden="true" />
  if (item.kind === 'cluster') return <Users size={17} aria-hidden="true" />
  return <Flag size={17} aria-hidden="true" />
}

function outcomeLabel(outcome: RankedReplayViewModel['result']['outcome']) {
  return `${outcome[0]?.toUpperCase() ?? ''}${outcome.slice(1)}`
}

/** Presentational report. Use `RankedReplayViewer` at product boundaries. */
export function RankedReplayReportView({
  view,
  shareState = 'idle',
  onShare,
  onPlayFresh,
  onBack,
}: {
  readonly view: RankedReplayViewModel
  readonly shareState?: ShareState
  readonly onShare?: () => void
  readonly onPlayFresh?: () => void
  readonly onBack?: () => void
}) {
  const headingId = useId()
  const playFresh = onPlayFresh ?? onBack
  return (
    <article
      className={`ranked-replay-shell ranked-replay-report ranked-replay-report--${view.result.outcome}`}
      aria-labelledby={headingId}
    >
      <header className="ranked-replay-hero">
        <div className="ranked-replay-hero__copy">
          <p className="ranked-replay-eyebrow">
            Ranked replay · {view.deck.displayName} · deck v{view.deck.version}
          </p>
          <h1 id={headingId}>{outcomeLabel(view.result.outcome)}. Rank {view.result.rank}.</h1>
          <p>
            The public commitment, every signed event, and the revealed path were checked before this result appeared.
          </p>
          <div className="ranked-replay-hero__meta">
            <span>Round <code>{view.roundId.slice(0, 8)}</code></span>
            <span>{view.deck.duration}</span>
            <span>{view.protocolVersion.replace('strikefall/', '')}</span>
          </div>
        </div>
        <div className="ranked-replay-score" aria-label={`${view.result.score.display} points`}>
          <span>Final score</span>
          <strong>{view.result.score.display}</strong>
          <small>points</small>
        </div>
      </header>

      <section className="ranked-replay-proof" aria-labelledby={`${headingId}-proof`}>
        <div className="ranked-replay-proof__status">
          <span className="ranked-replay-proof__shield" aria-hidden="true"><ShieldCheck size={23} /></span>
          <div>
            <p className="ranked-replay-eyebrow">Proof status</p>
            <h2 id={`${headingId}-proof`}>Verified in this browser</h2>
            <p>{view.proof.browserCheckCount} browser checks · {view.proof.regenerationCheckCount} Rust regeneration checks</p>
            <div className="ranked-replay-experiments" aria-label="Signed experiment assignments">
              {view.experiments.map((assignment) => (
                <span key={assignment.key}>
                  <code>{assignment.key}</code>
                  <strong>{assignment.variant}</strong>
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="ranked-replay-proof__fingerprints">
          <Fingerprint label="Commitment" value={view.proof.commitment} />
          <Fingerprint label="Publisher key" value={view.proof.serverKey} />
          <Fingerprint label="Result proof" value={view.proof.result} />
        </div>
        <span className={`ranked-replay-receipt ranked-replay-receipt--${view.proof.acknowledged ? 'recorded' : 'local'}`}>
          <Check size={14} aria-hidden="true" />
          {view.proof.acknowledged ? 'Verification receipt recorded' : 'Local verification complete'}
        </span>
      </section>

      <div className="ranked-replay-summary" aria-label="Round summary">
        <div><Trophy size={18} aria-hidden="true" /><span>Standing</span><strong>{view.result.rank} / {view.result.fieldSize}</strong></div>
        <div><Users size={18} aria-hidden="true" /><span>Survivors</span><strong>{view.result.survivors}</strong></div>
        <div><Activity size={18} aria-hidden="true" /><span>Closest call</span><strong>{view.result.closestApproach.display}</strong></div>
        <div><ShieldCheck size={18} aria-hidden="true" /><span>Signed events</span><strong>{view.proof.eventCount}</strong></div>
      </div>

      <div className="ranked-replay-layout">
        <section className="ranked-replay-panel ranked-replay-panel--standings" aria-labelledby={`${headingId}-standings`}>
          <div className="ranked-replay-section-heading">
            <div>
              <p className="ranked-replay-eyebrow">Final field</p>
              <h2 id={`${headingId}-standings`}>Standings</h2>
            </div>
            <span>{view.standings.length} flags</span>
          </div>
          <div className="ranked-replay-table-wrap" role="region" aria-label="Final ranked standings" tabIndex={0}>
            <table>
              <thead><tr><th scope="col">Rank</th><th scope="col">Flag</th><th scope="col">Outcome</th><th scope="col">Score</th><th scope="col">Closest</th></tr></thead>
              <tbody>
                {view.standings.map((standing) => (
                  <tr className={standing.isPlayer ? 'ranked-replay-standing--player' : undefined} key={standing.contenderId}>
                    <td><strong>{standing.rank}</strong></td>
                    <th scope="row">{standing.name}{standing.isPlayer && <small>You</small>}</th>
                    <td><span className={`ranked-replay-outcome ranked-replay-outcome--${standing.outcome}`}>{outcomeLabel(standing.outcome)}</span></td>
                    <td className="ranked-replay-number">{standing.score.display}</td>
                    <td className="ranked-replay-number">{standing.closestApproach.display}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="ranked-replay-panel ranked-replay-panel--timeline" aria-labelledby={`${headingId}-timeline`}>
          <div className="ranked-replay-section-heading">
            <div>
              <p className="ranked-replay-eyebrow">Signed drama</p>
              <h2 id={`${headingId}-timeline`}>Collision timeline</h2>
            </div>
            <span>{view.timeline.length} moments</span>
          </div>
          {view.timeline.length > 0 ? (
            <ol className="ranked-replay-timeline">
              {view.timeline.map((item) => (
                <li className={`ranked-replay-timeline__item ranked-replay-timeline__item--${item.kind}`} key={item.key}>
                  <span className="ranked-replay-timeline__icon"><TimelineIcon item={item} /></span>
                  <div>
                    <div className="ranked-replay-timeline__topline"><strong>{item.title}</strong><time>{item.relativeTime}</time></div>
                    <p>Step {item.step} · {item.detail}</p>
                    <span className="ranked-replay-timeline__proof"><Key size={12} aria-hidden="true" /> Signed {item.signature.display} · event {item.digest.display}</span>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="ranked-replay-empty">
              <ShieldCheck size={22} aria-hidden="true" />
              <div><strong>A clean run</strong><p>No signed hits, clusters, or Escape events occurred.</p></div>
            </div>
          )}
        </section>
      </div>

      <section className="ranked-replay-panel ranked-replay-bot-audit" aria-labelledby={`${headingId}-bots`}>
        <div className="ranked-replay-section-heading">
          <div>
            <p className="ranked-replay-eyebrow">Public-state policy · no future path</p>
            <h2 id={`${headingId}-bots`}>Bot decision audit</h2>
          </div>
          <span>{view.botAudit.reduce((count, bot) => count + bot.decisions.length, 0)} timed moves</span>
        </div>
        <p className="ranked-replay-bot-audit__intro">
          Every disclosed BOT evaluated the visible field after a 250–1,500 ms reaction delay.
          Expand a rival to inspect its signed candidate utilities and chosen flag.
        </p>
        <div className="ranked-replay-bot-audit__list">
          {view.botAudit.map((bot, botIndex) => (
            <details className="ranked-replay-bot" key={bot.contenderId} open={botIndex === 0}>
              <summary>
                <span className="ranked-replay-bot__identity">
                  <Bot size={17} aria-hidden="true" />
                  <strong>{bot.name}</strong>
                  <b>BOT</b>
                  <small>{bot.persona}</small>
                </span>
                <span>{bot.decisions.length} {bot.decisions.length === 1 ? 'move' : 'moves'}</span>
              </summary>
              <ol className="ranked-replay-bot__decisions">
                {bot.decisions.map((decision) => (
                  <li key={decision.decisionNumber}>
                    <header>
                      <span><Clock3 size={14} aria-hidden="true" /> Move {decision.decisionNumber} · observed {decision.observationTime} → acted {decision.decisionTime}</span>
                      <strong>{decision.selectedSide} · {decision.selectedBarrier.display}</strong>
                    </header>
                    <div className="ranked-replay-bot__metrics">
                      <span><small>Reaction</small><strong>{decision.reactionLatency}</strong></span>
                      <span><small>Candidates</small><strong>{decision.candidateCount}</strong></span>
                      <span><small>Chosen utility</small><strong>{decision.selectedUtility}</strong></span>
                      <span><small>Policy read</small><strong>{decision.reason}</strong></span>
                    </div>
                    <div className="ranked-replay-bot__proofs">
                      <Fingerprint label="Public state" value={decision.publicState} />
                      <Fingerprint label="Bot entropy" value={decision.entropy} />
                    </div>
                    <details className="ranked-replay-candidates">
                      <summary>Inspect all {decision.candidateCount} candidate scores</summary>
                      <div role="region" aria-label={`${bot.name} move ${decision.decisionNumber} candidate utilities`} tabIndex={0}>
                        <table>
                          <thead><tr><th scope="col">Choice</th><th scope="col">Side</th><th scope="col">Survival</th><th scope="col">Barrier</th><th scope="col">Crowd</th><th scope="col">Points</th><th scope="col">Utility</th></tr></thead>
                          <tbody>
                            {decision.candidates.map((candidate) => (
                              <tr className={candidate.selected ? 'ranked-replay-candidate--selected' : undefined} key={candidate.candidateNumber}>
                                <th scope="row">{candidate.selected ? 'Chosen' : `#${candidate.candidateNumber + 1}`}</th>
                                <td>{candidate.side}</td>
                                <td>{candidate.survival}</td>
                                <td title={candidate.barrier.raw}>{candidate.barrier.display}</td>
                                <td title={candidate.crowd.raw}>{candidate.crowd.display}</td>
                                <td title={candidate.terminalScore.raw}>{candidate.terminalScore.display}</td>
                                <td>{candidate.utility}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </div>
      </section>

      <section className="ranked-replay-panel ranked-replay-audit" aria-labelledby={`${headingId}-audit`}>
        <div className="ranked-replay-section-heading">
          <div><p className="ranked-replay-eyebrow">Commit → reveal</p><h2 id={`${headingId}-audit`}>Path audit</h2></div>
          <Fingerprint label="Path digest" value={view.path.digest} />
        </div>
        <div className="ranked-replay-path-strip">
          <div><span>Approach</span><strong>{view.path.approachPoints} frames</strong></div>
          <div><span>Battle</span><strong>{view.path.battlePoints} frames</strong></div>
          <div><span>Open</span><strong>{view.path.initial.display}</strong></div>
          <div><span>Low</span><strong>{view.path.low.display}</strong></div>
          <div><span>High</span><strong>{view.path.high.display}</strong></div>
          <div><span>Close</span><strong>{view.path.final.display}</strong></div>
        </div>
        <details className="ranked-replay-reveal">
          <summary>Inspect revealed material</summary>
          <div>
            <span><small>Path seed</small><code>{view.reveal.pathSeed}</code></span>
            <Fingerprint label="Salt" value={view.reveal.salt} />
            <Fingerprint label="Bot root" value={view.reveal.botSeedRoot} />
            <Fingerprint label="Deck digest" value={view.reveal.deckDigest} />
            <Fingerprint label="Path digest" value={view.reveal.pathDigest} />
            <Fingerprint label="Calibration" value={view.deck.calibration} />
          </div>
        </details>
      </section>

      <footer className="ranked-replay-footer">
        <div>
          <ShieldCheck size={18} aria-hidden="true" />
          <span>Verifier <code>{view.proof.verifier}</code></span>
        </div>
        <div className="ranked-replay-footer__actions">
          {playFresh && (
            <button
              className="ranked-replay-button ranked-replay-button--primary"
              type="button"
              onClick={playFresh}
            >
              <RotateCcw size={16} aria-hidden="true" />Play a fresh round
            </button>
          )}
          {onShare && (
            <button
              className="ranked-replay-button"
              type="button"
              onClick={onShare}
              disabled={shareState === 'working'}
              aria-busy={shareState === 'working'}
            >
              {shareState === 'done' ? <Check size={16} aria-hidden="true" /> : <Share2 size={16} aria-hidden="true" />}
              {shareState === 'working' ? 'Preparing…' : shareState === 'done' ? 'Link ready' : 'Share verified replay'}
            </button>
          )}
        </div>
        <span className="ranked-replay-share-status" role="status" aria-live="polite">
          {shareState === 'done' && 'Safe replay link copied or shared.'}
          {shareState === 'error' && 'Couldn’t share the link. Try again.'}
        </span>
      </footer>
    </article>
  )
}

export function RankedReplayViewer({
  replayId,
  loader,
  shareBaseUrl,
  onShare,
  onPlayFresh,
  onBack,
  onVerified,
  className,
}: RankedReplayViewerProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ViewerState>({ status: 'loading' })
  const [shareState, setShareState] = useState<ShareState>('idle')
  const onVerifiedRef = useRef(onVerified)
  const validId = isRankedReplayId(replayId)
  const shellClass = useMemo(
    () => ['ranked-replay-viewer', className].filter(Boolean).join(' '),
    [className],
  )

  useEffect(() => {
    onVerifiedRef.current = onVerified
  }, [onVerified])

  useEffect(() => {
    if (!validId) return
    const controller = new AbortController()
    let active = true
    setState({ status: 'loading' })
    setShareState('idle')
    void loadVerifiedRankedReplay({
      replayId,
      loader,
      signal: controller.signal,
    }).then((loaded) => {
      if (!active) return
      setState({ status: 'ready', replay: loaded })
      onVerifiedRef.current?.({
        roundId: loaded.replay.roundId,
        proofDigest: loaded.replay.result.proofDigest,
        verifier: loaded.verification.regenerationVerifier,
      })
    }).catch((error: unknown) => {
      if (!active || controller.signal.aborted) return
      setState(replayFailure(error))
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [attempt, loader, replayId, validId])

  async function shareReplay() {
    setShareState('working')
    try {
      const base = shareBaseUrl ?? globalThis.location?.href
      if (!base) throw new Error('No browser origin is available')
      const safeUrl = createRankedReplayShareUrl(replayId, base)
      if (onShare) {
        await onShare(safeUrl)
      } else if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'Strikefall ranked replay', url: safeUrl })
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(safeUrl)
      } else {
        throw new Error('Sharing is not supported')
      }
      setShareState('done')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setShareState('idle')
      } else {
        setShareState('error')
      }
    }
  }

  if (!validId) return <div className={shellClass}><InvalidReplayId onBack={onBack} /></div>
  if (state.status === 'loading') return <div className={shellClass}><ViewerLoading /></div>
  if (state.status === 'error') {
    return <div className={shellClass}><ViewerError state={state} onRetry={() => setAttempt((value) => value + 1)} onBack={onBack} /></div>
  }
  return (
    <div className={shellClass}>
      <RankedReplayReportView
        view={state.replay.view}
        shareState={shareState}
        onShare={() => void shareReplay()}
        onPlayFresh={onPlayFresh}
        onBack={onBack}
      />
    </div>
  )
}
