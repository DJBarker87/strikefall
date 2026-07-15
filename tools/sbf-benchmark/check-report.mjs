#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { verifySourceProvenance } from '../evidence/provenance.mjs'
import {
  SBF_ARTIFACT_PATHS,
  SBF_SOURCE_ROOTS,
  validateSbfReportShape,
} from './evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
const reportUrl = new URL('./report.json', import.meta.url)
const report = JSON.parse(await readFile(reportUrl, 'utf8'))

function assert(condition, message) {
  if (!condition) throw new Error(`invalid SBF benchmark report: ${message}`)
}

const shapeErrors = validateSbfReportShape(report)
assert(shapeErrors.length === 0, shapeErrors.join('; '))
assert(
  JSON.stringify(report.provenance?.source?.roots) === JSON.stringify([...SBF_SOURCE_ROOTS].sort()),
  'source-root inventory is incomplete',
)
await verifySourceProvenance(root, report.provenance.source).catch((error) => {
  throw new Error(`invalid SBF benchmark report: ${error.message}`)
})

async function verifyArtifact(label, expectedPath, expectedBytes) {
  const retained = report.artifacts?.[label]
  assert(retained?.path === expectedPath, `${label} artifact path is unexpected`)
  assert(/^[a-f0-9]{64}$/.test(retained?.sha256 ?? ''), `${label} artifact SHA-256 is invalid`)
  const absolute = resolve(root, retained.path)
  const normalized = relative(root, absolute).split(sep).join('/')
  assert(normalized === retained.path, `${label} artifact escapes the repository`)
  const metadata = await lstat(absolute)
  assert(!metadata.isSymbolicLink(), `${label} artifact must not be a symbolic link`)
  assert(metadata.isFile() && metadata.size === expectedBytes, `${label} artifact byte count does not match`)
  const digest = createHash('sha256').update(await readFile(absolute)).digest('hex')
  assert(digest === retained.sha256, `${label} artifact bytes do not match the retained SHA-256`)
}

await verifyArtifact('baseline', SBF_ARTIFACT_PATHS.baseline, report.footprint.baselineBytes)
await verifyArtifact('quote', SBF_ARTIFACT_PATHS.quote, report.footprint.quoteBytes)

const workspaceManifest = await readFile(resolve(root, 'Cargo.toml'), 'utf8')
assert(
  /solmath\s*=\s*\{\s*version\s*=\s*"=0\.2\.0"\s*,\s*default-features\s*=\s*false\s*,\s*features\s*=\s*\["transcendental"\]\s*\}/.test(workspaceManifest),
  'workspace SolMath dependency is not the exact approved feature set',
)
const harnessLock = await readFile(resolve(root, 'tools/sbf-benchmark/program/Cargo.lock'), 'utf8')
assert(
  /name = "solmath"\nversion = "0\.2\.0"\nsource = "registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"\nchecksum = "20b82ebca3822ead8793b09d25754ba2e1ac79d1dba9d8a949703d89b9270538"/.test(harnessLock),
  'isolated SBF lockfile does not contain the approved SolMath 0.2.0 package',
)

const releaseBinding = report.provenance.git?.commit && report.provenance.git?.worktree === 'clean'
process.stdout.write(
  `SBF report valid: ${report.samples} vectors, max ${report.mathCu.max} CU, ${report.footprint.quoteBytes} linked bytes, source ${report.provenance.source.treeSha256.slice(0, 12)}, release-bound ${releaseBinding ? 'yes' : 'no'}\n`,
)
