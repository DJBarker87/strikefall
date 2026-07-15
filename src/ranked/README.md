# Ranked browser boundary

`src/ranked` is the dependency-free browser boundary for the authoritative
Axum round service. It accepts only `strikefall/ranked-replay/v3`; the browser's
`strikefall/replay/v4` document is local-practice proof material and must never
be submitted as a ranked result.

```ts
import {
  createAuthenticatedFetchEventSourceFactory,
  createRankedClient,
  createRankedRoundController,
} from './ranked'

const bearerToken = () => sessionStore.currentToken()
const client = createRankedClient({
  baseUrl: import.meta.env.VITE_ROUND_API_URL,
  bearerToken,
})
const round = createRankedRoundController({
  client,
  eventSource: createAuthenticatedFetchEventSourceFactory({ bearerToken }),
  replayRegenerator: createWasmRankedRegenerationAdapter(loadedWasmClient),
})
await round.start({ deckId: 'balanced_tape', deckVersion: 3 })
```

The create response contains the authoritative `playerPlacement` alongside the
bot roster, so ranked UI never fabricates an initial barrier while SSE opens.
The signed `placement_locked` event contains both `lockedScoresDigest` and the
complete authoritative `lockedScores` vector for immediate score rendering.

The controller exposes explicit `connecting`, `live`, `reconnecting`,
`offline`, `invalid`, and `resolved` connection states. A sustained disconnect
degrades the attempt to `local_practice`, disables every ranked mutation, and
stores a local completion without making an HTTP request.

Native `EventSource` automatically reconnects its existing connection with
`Last-Event-ID`. The stream layer also deduplicates the service's complete
snapshot, buffers short out-of-order gaps, and invalidates an unfilled gap. A
custom EventSource factory receives the last id when an explicit reconnect is
requested, so a header-capable polyfill can preserve the same behavior.
Closed-alpha streams use the fetch-backed factory above because native
`EventSource` cannot set `Authorization`. Bearer values and reconnect cursors
are sent only as headers, tokens are resolved again after rotation, and closing
the controller aborts the in-flight fetch.

After resolution, `controller.finalize()` anchors the replay to the create
response. Browser-native verification reproduces the Rust deck, path,
commitment, locked-score, result, and event digests and verifies every Ed25519
signature with WebCrypto. The required Rust/WASM adapter then regenerates the
catalog deck, path, bots, Escape audit, locked scores, touches, result, and
lifecycle semantics through the exact `verify_replay_bundle_against` function.
Missing WebCrypto or WASM support fails closed. Consumers can then call
`client.acknowledgeReplay()` with that verifier's version and proof digest.
