export const SBF_REPORT_SCHEMA = 2

export const SBF_DEPENDENCY = 'solmath = =0.2.0 (default-features=false, transcendental)'

export const SBF_SOURCE_ROOTS = [
  'Cargo.lock',
  'Cargo.toml',
  'crates/strikefall-core/Cargo.toml',
  'crates/strikefall-core/src',
  'rust-toolchain.toml',
  'tools/evidence/provenance.mjs',
  'tools/sbf-benchmark/check-report.mjs',
  'tools/sbf-benchmark/evidence.mjs',
  'tools/sbf-benchmark/measure.mjs',
  'tools/sbf-benchmark/package-lock.json',
  'tools/sbf-benchmark/package.json',
  'tools/sbf-benchmark/program/Cargo.lock',
  'tools/sbf-benchmark/program/Cargo.toml',
  'tools/sbf-benchmark/program/src',
  'tools/sbf-benchmark/run.sh',
]

export const SBF_ARTIFACT_PATHS = {
  baseline: 'tools/sbf-benchmark/artifacts/baseline.so',
  quote: 'tools/sbf-benchmark/artifacts/quote.so',
}

export function validateSbfReportShape(report) {
  const errors = []
  const require = (condition, message) => {
    if (!condition) errors.push(message)
  }
  require(report?.schemaVersion === SBF_REPORT_SCHEMA, `schemaVersion must be ${SBF_REPORT_SCHEMA}`)
  require(report?.dependency === SBF_DEPENDENCY, 'unexpected dependency')
  require(Number.isInteger(report?.samples) && report.samples >= 200, 'campaign must contain at least 200 samples')
  require(Number.isFinite(report?.targetCu) && report.targetCu === 30_000, 'target must remain 30,000 CU')
  require(Number.isFinite(report?.mathCu?.max), 'math maximum CU is missing')
  require(report?.mathCu?.max < report?.targetCu, 'math maximum exceeds the declared CU target')
  require(report?.mathCu?.min <= report?.mathCu?.p50, 'CU percentile order is invalid')
  require(report?.mathCu?.p50 <= report?.mathCu?.p95, 'CU percentile order is invalid')
  require(report?.mathCu?.p95 <= report?.mathCu?.p99, 'CU percentile order is invalid')
  require(report?.mathCu?.p99 <= report?.mathCu?.max, 'CU percentile order is invalid')
  require(Number.isInteger(report?.footprint?.baselineBytes) && report.footprint.baselineBytes > 0, 'baseline footprint is missing')
  require(
    Number.isInteger(report?.footprint?.quoteBytes)
      && report.footprint.quoteBytes > report.footprint.baselineBytes,
    'quote footprint is invalid',
  )
  require(
    report?.footprint?.linkedDeltaBytes === report?.footprint?.quoteBytes - report?.footprint?.baselineBytes,
    'linked-size delta is inconsistent',
  )
  require(report?.toolchain?.target === 'Agave local validator, genesis-loaded immutable SBF program', 'unexpected validator target')
  require(/^solana-cli 2\.3\.0 \(.+client:Agave\)$/.test(report?.toolchain?.solanaCli ?? ''), 'Solana CLI must be the recorded 2.3.0 Agave toolchain')
  require(/^solana-cargo-build-sbf 2\.3\.0;platform-tools v1\.48;rustc 1\.84\.1$/.test(report?.toolchain?.cargoBuildSbf ?? ''), 'cargo-build-sbf/platform Rust toolchain is unexpected')
  require(report?.toolchain?.simulation === 'unsigned simulateTransaction; CU is the difference between product-call log markers', 'simulation boundary is unexpected')
  require(report?.passed === true, 'report is not marked passed')
  return errors
}
