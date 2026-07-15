export const PERFORMANCE_REPORT_SCHEMA = 1

export const PERFORMANCE_SOURCE_ROOTS = [
  'Cargo.lock',
  'Cargo.toml',
  'Dockerfile',
  'Dockerfile.web',
  'apps/round-service/Cargo.toml',
  'apps/round-service/src',
  'crates/strikefall-core/Cargo.toml',
  'crates/strikefall-core/src',
  'crates/strikefall-protocol/Cargo.toml',
  'crates/strikefall-protocol/src',
  'deploy/nginx',
  'docker-compose.yml',
  'migrations',
  'rust-toolchain.toml',
  'tools/evidence/provenance.mjs',
  'tools/performance/check-report.mjs',
  'tools/performance/evidence.mjs',
  'tools/performance/round-create.mjs',
]

export const PERFORMANCE_SERVICES = ['postgres', 'round-service', 'web']

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

export function normalizedDurations(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('performance durations must be a non-empty array')
  return values.map((value) => {
    if (!Number.isFinite(value) || value <= 0) throw new Error('performance durations must be positive finite numbers')
    return Number(value.toFixed(3))
  })
}

export function summarizeDurations(values) {
  const raw = normalizedDurations(values)
  const sorted = [...raw].sort((left, right) => left - right)
  return {
    minMs: Number(sorted[0].toFixed(2)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 0.99).toFixed(2)),
    maxMs: Number(sorted.at(-1).toFixed(2)),
  }
}

export function validatePerformanceReportShape(report) {
  const errors = []
  const require = (condition, message) => {
    if (!condition) errors.push(message)
  }
  require(report?.schemaVersion === PERFORMANCE_REPORT_SCHEMA, `schemaVersion must be ${PERFORMANCE_REPORT_SCHEMA}`)
  require(report?.benchmark === 'authoritative-round-create', 'benchmark identity is unexpected')
  require(Number.isInteger(report?.sampleCount) && report.sampleCount >= 1, 'sampleCount is invalid')
  require(Number.isInteger(report?.warmupCount) && report.warmupCount >= 1, 'warmupCount is invalid')
  require(Number.isInteger(report?.sessionCount) && report.sessionCount >= 1, 'sessionCount is invalid')
  require(Number.isInteger(report?.targetMs) && report.targetMs === 300, 'target must remain 300 ms')
  require(report?.validation?.commitment === true, 'commitment validation is missing')
  require(report?.validation?.approach === true, 'approach validation is missing')
  require(report?.validation?.roundIdentity === true, 'round identity validation is missing')
  require(report?.validation?.botRoster === 19, '19-bot roster validation is missing')
  require(Array.isArray(report?.raw?.warmupsMs) && report.raw.warmupsMs.length === report?.warmupCount, 'raw warmup inventory is incomplete')
  require(Array.isArray(report?.raw?.samplesMs) && report.raw.samplesMs.length === report?.sampleCount, 'raw sample inventory is incomplete')
  try {
    const summary = summarizeDurations(report?.raw?.samplesMs)
    for (const [name, value] of Object.entries(summary)) {
      require(report?.summary?.[name] === value, `${name} does not match the raw samples`)
    }
    require(report?.passed === (summary.maxMs < report?.targetMs), 'pass state does not match the raw maximum')
  } catch (error) {
    errors.push(error.message)
  }
  const containers = report?.environment?.containers
  require(Array.isArray(containers) && containers.length === PERFORMANCE_SERVICES.length, 'container inventory is incomplete')
  if (Array.isArray(containers)) {
    const names = containers.map(({ service }) => service).sort()
    require(JSON.stringify(names) === JSON.stringify([...PERFORMANCE_SERVICES].sort()), 'container service inventory is unexpected')
    for (const container of containers) {
      require(/^[a-f0-9]{64}$/.test(container?.containerId ?? ''), `${container?.service ?? 'unknown'} container ID is invalid`)
      require(/^sha256:[a-f0-9]{64}$/.test(container?.imageId ?? ''), `${container?.service ?? 'unknown'} image ID is invalid`)
      require(typeof container?.imageReference === 'string' && container.imageReference.length > 0, `${container?.service ?? 'unknown'} image reference is missing`)
      require(container?.status === 'running', `${container?.service ?? 'unknown'} was not running during the benchmark`)
      require(container?.health === 'healthy', `${container?.service ?? 'unknown'} was not healthy during the benchmark`)
    }
  }
  return errors
}
