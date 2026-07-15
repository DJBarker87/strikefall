# Strikefall deck calibrator

This directory contains the offline, standard-library-only pipeline for turning
reviewed local log-return CSVs into versioned Strikefall regime-deck artifacts.
It implements the roadmap's feature boundary: source data may influence when
variance occurs, but no historical path becomes a game path.

The tool makes no network requests and has no third-party Python dependencies.
Python 3.11 or newer is recommended.

## What crosses the calibration boundary

The derivation command reads exactly one configured CSV column. In memory it:

1. splits each candidate window into four equal phases;
2. sums squared log returns in each phase;
3. normalizes the four sums to exactly 1,000,000 integer parts per million;
4. clusters shapes with deterministic integer k-medoids; and
5. exports only medoids, aggregate counts, reviewed provenance, and digests.

Source rows, individual returns, observation labels, reference levels, signs,
ordering, and literal paths are never exported. An export-key guard rejects
common source-level field names if they appear anywhere in an artifact.

CSV contents remain subject to their original licence. Keep real source data
out of Git unless its licence explicitly permits redistribution.

## Quick start with the synthetic fixture

Run these commands from `tools/deck-calibrator`:

```sh
tmpdir="$(mktemp -d)"

python3 calibrate.py derive \
  --source fixtures/synthetic_returns.csv fixtures/synthetic_source.json \
  --window-size 16 \
  --stride 16 \
  --clusters 4 \
  --output "$tmpdir/calibration.json"

python3 calibrate.py compile \
  --template fixtures/four_decks.template.json \
  --calibration "$tmpdir/calibration.json" \
  --simulation-rounds 512 \
  --output "$tmpdir/catalog.json"

python3 calibrate.py validate \
  "$tmpdir/catalog.json" \
  --simulation-rounds 512
```

Omit `--output` or `--report` to write JSON to stdout. Repeating the same
commands over the same bytes produces the same artifacts and campaign metrics.
No current time, absolute path, platform RNG, or file iteration order enters a
digest.

## Source manifests and licence review

Each `--source` pairs a local CSV with a separate manifest. The pair can be
repeated to combine licensed venues without letting windows cross source
boundaries.

```json
{
  "schema": "strikefall/calibration-source/v1",
  "source_id": "reviewed_feed_name_v1",
  "source_kind": "licensed_market_data",
  "description": "Human-readable source and cleaning description.",
  "sampling_interval": "one minute",
  "return_kind": "log_return",
  "return_column": "log_return",
  "local_only": true,
  "license": {
    "identifier": "the reviewed licence identifier",
    "name": "the reviewed licence name",
    "reference": "a durable contract, policy, or local review reference",
    "terms_confirmed": true
  }
}
```

The tool intentionally refuses to guess a licence. `terms_confirmed: true` is a
human assertion, not an automated legal conclusion. It also refuses remote
inputs, simple returns, missing values, non-finite decimals, repeated source
IDs, and windows with a zero-variance phase.

The fixture source is original synthetic data released under CC0. It tests the
pipeline but is automatically marked ineligible for ranked promotion.

## Template shape modes

`compile` accepts two explicit selection modes per deck:

- `cluster_nearest` selects the unused medoid nearest a declared target shape.
  Selection is deterministic, and the squared target distance is recorded.
- `hand_authored` validates an exact four-weight allocation and requires a
  rationale. This works without a calibration artifact when the template
  supplies its own reviewed provenance.

Both modes produce the same runtime schema. The launch fixture selects the four
roadmap shapes: Balanced Tape 25/25/25/25, Compression Break 5/10/25/60,
Opening Rush 55/25/15/5, and Pulse 15/35/15/35.

## Artifact and digest contract

The catalog uses decimal strings for 1e12 fixed-point model values so JavaScript
cannot silently round them. Every deck includes:

- identity, version, phase schedule, step convention, and total variance;
- drift, continuation rule, monitoring convention, and probability limits;
- art, audio, player-facing copy, and deterministic variance fixtures;
- source/calibration evidence and a SHA-256 `calibration_digest`.

Canonical digests use sorted UTF-8 JSON with no insignificant whitespace. A
deck digest binds model assumptions, sanitized provenance, runtime parameters,
visual metadata, and selection evidence. The catalog digest binds every deck
and fixture but excludes the validation report, allowing a campaign to be
rerun at a larger sample count without changing round commitments.

Changing a deck after publication requires a new deck version. The validator
detects any unversioned mutation through the deck and catalog digests.

## Validation campaign

`compile` and `validate` run at least 128 deterministic rounds per deck. The
campaign checks:

- exact variance conservation and four-phase schedule integrity;
- observed realized variance against the declared total and phase allocation;
- nested barrier survival monotonicity;
- survivor count diversity and the roadmap's 2-6 median target on a
  risk-concentrated 20-flag reference ladder;
- non-zero score dispersion and elimination timing; and
- first-ten-second eight-hit stress rate as a coarse promotion warning.

This campaign is a calibration guardrail, not the production pricer or a full
game-balance oracle. It does not model crowding, bot placement policies,
the canonical three-or-more cluster event, bot placement, or Escape. A deck
with a clean artifact can still
have `ranked_promotion_ready: false`; the engine-level Rust/WASM campaign must
clear the product pacing gates before ranked enablement.

## Tests

```sh
python3 -m unittest discover -s tests -v
```

The suite covers exact bucketing, sign invariance, four-shape derivation,
deterministic output, source sanitization, licence/local-only enforcement,
cluster and hand-authored compilation, digest tamper detection, campaign
metrics, and the end-to-end CLI.

See `docs/decks/CALIBRATION.md` for the promotion checklist and the checked-in
synthetic sample catalog.
