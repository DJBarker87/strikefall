# Strikefall browser WASM

`adapter.ts` is the browser-facing boundary for the deterministic Rust engine. It lazy-loads the generated module, exposes explicit `unsupported` and `error` states, validates every returned JSON object, and refuses JavaScript `number` values for fixed-point or seed inputs.

## Rebuild bindings

```bash
./scripts/build-wasm.sh
```

The script builds `strikefall-wasm` for `wasm32-unknown-unknown`, installs an isolated `wasm-bindgen-cli` **0.2.100** under `target/` when needed, and regenerates `src/wasm/generated/` with the Vite-compatible `web` target. Rust **1.85.1**, the WASM target, the library dependency, and the generator are all pinned.

Generated `.js`, `.d.ts`, and `.wasm` files are source artifacts and should be committed. `target/` remains disposable.

## Verify the boundary

```bash
./scripts/check-wasm.sh
```

That command is non-mutating and performs four independent checks:

1. Regenerates bindings into `target/` and fails when committed source artifacts are stale.
2. Recreates native Rust golden outputs and diffs them against `golden-vectors.json`.
3. Instantiates the generated WebAssembly in Node and compares deck catalog, no-touch quote, barrier solve, complete path replay, lobby scoring, and the frozen authoritative ranked replay against native Rust.
4. Builds an isolated production Vite entry and runs it in headless Chromium, proving the lazy adapter and emitted hashed `.wasm` asset load together.

When an intentional core change updates the vectors, inspect the diff and then run:

```bash
./scripts/update-wasm-goldens.sh
```

## Browser use

```ts
import { loadStrikefallWasm } from './wasm'

const result = await loadStrikefallWasm()
if (result.status === 'ready') {
  const decks = result.client.deckCatalog()
  // verifyRankedReplayJson delegates to Rust's full v2 replay verifier.
}
```

Inputs representing Rust `u128`, `i128`, or `u64` values must be decimal strings or `bigint`; the adapter converts them to canonical decimal strings before calling WebAssembly.
