#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

function fail(message) {
  throw new Error(`invalid production Compose topology: ${message}`)
}

const rendered = execFileSync('docker', ['compose', 'config', '--format', 'json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
const compose = JSON.parse(rendered)
const service = compose.services?.['round-service']
if (!service) fail('round-service is missing')
if (service.deploy?.replicas !== 1) fail('round-service deploy.replicas must be exactly 1')

const environment = service.environment ?? {}
const topology = Array.isArray(environment)
  ? environment.find((entry) => entry.startsWith('STRIKEFALL_STREAM_TOPOLOGY='))?.split('=').slice(1).join('=')
  : environment.STRIKEFALL_STREAM_TOPOLOGY
if (topology !== 'single-replica') {
  fail('round-service must set STRIKEFALL_STREAM_TOPOLOGY=single-replica')
}
if (service.ports?.length) fail('round-service must not publish a host port')

process.stdout.write('Production topology valid: one private round-service replica with explicit process-local SSE guard\n')
