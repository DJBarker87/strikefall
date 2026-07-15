import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  Download,
  FlaskConical,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import {
  useMemo,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  createAlphaMetricsExport,
  downloadAlphaMetricsExport,
  type AlphaExportArtifact,
  type AlphaExportFormat,
} from './export'
import type { AlphaMetric, MetricStatus } from './metrics'
import {
  alphaMetric,
  calculateAlphaDashboardReport,
  type AlphaAnalyticsSource,
  type AlphaDashboardReport,
  type AlphaVariantComparison,
} from './report'

export interface AlphaMetricsDashboardProps {
  sources: readonly AlphaAnalyticsSource[]
  generatedAt?: Date
  state?: 'ready' | 'loading' | 'error'
  errorMessage?: string
  onRetry?: () => void
  onReturnToGame?: () => void
  onExport?: (artifact: AlphaExportArtifact) => void | Promise<void>
  heading?: string
}

const STATUS_COPY: Record<MetricStatus, string> = {
  pass: 'On target',
  fail: 'Outside target',
  insufficient: 'Sample pending',
  descriptive: 'Observe',
}

function formatValue(metric: AlphaMetric | null) {
  if (!metric || metric.value === null) return '—'
  if (metric.unit === 'percent') {
    const percent = metric.value * 100
    return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
  }
  return Number.isInteger(metric.value) ? String(metric.value) : metric.value.toFixed(1)
}

function statusDetail(metric: AlphaMetric) {
  if (metric.status === 'insufficient') {
    return `${metric.denominator}/${metric.minimumSample} minimum sample`
  }
  return `Target ${metric.target}`
}

function MetricCard({ metric }: { metric: AlphaMetric }) {
  const fill = metric.unit === 'percent' && metric.value !== null
    ? Math.max(0, Math.min(100, metric.value * 100))
    : null
  const style = fill === null
    ? undefined
    : { '--alpha-dashboard-progress': `${fill}%` } as CSSProperties

  return (
    <article className={`alpha-dashboard-metric alpha-dashboard-metric--${metric.status}`}>
      <div className="alpha-dashboard-metric__topline">
        <span className="alpha-dashboard-gate">{metric.roadmap}</span>
        <span className={`alpha-dashboard-evidence alpha-dashboard-evidence--${metric.evidence}`}>
          {metric.evidence}
        </span>
      </div>
      <h4>{metric.label}</h4>
      <div className="alpha-dashboard-metric__reading">
        <strong>{formatValue(metric)}</strong>
        <span>{STATUS_COPY[metric.status]}</span>
      </div>
      {fill !== null && (
        <div
          className="alpha-dashboard-progress"
          style={style}
          role="img"
          aria-label={`${metric.label}: ${formatValue(metric)}`}
        >
          <span />
        </div>
      )}
      <div className="alpha-dashboard-metric__sample">
        <span>{statusDetail(metric)}</span>
        <span>{metric.numerator}/{metric.denominator}</span>
      </div>
      <p>{metric.evidenceNote}</p>
    </article>
  )
}

function SummaryCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string
  value: string | number
  detail: string
  icon: ReactNode
}) {
  return (
    <article className="alpha-dashboard-summary-card">
      <div className="alpha-dashboard-summary-card__icon" aria-hidden="true">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  )
}

function comparisonStatus(comparison: AlphaVariantComparison) {
  if (comparison.status === 'single-variant') return 'One variant local'
  if (comparison.status === 'insufficient') return 'Sample pending'
  return 'Descriptive only'
}

