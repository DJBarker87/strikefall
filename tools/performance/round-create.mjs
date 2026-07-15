#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { collectSourceProvenance, gitProvenance } from '../evidence/provenance.mjs'
import {
  normalizedDurations,
  PERFORMANCE_REPORT_SCHEMA,
  PERFORMANCE_SERVICES,
  PERFORMANCE_SOURCE_ROOTS,
  summarizeDurations,
} from './evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
const baseUrl = (process.env.STRIKEFALL_PERF_BASE_URL ?? 'http://127.0.0.1:4173/api').replace(/\/$/, '')
const output = resolve(process.env.STRIKEFALL_PERF_OUTPUT ?? `${root}/tools/performance/report.json`)
const samples = positiveInteger(process.env.STRIKEFALL_PERF_SAMPLES, 25, 'STRIKEFALL_PERF_SAMPLES')
const warmups = positiveInteger(process.env.STRIKEFALL_PERF_WARMUPS, 3, 'STRIKEFALL_PERF_WARMUPS')
const targetMs = positiveInteger(process.env.STRIKEFALL_PERF_ROUND_TARGET_MS, 300, 'STRIKEFALL_PERF_ROUND_TARGET_MS')

function positiveInteger(raw, fallback, name) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function command(commandName, args) {
  return execFileSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function containerEvidence(service) {
  const ids = command('docker', ['compose', 'ps', '--all', '--quiet', service])
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (ids.length !== 1) {
    throw new Error(`performance evidence requires exactly one Compose ${service} container, found ${ids.length}`)
  }
  const inspected = JSON.parse(command('docker', ['inspect', ids[0]]))[0]
  if (!inspected) throw new Error(`could not inspect Compose ${service} container`)
  const labels = inspected.Config?.Labels ?? {}
  return {
    service,
    containerId: inspected.Id,
    imageId: inspected.Image,
    imageReference: inspected.Config?.Image,
    status: inspected.State?.Status,
    health: inspected.State?.Health?.Status ?? null,
    startedAt: inspected.State?.StartedAt,
    buildRevision: labels['org.opencontainers.image.revision'] ?? null,
  }
}

function environmentEvidence() {
  return {
    runner: {
      node: process.version,
      platform: platform(),
      architecture: arch(),
      kernelRelease: release(),
    },
    docker: {
      engineVersion: command('docker', ['version', '--format', '{{.Server.Version}}']),
      composeVersion: command('docker', ['compose', 'version', '--short']),
    },
    containers: PERFORMANCE_SERVICES.map(containerEvidence),
  }
}

async function json(response, label) {
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}: ${body?.message ?? text}`)
  }
  return body
}

async function issueSession() {
  const response = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteCode: null, handle: null, telemetryConsent: false }),
  })
  const session = await json(response, 'session creation')
  if (typeof session?.token !== 'string' || session.token.length < 16) {
    throw new Error('session creation did not return a bearer token')
  }
  return session.token
}

// The closed alpha deliberately permits only eight round creates per session.
// Use at most seven so the benchmark exercises production policy rather than
// weakening or bypassing it. The default 28 calls stay below the 32/IP window.
const totalCalls = warmups + samples
if (totalCalls > 32) {
  throw new Error('warmups + samples must not exceed the production 32/IP round-create window')
}

const sourceBefore = await collectSourceProvenance(root, PERFORMANCE_SOURCE_ROOTS)
const environmentBefore = environmentEvidence()
const tokens = []
for (let index = 0; index < Math.ceil(totalCalls / 7); index += 1) tokens.push(await issueSession())
let callNumber = 0

async function createRound() {
  const token = tokens[Math.floor(callNumber / 7)]
  callNumber += 1
  const startedAt = performance.now()
  const response = await fetch(`${baseUrl}/v1/solo-rounds`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  const body = await json(response, 'round creation')
  const elapsedMs = performance.now() - startedAt
  if (
    typeof body?.roundId !== 'string'
    || typeof body?.commitment !== 'string'
    || !Array.isArray(body?.approach)
    || !Array.isArray(body?.bots)
    || body.bots.length !== 19
  ) {
    throw new Error('round creation returned an incomplete protocol response')
  }
  return elapsedMs
}

const warmupDurations = []
for (let index = 0; index < warmups; index += 1) warmupDurations.push(await createRound())

const sampleDurations = []
for (let index = 0; index < samples; index += 1) sampleDurations.push(await createRound())

const sourceAfter = await collectSourceProvenance(root, PERFORMANCE_SOURCE_ROOTS)
if (sourceAfter.treeSha256 !== sourceBefore.treeSha256) {
  throw new Error('performance source inputs changed while the benchmark was running')
}
const environmentAfter = environmentEvidence()
const beforeContainers = environmentBefore.containers.map(({ service, containerId, imageId, startedAt }) => ({ service, containerId, imageId, startedAt }))
const afterContainers = environmentAfter.containers.map(({ service, containerId, imageId, startedAt }) => ({ service, containerId, imageId, startedAt }))
if (JSON.stringify(afterContainers) !== JSON.stringify(beforeContainers)) {
  throw new Error('Compose containers changed while the benchmark was running')
}

const rawSamples = normalizedDurations(sampleDurations)
const summary = summarizeDurations(rawSamples)
const git = gitProvenance(root, PERFORMANCE_SOURCE_ROOTS)
const releaseBound = Boolean(
  git.commit
  && git.worktree === 'clean'
  && environmentAfter.containers
    .filter(({ service }) => service !== 'postgres')
    .every(({ buildRevision }) => buildRevision === git.commit),
)
const report = {
  schemaVersion: PERFORMANCE_REPORT_SCHEMA,
  benchmark: 'authoritative-round-create',
  generatedAt: new Date().toISOString(),
  endpoint: `${baseUrl}/v1/solo-rounds`,
  sampleCount: samples,
  warmupCount: warmups,
  sessionCount: tokens.length,
  targetMs,
  validation: {
    commitment: true,
    approach: true,
    roundIdentity: true,
    botRoster: 19,
  },
  provenance: {
    source: sourceAfter,
    git,
    releaseBound,
  },
  environment: environmentAfter,
  raw: {
    warmupsMs: normalizedDurations(warmupDurations),
    samplesMs: rawSamples,
  },
  summary,
  passed: summary.maxMs < targetMs,
}

await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.passed) process.exitCode = 1
