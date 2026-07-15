import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { selectDeckForSeed } from '../game/decks'
import { getScoringEngineStatus, initializeScoringEngine } from './runtime'
import type { ScoringEngineStatus } from './types'
import './scoring-engine-gate.css'

const HOME_SEED = 'strikefall-home-preview'

export interface ScoringEngineGateProps {
  children: ReactNode
  /** Test seam; production always uses the committed generated WASM loader. */
  initialize?: () => Promise<ScoringEngineStatus>
}

async function initializeHomeEngine(): Promise<ScoringEngineStatus> {
  const deck = selectDeckForSeed(HOME_SEED)
  return initializeScoringEngine({
    id: deck.id,
    name: deck.name,
    version: deck.version,
    monitoringConvention: deck.monitoringConvention,
    variance: deck.variance,
    openingRunway: deck.openingRunway,
  })
}

export function ScoringEngineGate({
  children,
  initialize = initializeHomeEngine,
}: ScoringEngineGateProps) {
  const [status, setStatus] = useState<ScoringEngineStatus>(getScoringEngineStatus)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (status.status === 'ready') return
    let current = true
    setStatus((snapshot) => ({
      ...snapshot,
      status: 'loading',
      message: attempt === 0
        ? 'Loading the exact SolMath scoring engine…'
        : 'Retrying the exact SolMath scoring engine…',
    }))
    void initialize().then((next) => {
      if (current) setStatus(next)
    }).catch((error: unknown) => {
      if (!current) return
      const message = error instanceof Error ? error.message : 'WASM could not start'
      setStatus((snapshot) => ({
        ...snapshot,
        status: 'blocked',
        message: `SolMath is required to play: ${message}`,
      }))
    })
    return () => {
      current = false
    }
  }, [attempt, initialize])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  if (status.status === 'ready') return children

  const blocked = status.status === 'blocked'
  return (
    <main className="scoring-gate" aria-busy={!blocked}>
      <section className="scoring-gate__panel" aria-live="polite">
        <div className="scoring-gate__mark" aria-hidden="true">ϟ</div>
        <p className="scoring-gate__eyebrow">Strikefall engine check</p>
        <h1>{blocked ? 'Exact scoring is unavailable' : 'Charging the arena'}</h1>
        <p className="scoring-gate__message">{status.message}</p>
        <p className="scoring-gate__detail">
          Strikefall never substitutes browser floating-point math for scoring or
          probability. An installed copy can use its cached WASM while offline.
        </p>
        {blocked ? (
          <button type="button" onClick={retry}>Retry SolMath</button>
        ) : (
          <span className="scoring-gate__loader" aria-label="Loading SolMath" />
        )}
      </section>
    </main>
  )
}
