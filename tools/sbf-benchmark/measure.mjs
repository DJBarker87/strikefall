#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { collectSourceProvenance, gitProvenance } from '../evidence/provenance.mjs'
import {
  SBF_ARTIFACT_PATHS,
  SBF_DEPENDENCY,
  SBF_REPORT_SCHEMA,
  SBF_SOURCE_ROOTS,
} from './evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
const rpc = process.env.STRIKEFALL_SBF_RPC ?? 'http://127.0.0.1:8899'
const programId = new PublicKey(process.env.STRIKEFALL_SBF_PROGRAM_ID ?? 'BdR4cSgZGQgXNo33SZSYQXy7XgEK61sHT4NQaAkc3PBm')
const feePayer = new PublicKey(process.env.STRIKEFALL_SBF_FEE_PAYER ?? 'Dr5QfdFEChkNpR9bPcAdRXNLuc1gTu955EnhS5bBg8m5')
const samples = Number.parseInt(process.env.STRIKEFALL_SBF_SAMPLES ?? '200', 10)
const targetCu = Number.parseInt(process.env.STRIKEFALL_SBF_TARGET_CU ?? '30000', 10)
const baselineBytes = Number.parseInt(process.env.STRIKEFALL_SBF_BASELINE_BYTES ?? '', 10)
const baselineArtifact = resolve(process.env.STRIKEFALL_SBF_BASELINE_ARTIFACT ?? '')
const quoteArtifact = resolve(process.env.STRIKEFALL_SBF_QUOTE_ARTIFACT ?? '')
const output = resolve(process.env.STRIKEFALL_SBF_OUTPUT ?? `${root}/tools/sbf-benchmark/report.json`)

if (!Number.isSafeInteger(samples) || samples < 20 || samples > 2_000) {
  throw new Error('STRIKEFALL_SBF_SAMPLES must be an integer from 20 to 2000')
}
if (!Number.isSafeInteger(targetCu) || targetCu < 1) throw new Error('invalid CU target')
if (!Number.isSafeInteger(baselineBytes) || baselineBytes < 1) throw new Error('baseline byte count is required')
if (!baselineArtifact || !statSync(baselineArtifact).isFile()) throw new Error('baseline SBF artifact is required')
if (!quoteArtifact || !statSync(quoteArtifact).isFile()) throw new Error('quote SBF artifact is required')

function repositoryPath(absolute, expected) {
  const path = relative(root, absolute).split(sep).join('/')
  if (path !== expected) throw new Error(`SBF artifact must be retained at ${expected}`)
  return path
}

function artifactEvidence(absolute, expectedPath) {
  const bytes = readFileSync(absolute)
  return {
    path: repositoryPath(absolute, expectedPath),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function unsigned128(value) {
  let remaining = BigInt(value)
  if (remaining < 0n || remaining >= (1n << 128n)) throw new RangeError('u128 out of range')
  const bytes = Buffer.alloc(16)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number(remaining & 255n)
    remaining >>= 8n
  }
  return bytes
}

function signed128(value) {
  let normalized = BigInt(value)
  if (normalized < -(1n << 127n) || normalized >= (1n << 127n)) throw new RangeError('i128 out of range')
  if (normalized < 0n) normalized += 1n << 128n
  return unsigned128(normalized)
}

function payload(vector) {
  return Buffer.concat([
    unsigned128(vector.spot),
    unsigned128(vector.barrier),
    unsigned128(vector.variance),
    signed128(vector.drift),
    Buffer.from([vector.upper ? 1 : 0, 0]),
  ])
}

function vectors(count) {
  let state = 0x57a1cef1n
  const next = () => {
    state = (6364136223846793005n * state + 1442695040888963407n) & ((1n << 64n) - 1n)
    return Number(state >> 11n) / 2 ** 53
  }
  return Array.from({ length: count }, (_, index) => {
    const spot = 100_000_000_000_000n
    const upper = index % 2 === 0
    const logDistance = 0.005 + next() * 0.42
    const ratio = Math.exp(upper ? logDistance : -logDistance)
    return {
      spot,
      barrier: BigInt(Math.round(Number(spot) * ratio)),
      variance: BigInt(Math.round((0.0001 + next() * 0.12) * 1e12)),
      drift: BigInt(Math.round((-1.5 + next() * 3) * 1e12)),
      upper,
    }
  })
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

const connection = new Connection(rpc, 'confirmed')
const measurements = []
for (const [index, vector] of vectors(samples).entries()) {
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    new TransactionInstruction({ programId, keys: [], data: payload(vector) }),
  )
  transaction.feePayer = feePayer
  const simulation = await connection.simulateTransaction(transaction)
  const logs = simulation.value.logs ?? []
  const remaining = logs.flatMap((line) => {
    const match = line.match(/consumption:\s*(\d+)\s*units remaining/)
    return match ? [Number.parseInt(match[1], 10)] : []
  })
  if (simulation.value.err !== null || remaining.length < 2 || !logs.some((line) => line.includes('quote_succeeded = true'))) {
    throw new Error(`simulation ${index} failed: ${JSON.stringify({ error: simulation.value.err, logs })}`)
  }
  measurements.push({
    mathCu: remaining[0] - remaining[1],
    transactionCu: simulation.value.unitsConsumed,
  })
}

const math = measurements.map((row) => row.mathCu).sort((left, right) => left - right)
const transaction = measurements.map((row) => row.transactionCu).sort((left, right) => left - right)
const baselineEvidence = artifactEvidence(baselineArtifact, SBF_ARTIFACT_PATHS.baseline)
const quoteEvidence = artifactEvidence(quoteArtifact, SBF_ARTIFACT_PATHS.quote)
if (baselineEvidence.bytes !== baselineBytes) throw new Error('baseline artifact size changed during measurement')
const source = await collectSourceProvenance(root, SBF_SOURCE_ROOTS)
const report = {
  schemaVersion: SBF_REPORT_SCHEMA,
  generatedAt: new Date().toISOString(),
  provenance: {
    source,
    git: gitProvenance(root, SBF_SOURCE_ROOTS),
  },
  toolchain: {
    target: 'Agave local validator, genesis-loaded immutable SBF program',
    rpc,
    solanaCli: process.env.STRIKEFALL_SBF_SOLANA_VERSION ?? 'not reported',
    cargoBuildSbf: process.env.STRIKEFALL_SBF_BUILD_VERSION ?? 'not reported',
    simulation: 'unsigned simulateTransaction; CU is the difference between product-call log markers',
  },
  dependency: SBF_DEPENDENCY,
  samples,
  targetCu,
  mathCu: {
    min: math[0],
    average: Math.round(math.reduce((sum, value) => sum + value, 0) / math.length),
    p50: percentile(math, 0.5),
    p95: percentile(math, 0.95),
    p99: percentile(math, 0.99),
    max: math.at(-1),
  },
  transactionCu: {
    average: Math.round(transaction.reduce((sum, value) => sum + value, 0) / transaction.length),
    p99: percentile(transaction, 0.99),
    max: transaction.at(-1),
  },
  footprint: {
    baselineBytes,
    quoteBytes: quoteEvidence.bytes,
    linkedDeltaBytes: quoteEvidence.bytes - baselineBytes,
  },
  artifacts: {
    baseline: baselineEvidence,
    quote: quoteEvidence,
  },
  passed: math.at(-1) < targetCu,
}

writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.passed) process.exitCode = 1
