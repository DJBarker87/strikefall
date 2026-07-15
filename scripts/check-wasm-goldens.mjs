import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const fixture = JSON.parse(await readFile(new URL('src/wasm/golden-vectors.json', root), 'utf8'))
const bindings = await import(new URL('src/wasm/generated/strikefall_wasm.js', root))
const wasmBytes = await readFile(new URL('src/wasm/generated/strikefall_wasm_bg.wasm', root))
const rankedReplayJson = await readFile(
  new URL('crates/strikefall-protocol/tests/fixtures/ranked_replay_v3.json', root),
  'utf8',
)
const rankedAnchors = JSON.parse(await readFile(
  new URL('crates/strikefall-protocol/tests/fixtures/ranked_replay_v3_anchors.json', root),
  'utf8',
))

await bindings.default({ module_or_path: wasmBytes })

const { inputs, expected } = fixture
const actual = {
  barrierSolve: bindings.barrier_for_survival_fixed(
    inputs.barrierSolve.spot,
    inputs.barrierSolve.targetSurvival,
    inputs.barrierSolve.remainingVariance,
    inputs.barrierSolve.driftPerVariance,
    inputs.barrierSolve.side,
  ),
  deckCatalog: JSON.parse(bindings.deck_catalog_json()),
  lobbyScores: JSON.parse(
    bindings.lock_lobby_scores_json(
      inputs.lobbyScores.spot,
      inputs.lobbyScores.remainingVariance,
      inputs.lobbyScores.driftPerVariance,
      JSON.stringify(inputs.lobbyScores.placements),
    ),
  ),
  noTouchQuote: JSON.parse(
    bindings.quote_no_touch_json(
      inputs.noTouchQuote.spot,
      inputs.noTouchQuote.barrier,
      inputs.noTouchQuote.remainingVariance,
      inputs.noTouchQuote.driftPerVariance,
      inputs.noTouchQuote.side,
      inputs.noTouchQuote.alreadyBreached,
    ),
  ),
  roundPath: JSON.parse(
    bindings.generate_round_path_json(
      inputs.roundPath.deckId,
      inputs.roundPath.deckVersion,
      inputs.roundPath.seed,
      inputs.roundPath.initialSpot,
    ),
  ),
}

assert.deepStrictEqual(actual, expected)
assert.equal(actual.deckCatalog.length, 4)
assert.equal(actual.roundPath.approach.length, 61)
assert.equal(actual.roundPath.battle.length, 241)
assert.equal(actual.lobbyScores.length, 3)
const rankedReport = JSON.parse(bindings.verify_ranked_replay_json(
  rankedReplayJson,
  rankedAnchors.commitment,
  rankedAnchors.serverVerifyingKey,
))
assert.equal(rankedReport.valid, true)
assert.equal(rankedReport.roundId, rankedAnchors.roundId)
assert.equal(rankedReport.signedEvents, rankedAnchors.eventCount)

console.log('WASM matches native Rust goldens (deck, quote, barrier, path, lobby, ranked replay).')
