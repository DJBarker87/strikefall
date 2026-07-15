import {
  DatabaseZap,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ServerCog,
  ShieldCheck,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import {
  fetchAuthoritativeMetrics,
  type AuthoritativeMetricsResponse,
} from './authoritative'

export interface AuthoritativeMetricsPanelProps {
  baseUrl: string | null
}

function perMille(value: number | null): string {
  if (value === null) return '—'
  const percent = value / 10
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
}

function milli(value: number | null): string {
  if (value === null) return '—'
  const decoded = value / 1_000
  return Number.isInteger(decoded) ? String(decoded) : decoded.toFixed(1)
}

function Metric({ label, value, note }: { label: string; value: string | number; note: string }) {
  return (
    <article className="authoritative-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  )
}

function CentralReport({ report }: { report: AuthoritativeMetricsResponse }) {
  const generated = new Date(report.windowEndMs).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  return (
    <div className="authoritative-report">
      <header>
        <div>
          <span className="alpha-dashboard-eyebrow">Server-authored · {report.schemaVersion}</span>
          <h4>Authoritative cohort snapshot</h4>
        </div>
        <span>{generated}</span>
      </header>
      <div className="authoritative-metrics-grid">
        <Metric label="Round starts" value={report.distinctRoundStarts} note={`${report.roundStartSessions} starting sessions`} />
        <Metric label="Second run" value={perMille(report.rematchRatePerMille)} note={`${report.secondRoundSessions}/${report.roundStartSessions} sessions`} />
        <Metric label="Third run" value={perMille(report.thirdRoundRatePerMille)} note={`${report.thirdRoundSessions}/${report.roundStartSessions} sessions`} />
        <Metric label="Flag revisions" value={milli(report.medianFlagRevisionsMilli)} note={`${report.flagRevisionSamples} authoritative rounds`} />
        <Metric label="Median survivors" value={milli(report.medianSurvivorsMilli)} note={`${report.survivorSamples} authoritative rounds`} />
        <Metric label="Placement spread" value={perMille(report.placementSpreadRatePerMille)} note="Both sides · at least six bands" />
        <Metric label="Early mass wipe" value={perMille(report.earlyMassWipeRatePerMille)} note={`${report.earlyMassWipeRounds}/${report.survivorSamples} rounds`} />
        <Metric label="Dead-player response" value={perMille(report.deadPlayerResponseRatePerMille)} note="Spectate/rematch received within 5s" />
        <Metric label="Share intent" value={perMille(report.shareIntentRatePerMille)} note={`${report.shareIntentRounds} opened share`} />
        <Metric label="Clip export" value={perMille(report.clipExportRatePerMille)} note={`${report.clipExportedRounds} exported`} />
        <Metric label="Error sessions" value={report.errorSessionRatePerMillion === null ? '—' : `${(report.errorSessionRatePerMillion / 10_000).toFixed(2)}%`} note={report.g4Note} />
        <Metric label="Completion" value={perMille(report.completionRatePerMille)} note="Resolved authoritative starts" />
      </div>
      {report.experimentCuts.length > 0 && (
        <div className="authoritative-experiments">
          <h4>Persisted treatment cuts</h4>
          <div role="region" aria-label="Authoritative experiment cuts" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Treatment</th>
                  <th scope="col">Variant</th>
                  <th scope="col">Starts</th>
                  <th scope="col">Round 2</th>
                  <th scope="col">Round 3</th>
                  <th scope="col">Early wipe</th>
                  <th scope="col">Share</th>
                </tr>
              </thead>
              <tbody>
                {report.experimentCuts.map((cut) => (
                  <tr key={`${cut.experimentKey}\u0000${cut.variant}`}>
                    <th scope="row">{cut.experimentKey}</th>
                    <td>{cut.variant}</td>
                    <td>{cut.distinctRoundStarts}</td>
                    <td>{perMille(cut.rematchRatePerMille)}</td>
                    <td>{perMille(cut.thirdRoundRatePerMille)}</td>
                    <td>{perMille(cut.earlyMassWipeRatePerMille)}</td>
                    <td>{perMille(cut.shareIntentRatePerMille)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/** Operator-only central aggregate view. The bearer stays in component memory. */
export function AuthoritativeMetricsPanel({ baseUrl }: AuthoritativeMetricsPanelProps) {
  const [token, setToken] = useState('')
  const [windowHours, setWindowHours] = useState(24)
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [report, setReport] = useState<AuthoritativeMetricsResponse | null>(null)

  const load = async (event: FormEvent) => {
    event.preventDefault()
    if (!baseUrl || state === 'loading') return
    setState('loading')
    try {
      const next = await fetchAuthoritativeMetrics({ baseUrl, token, windowHours })
      setReport(next)
      setState('ready')
    } catch {
      setReport(null)
      setState('error')
    }
  }

  return (
    <details className="authoritative-panel">
      <summary>
        <span aria-hidden="true"><ServerCog size={18} /></span>
        <span>
          <strong>Operator aggregate</strong>
          <small>Server-derived rounds, responses, pacing, and experiment cuts</small>
        </span>
      </summary>
      <div className="authoritative-panel__body">
        <div className="authoritative-panel__notice">
          <ShieldCheck size={20} aria-hidden="true" />
          <p>
            Operator-only. The bearer remains in this open panel’s memory; it is never stored,
            added to the URL, or included in an export.
          </p>
        </div>
        {!baseUrl ? (
          <div className="alpha-dashboard-inline-empty">
            <DatabaseZap size={22} aria-hidden="true" />
            <div>
              <strong>No service endpoint configured</strong>
              <p>Set the ranked API base URL for this deployment to query central aggregates.</p>
            </div>
          </div>
        ) : (
          <form className="authoritative-panel__form" onSubmit={(event) => void load(event)}>
            <label>
              <span>Metrics bearer</span>
              <span className="authoritative-panel__input">
                <KeyRound size={16} aria-hidden="true" />
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(event) => setToken(event.currentTarget.value)}
                  required
                />
              </span>
            </label>
            <label>
              <span>Window</span>
              <select value={windowHours} onChange={(event) => setWindowHours(Number(event.currentTarget.value))}>
                <option value={24}>24 hours</option>
                <option value={72}>3 days</option>
                <option value={168}>7 days</option>
              </select>
            </label>
            <button className="alpha-dashboard-button alpha-dashboard-button--primary" type="submit" disabled={state === 'loading'}>
              {state === 'loading'
                ? <LoaderCircle className="authoritative-panel__spinner" size={16} aria-hidden="true" />
                : <RefreshCw size={16} aria-hidden="true" />}
              {report ? 'Refresh central data' : 'Load central data'}
            </button>
          </form>
        )}
        <p className="authoritative-panel__status" role="status" aria-live="polite">
          {state === 'loading' && 'Loading bounded authoritative aggregates…'}
          {state === 'error' && 'Central metrics could not be authenticated or validated.'}
        </p>
        {report && <CentralReport report={report} />}
      </div>
    </details>
  )
}