function VariantTable({ comparison }: { comparison: AlphaVariantComparison }) {
  return (
    <details className="alpha-dashboard-experiment">
      <summary>
        <span>
          <strong>{comparison.experimentKey}</strong>
          <small>{comparison.cohorts.length} variant{comparison.cohorts.length === 1 ? '' : 's'} · authoritative key</small>
        </span>
        <span className={`alpha-dashboard-experiment__status alpha-dashboard-experiment__status--${comparison.status}`}>
          {comparisonStatus(comparison)}
        </span>
      </summary>
      <div className="alpha-dashboard-experiment__body">
        <p>{comparison.note}</p>
        <div
          className="alpha-dashboard-table-scroll"
          role="region"
          aria-label={`${comparison.experimentKey} variant comparison`}
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Variant</th>
                <th scope="col">Sources</th>
                <th scope="col">Rounds</th>
                <th scope="col">Round 2</th>
                <th scope="col">Round 3</th>
                <th scope="col">Escape</th>
                <th scope="col">Share</th>
                <th scope="col">Replay</th>
                <th scope="col" title="Distinct sessions with a bounded client error">Errors</th>
                <th scope="col" title="Placement outcomes spanning at least four ranks">Placement</th>
                <th scope="col" title="Rounds ending with no eliminations">No elim.</th>
                <th scope="col" title="Rounds with an early mass wipe">Early wipe</th>
              </tr>
            </thead>
            <tbody>
              {comparison.cohorts.map((cohort) => (
                <tr key={cohort.variant}>
                  <th scope="row">{cohort.variant}</th>
                  <td>{cohort.sources}</td>
                  <td>{cohort.completedRounds}</td>
                  <td>{formatValue(cohort.metrics.find((metric) => metric.id === 'second-round') ?? null)}</td>
                  <td>{formatValue(cohort.metrics.find((metric) => metric.id === 'third-round') ?? null)}</td>
                  <td>{formatValue(cohort.metrics.find((metric) => metric.id === 'escape-uptake') ?? null)}</td>
                  <td>{formatValue(cohort.metrics.find((metric) => metric.id === 'share-intent') ?? null)}</td>
                  <td>{formatValue(cohort.metrics.find((metric) => metric.id === 'replay-verification') ?? null)}</td>
                  <td>{formatValue(cohort.metrics.find((metric) => metric.id === 'client-error-session-rate') ?? null)}</td>
                  <td>{formatValue(cohort.metrics.find((metric) => metric.id === 'placement-spread') ?? null)}</td>
                  <td>{formatValue(cohort.metrics.find((metric) => metric.id === 'no-elimination-rate') ?? null)}</td>
                  <td>{formatValue(cohort.metrics.find((metric) => metric.id === 'early-mass-wipe-rate') ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  )
}

function DashboardLoading({ heading }: { heading: string }) {
  return (
    <section className="alpha-dashboard-shell alpha-dashboard-shell--loading" aria-busy="true" aria-label={`${heading} loading`}>
      <div className="alpha-dashboard-skeleton alpha-dashboard-skeleton--heading" />
      <div className="alpha-dashboard-skeleton-grid">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="alpha-dashboard-skeleton alpha-dashboard-skeleton--card" key={index} />
        ))}
      </div>
      <p className="sr-only">Preparing bounded local alpha metrics.</p>
    </section>
  )
}

function DashboardError({
  message,
  onRetry,
}: {
  message?: string
  onRetry?: () => void
}) {
  return (
    <section className="alpha-dashboard-shell alpha-dashboard-state" role="alert">
      <AlertTriangle size={30} aria-hidden="true" />
      <div>
        <p className="alpha-dashboard-eyebrow">Metrics unavailable</p>
        <h2>Couldn’t build the alpha report</h2>
        <p>{message || 'The local snapshot could not be read. Gameplay data has not been changed.'}</p>
      </div>
      {onRetry && (
        <button className="alpha-dashboard-button" type="button" onClick={onRetry}>
          <RotateCcw size={16} aria-hidden="true" />
          Try again
        </button>
      )}
    </section>
  )
}

function DashboardEmpty({
  report,
  onReturnToGame,
}: {
  report: AlphaDashboardReport
  onReturnToGame?: () => void
}) {
  return (
    <section className="alpha-dashboard-shell alpha-dashboard-state">
      <BarChart3 size={32} aria-hidden="true" />
      <div>
        <p className="alpha-dashboard-eyebrow">No observations yet</p>
        <h2>Complete a round to light up the board</h2>
        <p>
          The bounded event queue is empty. {report.profiles.rounds > 0
            ? `${report.profiles.rounds} persisted profile rounds remain visible, but they are not used to invent session behavior.`
            : 'Second-round, retention, and replay signals appear after local play.'}
        </p>
      </div>
      {onReturnToGame && (
        <button className="alpha-dashboard-button" type="button" onClick={onReturnToGame}>
          <Activity size={16} aria-hidden="true" />
          Return to game
        </button>
      )}
    </section>
  )
}

export function AlphaMetricsDashboard({
  sources,
  generatedAt,
  state = 'ready',
  errorMessage,
  onRetry,
  onReturnToGame,
  onExport,
  heading = 'Alpha signal room',
}: AlphaMetricsDashboardProps) {
  const [reportTime] = useState(() => generatedAt ?? new Date())
  const headingId = useId()
  const report = useMemo(
    () => calculateAlphaDashboardReport(sources, generatedAt ?? reportTime),
    [generatedAt, reportTime, sources],
  )
  const [exportState, setExportState] = useState<'idle' | 'working' | 'done' | 'error'>('idle')
  const clientErrorMetric = alphaMetric(report.combined, 'client-error-session-rate')

  if (state === 'loading') return <DashboardLoading heading={heading} />
  if (state === 'error') return <DashboardError message={errorMessage} onRetry={onRetry} />
  if (report.dataQuality.eventsIncluded === 0) {
    return <DashboardEmpty report={report} onReturnToGame={onReturnToGame} />
  }

  const exportReport = async (format: AlphaExportFormat) => {
    if (exportState === 'working') return
    setExportState('working')
    try {
      const artifact = createAlphaMetricsExport(report, format)
      if (onExport) await onExport(artifact)
      else if (!downloadAlphaMetricsExport(artifact)) throw new Error('Downloads are unavailable')
      setExportState('done')
    } catch {
      setExportState('error')
    }
  }

  const dateLabel = new Date(report.generatedAt).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  return (
    <section className="alpha-dashboard-shell" aria-labelledby={`${headingId}-title`}>
      <header className="alpha-dashboard-header">
        <div className="alpha-dashboard-header__copy">
          <p className="alpha-dashboard-eyebrow">Closed alpha · aggregate local evidence</p>
          <h2 id={`${headingId}-title`}>{heading}</h2>
          <p>
            Product signals, not verdicts. Human fun gates remain open until observed playtests supply the evidence.
          </p>
        </div>
        <div className="alpha-dashboard-header__actions">
          <button
            className="alpha-dashboard-button alpha-dashboard-button--primary"
            type="button"
            disabled={exportState === 'working'}
            aria-busy={exportState === 'working'}
            onClick={() => void exportReport('json')}
          >
            <Download size={16} aria-hidden="true" />
            Export JSON
          </button>
          <button
            className="alpha-dashboard-button"
            type="button"
            disabled={exportState === 'working'}
            aria-busy={exportState === 'working'}
            onClick={() => void exportReport('csv')}
          >
            <Download size={16} aria-hidden="true" />
            Export CSV
          </button>
          <span className="alpha-dashboard-export-status" role="status" aria-live="polite">
            {exportState === 'working' && 'Preparing aggregate export…'}
            {exportState === 'done' && <><Check size={14} aria-hidden="true" /> Export ready</>}
            {exportState === 'error' && 'Export unavailable. Try again.'}
          </span>
        </div>
      </header>

      <div className="alpha-dashboard-meta">
        <span>Generated {dateLabel}</span>
        <span>Last {report.dataQuality.eventLimitPerSource} events per source</span>
        <span>No raw paths, seeds, or private identifiers</span>
      </div>

      <div className="alpha-dashboard-summary" aria-label="Alpha summary">
        <SummaryCard
          label="Observed rounds"
          value={report.combined.completedRounds}
          detail={`${report.combined.completingSessions} completing sessions`}
          icon={<Activity size={20} />}
        />
        <SummaryCard
          label="Sample-ready"
          value={`${report.sampleSufficiency.sufficientMetrics}/${report.sampleSufficiency.assessedMetrics}`}
          detail={`${report.sampleSufficiency.insufficientMetrics} signals still pending`}
          icon={<BarChart3 size={20} />}
        />
        <SummaryCard
          label="Replay checks"
          value={alphaMetric(report.combined, 'replay-verification')?.denominator ?? 0}
          detail={report.operations.replayFailures === null
            ? 'No verification sample yet'
            : `${report.operations.replayFailures} observed failures`}
          icon={<ShieldCheck size={20} />}
        />
        <SummaryCard
          label="Persisted history"
          value={report.profiles.rounds}
          detail={`${report.profiles.profiles} anonymous local profiles`}
          icon={<FlaskConical size={20} />}
        />
      </div>

      <section className="alpha-dashboard-section" aria-labelledby="alpha-dashboard-roadmap">
        <div className="alpha-dashboard-section__heading">
          <div>
            <p className="alpha-dashboard-eyebrow">Roadmap lens</p>
            <h3 id="alpha-dashboard-roadmap">G1–G4 evidence</h3>
          </div>
          <p>Passing telemetry never closes a human or systems gate by itself.</p>
        </div>
        <div className="alpha-dashboard-roadmap">
          {report.roadmap.map((signal) => (
            <article className={`alpha-dashboard-roadmap-card alpha-dashboard-roadmap-card--${signal.status}`} key={signal.gate}>
              <div>
                <span>{signal.gate}</span>
                <strong>{signal.label}</strong>
              </div>
              <small>{signal.status.replace('-', ' ')}</small>
              <p>{signal.note}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="alpha-dashboard-section" aria-labelledby="alpha-dashboard-signals">
        <div className="alpha-dashboard-section__heading">
          <div>
            <p className="alpha-dashboard-eyebrow">Behavior & integrity</p>
            <h3 id="alpha-dashboard-signals">Measured signals</h3>
          </div>
          <p><strong>Observed</strong> is a direct event count. <strong>Inferred</strong> is an explicitly labelled behavioral proxy.</p>
        </div>
        <div className="alpha-dashboard-metrics">
          {report.combined.metrics.map((metric) => <MetricCard metric={metric} key={metric.id} />)}
        </div>
      </section>

      <section className="alpha-dashboard-section" aria-labelledby="alpha-dashboard-operations">
        <div className="alpha-dashboard-section__heading">
          <div>
            <p className="alpha-dashboard-eyebrow">Operational truth</p>
            <h3 id="alpha-dashboard-operations">Errors & degradation</h3>
          </div>
          <p>Rates use observed telemetry sessions; unavailable denominators stay visibly unavailable.</p>
        </div>
        <div className="alpha-dashboard-operations">
          <article>
            <span>Ranked fallbacks</span>
            <strong>{report.operations.degradedToPractice}</strong>
            <small>Observed degraded-to-practice events</small>
          </article>
          <article>
            <span>Player outcomes</span>
            <strong>{report.combined.completedRounds}</strong>
            <small>
              {report.combined.outcomes.survived} held · {report.combined.outcomes.eliminated} eliminated · {report.combined.outcomes.escaped} escaped
            </small>
          </article>
          <article className={(report.operations.replayFailures ?? 0) > 0 ? 'alpha-dashboard-operation--alert' : ''}>
            <span>Replay failures</span>
            <strong>{report.operations.replayFailures ?? '—'}</strong>
            <small>{report.operations.replayFailureNote}</small>
          </article>
          <article className={clientErrorMetric?.status === 'insufficient'
            ? 'alpha-dashboard-operation--unknown'
            : clientErrorMetric?.status === 'fail'
              ? 'alpha-dashboard-operation--alert'
              : ''}>
            <span>Client errors</span>
            <strong>{report.operations.clientErrors}</strong>
            <small>{report.operations.clientErrorNote}</small>
          </article>
        </div>
      </section>

      <section className="alpha-dashboard-section" aria-labelledby="alpha-dashboard-experiments">
        <div className="alpha-dashboard-section__heading">
          <div>
            <p className="alpha-dashboard-eyebrow">Experiment assignments</p>
            <h3 id="alpha-dashboard-experiments">Variant cuts</h3>
          </div>
          <p>Every cut is descriptive. Small or one-sided cohorts stay visibly sample-limited.</p>
        </div>
        {report.variants.length > 0 ? (
          <div className="alpha-dashboard-experiments">
            {report.variants.map((comparison) => (
              <VariantTable comparison={comparison} key={comparison.experimentKey} />
            ))}
          </div>
        ) : (
          <div className="alpha-dashboard-inline-empty">
            <FlaskConical size={22} aria-hidden="true" />
            <div>
              <strong>No experiment assignments in this snapshot</strong>
              <p>Persist assignments with each anonymous source before comparing variants.</p>
            </div>
          </div>
        )}
      </section>

      <footer className="alpha-dashboard-footer">
        <span>{report.dataQuality.eventsIncluded} aggregate events included</span>
        <span>{report.dataQuality.eventsTrimmed} over-limit events trimmed</span>
        <span>{report.dataQuality.eventsDiscarded} malformed or duplicate events discarded</span>
      </footer>
    </section>
  )
}
