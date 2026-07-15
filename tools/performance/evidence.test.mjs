import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PERFORMANCE_REPORT_SCHEMA,
  PERFORMANCE_SERVICES,
  PERFORMANCE_SOURCE_ROOTS,
  summarizeDurations,
  validatePerformanceReportShape,
} from './evidence.mjs'

function containers() {
  return PERFORMANCE_SERVICES.map((service, index) => ({
    service,
    containerId: String(index + 1).padStart(64, 'a'),
    imageId: `sha256:${String(index + 1).padStart(64, 'b')}`,
    imageReference: `${service}:test`,
    status: 'running',
    health: 'healthy',
  }))
}

function validReport() {
  const samplesMs = [5.001, 9.999, 7.5, 8.25]
  return {
    schemaVersion: PERFORMANCE_REPORT_SCHEMA,
    benchmark: 'authoritative-round-create',
    sampleCount: samplesMs.length,
    warmupCount: 1,
    sessionCount: 1,
    targetMs: 300,
    validation: { commitment: true, approach: true, roundIdentity: true, botRoster: 19 },
    raw: { warmupsMs: [4.2], samplesMs },
    summary: summarizeDurations(samplesMs),
    environment: { containers: containers() },
    passed: true,
  }
}

test('round-create summary is recomputed from retained raw samples', () => {
  const report = validReport()
  assert.deepEqual(validatePerformanceReportShape(report), [])
  report.summary.maxMs = 1
  assert.match(validatePerformanceReportShape(report).join('; '), /maxMs does not match/)
})

test('round-create evidence requires one healthy container identity per service', () => {
  const report = validReport()
  report.environment.containers[1].health = 'starting'
  report.environment.containers.pop()
  const errors = validatePerformanceReportShape(report).join('; ')
  assert.match(errors, /container inventory is incomplete/)
  assert.match(errors, /service inventory is unexpected/)
})

test('round-create provenance binds server, container, and benchmark tooling', () => {
  for (const required of [
    'Cargo.lock',
    'Dockerfile',
    'apps/round-service/src',
    'crates/strikefall-core/src',
    'crates/strikefall-protocol/src',
    'docker-compose.yml',
    'tools/evidence/provenance.mjs',
    'tools/performance/round-create.mjs',
  ]) {
    assert.ok(PERFORMANCE_SOURCE_ROOTS.includes(required), `missing ${required}`)
  }
})
