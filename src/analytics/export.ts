import type { AlphaMetric } from './metrics'
import type { AlphaDashboardReport } from './report'

export type AlphaExportFormat = 'json' | 'csv'

export interface AlphaExportArtifact {
  format: AlphaExportFormat
  filename: string
  mimeType: string
  contents: string
}

interface ExportMetricRow {
  scope: 'combined' | 'variant'
  experiment: string
  variant: string
  metric: string
  label: string
  value: number | null
  unit: AlphaMetric['unit']
  numerator: number
  denominator: number
  minimumSample: number
  status: AlphaMetric['status']
  evidence: AlphaMetric['evidence']
  target: string
}

function exportMetric(
  metric: AlphaMetric,
  scope: ExportMetricRow['scope'],
  experiment = '',
  variant = '',
): ExportMetricRow {
  return {
    scope,
    experiment,
    variant,
    metric: metric.id,
    label: metric.label,
    value: metric.value,
    unit: metric.unit,
    numerator: metric.numerator,
    denominator: metric.denominator,
    minimumSample: metric.minimumSample,
    status: metric.status,
    evidence: metric.evidence,
    target: metric.target,
  }
}

function aggregateExport(report: AlphaDashboardReport) {
  return {
    protocol: 'strikefall/alpha-metrics-export/v1',
    generatedAt: report.generatedAt,
    dataQuality: { ...report.dataQuality },
    observations: {
      events: report.combined.events,
      sessions: report.combined.sessions,
      completingSessions: report.combined.completingSessions,
      completedRounds: report.combined.completedRounds,
      outcomes: { ...report.combined.outcomes },
    },
    profileTotals: { ...report.profiles },
    operations: { ...report.operations },
    sampleSufficiency: { ...report.sampleSufficiency },
    roadmap: report.roadmap.map((signal) => ({ ...signal })),
    metrics: report.combined.metrics.map((metric) => exportMetric(metric, 'combined')),
    variants: report.variants.map((comparison) => ({
      experiment: comparison.experiment,
      version: comparison.version,
      status: comparison.status,
      minimumSubjectsPerVariant: comparison.minimumSubjectsPerVariant,
      note: comparison.note,
      cohorts: comparison.cohorts.map((cohort) => ({
        variant: cohort.variant,
        sources: cohort.sources,
        sessions: cohort.sessions,
        completingSessions: cohort.completingSessions,
        completedRounds: cohort.completedRounds,
        metrics: cohort.metrics.map((metric) => exportMetric(
          metric,
          'variant',
          comparison.experiment,
          cohort.variant,
        )),
      })),
    })),
  }
}

function csvCell(value: string | number | null) {
  if (value === null) return ''
  const plain = String(value)
  const formulaSafe = /^[=+\-@]/.test(plain) ? `'${plain}` : plain
  return `"${formulaSafe.replaceAll('"', '""')}"`
}

function csvExport(report: AlphaDashboardReport) {
  const headers = [
    'scope',
    'experiment',
    'variant',
    'metric',
    'label',
    'value',
    'unit',
    'numerator',
    'denominator',
    'minimum_sample',
    'status',
    'evidence',
    'target',
  ]
  const rows = [
    ...report.combined.metrics.map((metric) => exportMetric(metric, 'combined')),
    ...report.variants.flatMap((comparison) => comparison.cohorts.flatMap((cohort) =>
      cohort.metrics.map((metric) => exportMetric(
        metric,
        'variant',
        comparison.experiment,
        cohort.variant,
      )))),
  ]
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => [
      row.scope,
      row.experiment,
      row.variant,
      row.metric,
      row.label,
      row.value,
      row.unit,
      row.numerator,
      row.denominator,
      row.minimumSample,
      row.status,
      row.evidence,
      row.target,
    ].map(csvCell).join(',')),
  ].join('\n')
}

function exportStamp(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'undated'
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** Creates an aggregate-only artifact. Raw payloads and private identifiers are never accepted. */
export function createAlphaMetricsExport(
  report: AlphaDashboardReport,
  format: AlphaExportFormat,
): AlphaExportArtifact {
  const filename = `strikefall-alpha-metrics-${exportStamp(report.generatedAt)}.${format}`
  if (format === 'csv') {
    return {
      format,
      filename,
      mimeType: 'text/csv;charset=utf-8',
      contents: csvExport(report),
    }
  }
  return {
    format,
    filename,
    mimeType: 'application/json;charset=utf-8',
    contents: `${JSON.stringify(aggregateExport(report), null, 2)}\n`,
  }
}

export interface AlphaDownloadAdapter {
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
  click(url: string, filename: string): void
}

function browserDownloadAdapter(): AlphaDownloadAdapter | null {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return null
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    click: (url, filename) => {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.rel = 'noopener'
      anchor.click()
    },
  }
}

export function downloadAlphaMetricsExport(
  artifact: AlphaExportArtifact,
  adapter: AlphaDownloadAdapter | null = browserDownloadAdapter(),
) {
  if (!adapter) return false
  const url = adapter.createObjectURL(new Blob([artifact.contents], { type: artifact.mimeType }))
  try {
    adapter.click(url, artifact.filename)
  } finally {
    adapter.revokeObjectURL(url)
  }
  return true
}
