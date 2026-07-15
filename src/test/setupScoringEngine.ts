import { installScoringEngineClient } from '../engine'
import { loadStrikefallWasm } from '../wasm'

/**
 * Tests exercise the same committed Rust/SolMath binary as production. This
 * file is referenced only by Vitest's setupFiles and is absent from Vite's
 * production module graph.
 */
// Top-level setup is intentional: several pure model fixtures are constructed
// during test-module evaluation and must see the same real WASM core as tests.
// Node-only test input; browser production resolves Vite's hashed asset URL.
// @ts-expect-error Node types intentionally are not part of the app tsconfig.
const { readFile } = await import('node:fs/promises')
const wasmBytes = await readFile(
  new URL('../wasm/generated/strikefall_wasm_bg.wasm', import.meta.url),
)
const loaded = await loadStrikefallWasm({ moduleOrPath: wasmBytes, retry: true })
if (loaded.status !== 'ready') {
  throw new Error(loaded.status === 'unsupported' ? loaded.reason : loaded.error.message)
}
installScoringEngineClient(
  loaded.client,
  { id: 'balanced-tape', name: 'Balanced Tape' },
)
