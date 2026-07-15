import { Crown, LoaderCircle, RefreshCcw, ShieldCheck, Trophy } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fixedToRoundedPoints } from '../engine/fixed'
import type { AlphaApiClient } from './client'
import type { LeaderboardEntry, LeaderboardWindow } from './types'

export interface LeaderboardPanelProps {
  api: AlphaApiClient | null
  deckId: string
  deckName: string
}

function resultLabel(entry: LeaderboardEntry) {
  if (entry.outcome === 'survived') return 'Held'
  if (entry.outcome === 'escaped') return 'Escaped'
  return 'Eliminated'
}

export function LeaderboardPanel({ api, deckId, deckName }: LeaderboardPanelProps) {
  const [window, setWindow] = useState<LeaderboardWindow>('daily')
  const [entries, setEntries] = useState<readonly LeaderboardEntry[]>([])
  const [selfEntry, setSelfEntry] = useState<LeaderboardEntry | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async (append = false) => {
    if (!api) {
      setStatus('idle')
      setEntries([])
      setSelfEntry(null)
      setCursor(null)
      return
    }
    setStatus('loading')
    setMessage(null)
    try {
      const page = await api.leaderboard(deckId.replaceAll('-', '_'), {
        window,
        limit: 20,
        cursor: append ? cursor ?? undefined : undefined,
      })
      setEntries((current) => append ? [...current, ...page.entries] : page.entries)
      setSelfEntry(page.selfEntry)
      setCursor(page.nextCursor)
      setStatus('ready')
    } catch {
      setStatus('error')
      setMessage('Verified standings are unavailable right now.')
    }
  }, [api, cursor, deckId, window])

  useEffect(() => {
    void load(false)
  }, [api, deckId, window]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="alpha-leaderboard" aria-labelledby="alpha-leaderboard-title">
      <header className="alpha-leaderboard__header">
        <div>
          <span className="alpha-leaderboard__eyebrow"><ShieldCheck size={13} aria-hidden="true" /> Replay-verified only</span>
          <h2 id="alpha-leaderboard-title">{deckName} standings</h2>
        </div>
        <div className="alpha-leaderboard__windows" aria-label="Leaderboard window">
          {(['daily', 'weekly'] as const).map((value) => (
            <button
              type="button"
              aria-pressed={window === value}
              onClick={() => {
                setEntries([])
                setCursor(null)
                setWindow(value)
              }}
              key={value}
            >
              {value === 'daily' ? '24h' : '7 days'}
            </button>
          ))}
        </div>
      </header>

      {!api ? (
        <div className="alpha-leaderboard__state">
          <Trophy size={23} aria-hidden="true" />
          <strong>Join ranked alpha to see standings.</strong>
          <span>Practice points stay on this device.</span>
        </div>
      ) : status === 'error' ? (
        <div className="alpha-leaderboard__state" role="alert">
          <strong>{message}</strong>
          <button type="button" onClick={() => void load(false)}>
            <RefreshCcw size={14} aria-hidden="true" /> Try again
          </button>
        </div>
      ) : status === 'loading' && entries.length === 0 ? (
        <div className="alpha-leaderboard__state" aria-busy="true">
          <LoaderCircle className="alpha-leaderboard__spinner" size={23} aria-hidden="true" />
          <strong>Loading verified runs…</strong>
        </div>
      ) : entries.length === 0 ? (
        <div className="alpha-leaderboard__state">
          <Trophy size={23} aria-hidden="true" />
          <strong>No verified runs in this window.</strong>
          <span>Be the first flag on the board.</span>
        </div>
      ) : (
        <>
          <ol className="alpha-leaderboard__list">
            {entries.map((entry) => (
              <li className={entry.isSelf ? 'alpha-leaderboard__row alpha-leaderboard__row--self' : 'alpha-leaderboard__row'} key={entry.roundId}>
                <span className="alpha-leaderboard__rank">
                  {entry.rank <= 3 ? <Crown size={14} aria-hidden="true" /> : null}
                  {entry.rank}
                </span>
                <span className="alpha-leaderboard__identity">
                  <strong>{entry.handle}</strong>
                  <small>{resultLabel(entry)} · #{entry.roundId.slice(0, 7)}</small>
                </span>
                <strong className="alpha-leaderboard__score">{fixedToRoundedPoints(entry.score)}</strong>
              </li>
            ))}
          </ol>
          {cursor && (
            <button
              className="alpha-leaderboard__more"
              type="button"
              disabled={status === 'loading'}
              onClick={() => void load(true)}
            >
              {status === 'loading' ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}

      {selfEntry && !entries.some((entry) => entry.isSelf) && (
        <footer className="alpha-leaderboard__self">
          <span>Your best</span>
          <strong>#{selfEntry.rank} · {fixedToRoundedPoints(selfEntry.score)} points</strong>
        </footer>
      )}
    </section>
  )
}
