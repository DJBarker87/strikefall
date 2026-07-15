#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { verifySourceProvenance } from '../evidence/provenance.mjs'
import {
  PERFORMANCE_SOURCE_ROOTS,
  validatePerformanceReportShape,
} from './evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
const report = JSON.parse(await readFile(new URL('./report.json', import.meta.url), 'utf8'))

function assert(condition, message) {
  if (!condition) throw new Error(`invalid round-create performance report: ${message}`)
}

const errors = validatePerformanceReportShape(report)
assert(errors.length === 0, errors.join('; '))
assert(
  JSON.stringify(report.provenance?.source?.roots) === JSON.stringify([...PERFORMANCE_SOURCE_ROOTS].sort()),
  'source-root inventory is incomplete',
)
await verifySourceProvenance(root, report.provenance.source).catch((error) => {
  throw new Error(`invalid round-create performance report: ${error.message}`)
})

const git = report.provenance.git
const expectedReleaseBinding = Boolean(
  git?.commit
  && git?.worktree === 'clean'
  && report.environment.containers
    .filter(({ service }) => service !== 'postgres')
    .every(({ buildRevision }) => buildRevision === git.commit),
)
assert(report.provenance.releaseBound === expectedReleaseBinding, 'release-binding state is inconsistent')

process.stdout.write(
  `Round-create report valid: ${report.sampleCount} samples, max ${report.summary.maxMs} ms, source ${report.provenance.source.treeSha256.slice(0, 12)}, release-bound ${report.provenance.releaseBound ? 'yes' : 'no'}\n`,
)
