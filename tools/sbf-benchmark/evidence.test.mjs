import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SBF_DEPENDENCY,
  SBF_REPORT_SCHEMA,
  SBF_SOURCE_ROOTS,
  validateSbfReportShape,
} from './evidence.mjs'

function validReport() {
  return {
    schemaVersion: SBF_REPORT_SCHEMA,
    dependency: SBF_DEPENDENCY,
    samples: 200,
    targetCu: 30_000,
    mathCu: { min: 1, p50: 2, p95: 3, p99: 4, max: 5 },
    footprint: { baselineBytes: 10, quoteBytes: 20, linkedDeltaBytes: 10 },
    toolchain: {
      target: 'Agave local validator, genesis-loaded immutable SBF program',
      solanaCli: 'solana-cli 2.3.0 (src:a2e21dda; feat:3640012085, client:Agave)',
      cargoBuildSbf: 'solana-cargo-build-sbf 2.3.0;platform-tools v1.48;rustc 1.84.1',
      simulation: 'unsigned simulateTransaction; CU is the difference between product-call log markers',
    },
    passed: true,
  }
}

test('SBF report shape accepts only ordered, passing, pinned-toolchain evidence', () => {
  assert.deepEqual(validateSbfReportShape(validReport()), [])
  const report = validReport()
  report.mathCu.p99 = 6
  report.toolchain.cargoBuildSbf = 'not reported'
  assert.match(validateSbfReportShape(report).join('; '), /percentile order/)
  assert.match(validateSbfReportShape(report).join('; '), /toolchain is unexpected/)
})

test('SBF provenance binds the product core, lockfiles, and measurement tooling', () => {
  for (const required of [
    'Cargo.lock',
    'crates/strikefall-core/src',
    'tools/evidence/provenance.mjs',
    'tools/sbf-benchmark/measure.mjs',
    'tools/sbf-benchmark/program/Cargo.lock',
    'tools/sbf-benchmark/run.sh',
  ]) {
    assert.ok(SBF_SOURCE_ROOTS.includes(required), `missing ${required}`)
  }
})
