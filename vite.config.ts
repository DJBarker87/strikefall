import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { SERVICE_WORKER_TEMPLATE } from './scripts/service-worker-template'
import { PRACTICE_NETWORK_ONLY_PATHS } from './src/pwa/cachePolicy'
const PUBLIC_SHELL_ASSETS = [
  '/favicon.svg',
  '/icons/apple-touch-icon.png',
  '/icons/strikefall-icon-192.png',
  '/icons/strikefall-icon-512.png',
  '/icons/strikefall-icon.svg',
  '/icons/strikefall-maskable-512.png',
  '/icons/strikefall-maskable.svg',
  '/manifest.webmanifest',
] as const

interface BuildOutput {
  type: 'asset' | 'chunk'
  code?: string
  source?: string | Uint8Array
}

function sourceText(output: BuildOutput): string {
  if (output.type === 'chunk') return output.code ?? ''
  return typeof output.source === 'string'
    ? output.source
    : output.source?.toString() ?? ''
}

function appendHash(hash: number, value: string): number {
  let next = hash
  for (let index = 0; index < value.length; index += 1) {
    next ^= value.charCodeAt(index)
    next = Math.imul(next, 16_777_619)
  }
  return next >>> 0
}

function practiceServiceWorker(): Plugin {
  return {
    name: 'strikefall-practice-service-worker',
    apply: 'build' as const,
    generateBundle(_options, bundle) {
      const template = SERVICE_WORKER_TEMPLATE
      const outputs = Object.entries(bundle)
        .filter(([fileName]) => fileName === 'index.html' || fileName.startsWith('assets/'))
        .sort(([left], [right]) => left.localeCompare(right))
      let fingerprint = appendHash(2_166_136_261, template)
      for (const [fileName, output] of outputs) {
        fingerprint = appendHash(fingerprint, fileName)
        fingerprint = appendHash(fingerprint, sourceText(output))
      }
      const version = fingerprint.toString(16).padStart(8, '0')
      const precacheUrls = [
        '/index.html',
        ...outputs
          .map(([fileName]) => `/${fileName}`)
          .filter((url) => url !== '/index.html'),
        ...PUBLIC_SHELL_ASSETS,
      ]
      const source = template
        .replace('__STRIKEFALL_CACHE_VERSION__', JSON.stringify(version))
        .replace('__STRIKEFALL_PRECACHE_URLS__', JSON.stringify(precacheUrls))
        .replace('__STRIKEFALL_NETWORK_ONLY_PATHS__', JSON.stringify(PRACTICE_NETWORK_ONLY_PATHS))

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source,
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), practiceServiceWorker()],
  server: {
    port: 4173,
  },
  preview: {
    port: 4173,
  },
})
