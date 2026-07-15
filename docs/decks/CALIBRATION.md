# Strikefall deck calibration and promotion

Strikefall decks are versioned generative rules. They are not historical
charts, replayed price windows, predictions, NIG processes, or American-option
models. Every round draws a fresh diffusion path under the declared quarter
variance clock.

The checked-in `sample-catalog.v3.json` is the active synthetic-alpha artifact.
It adds a version-bound opening runway while preserving every declared quarter
variance total. `sample-catalog.v2.json` remains frozen so historical replays
resolve the original linear clock instead of aliasing to v3. Both catalogs are
valid examples, but `ranked_promotion_ready` is deliberately false: synthetic
data is not ranked provenance. The production-engine campaign below tests
actual pacing but cannot supply the missing licence or human evidence.

The four active Rust launch constants bind the v3 catalog's per-deck
`calibration_digest` values so alpha commitments and replays detect any deck
mutation. That integrity binding does not turn the synthetic sample into
historical provenance and does not override `ranked_promotion_ready: false`.

## Launch deck intent

| Deck | Quarter variance | First-40-step share of Q1 | Player lesson | Visual / audio profile |
| --- | --- | ---: | --- | --- |
| Balanced Tape | 25 / 25 / 25 / 25 | 340 bps | Danger never leaves | electric cyan / steady pressure |
| Compression Break | 5 / 10 / 25 / 60 | 1,600 bps | Early calm makes close flags tempting | violet storm / rising break |
| Opening Rush | 55 / 25 / 15 / 5 | 125 bps | Give the opening room | solar flare / front-loaded impact |
| Pulse | 15 / 35 / 15 / 35 | 450 bps | Expect two elimination windows | magenta pulse / double drop |

All four currently declare equal total integrated variance (`0.0064` at the
1e12 fixed-point scale), neutral `-0.5` drift per unit variance, 240 battle
steps at 250 ms, and a 12%-97% legal initial-survival range. This equal-scale
set isolates temporal shape for playtesting.

Every active v3 deck binds `strikefall/brownian-bridge-extrema/v1` and an
`opening_runway` of 40 steps. If Q1 is the exact first-quarter variance and
`s` is the declared basis-point share, steps 0–40 receive `s × Q1` and steps
40–60 receive the remainder. Step 60, later quarter boundaries, and total
integrated variance are therefore identical to the linear v2 schedule. The
piecewise step-rate change is explicit rather than hidden:

| Deck | Variance at step 40 | Catch-up/runway per-step rate |
| --- | ---: | ---: |
| Balanced Tape | 54,400,000 | 56.824× |
| Compression Break | 51,200,000 | 10.500× |
| Opening Rush | 44,000,000 | 158.000× |
| Pulse | 43,200,000 | 42.444× |

This sharp boundary is the disclosed cost of keeping the roadmap's exact
quarter shapes while moving mass-wipe risk out of the first 10 seconds. It also
creates the intended 10–15 second ignition window. Smoothing it across quarter
boundaries would change the public deck model and requires another version.

Public closes stay at 250 ms while each interval retains conditional
Brownian-bridge high/low extrema. The exact one-sided marginals match the
continuous no-touch payoff; independent upper and lower uniforms approximate
only their joint dependence. The calibrator's shape campaign is an independent
offline guardrail and is not the engine-level promotion evidence required by
item 7 below.

## Ranked promotion checklist

A deck version may be considered for ranked rotation only after all of the
following are recorded:

1. Source data was supplied as local log returns under a documented licence.
2. A human confirmed the licence permits the intended offline feature use and
   recorded a durable reference in every source manifest.
3. The derivation artifact contains no source rows, literal path, observation
   labels, reference levels, signs, or source ordering.
4. Cluster selection or hand-authored rationale is explicit and reproducible.
5. The compiled catalog passes schema, fixed-point range, digest, privacy,
   variance-conservation, shape-distance, and deterministic campaign checks.
6. Rust and WASM load the same versioned parameters and reproduce the emitted
   cumulative-variance fixtures.
7. An engine-level campaign using real bot placement, crowding, touch
   monitoring, and opening pacing meets the product targets: 2-6 median
   survivors, no-elimination rounds below 10%, and first-ten-second mass wipes
   below 10%.
8. Browser playtests show both sides and at least six risk bands in a normal
   lobby, with no dominant placement band.
9. Player-facing claims say historical activity shaped a level; they never say
   the generated line replays, predicts, or exactly models a historical event.
10. Any model-bearing or visual change increments the deck version before the
    new calibration digest is committed to a ranked round.

## Current production-engine evidence

### Opening-runway selection

The canonical early-wipe event is an emitted cluster containing at least three
contenders at or before 10 seconds. It is not the separate coarse stress guard
of eight or more cumulative hits in that window. `src/game/balance.test.ts`
tracks both, asserts the public `<10%` early-cluster target for every deck, and
uses an internal `<=8%` point-rate target while selecting runway values.

A common runway was rejected because aggregate results hid Opening Rush. On the
same 256-seed-per-deck corpus, a uniform 400 bps schedule produced 10.94%
aggregate early clusters and 31.64% on Opening Rush. Uniform 300 bps reduced the
aggregate to 7.03% but Opening Rush still reached 22.27%. Per-deck schedules are
therefore model metadata, not a client-only delay.

The deterministic candidate search retained the smoothest tested point that
cleared the internal ceiling:

| Deck | Rejected smoother candidate | Observed early clusters | Retained share | Retained tuning result |
| --- | ---: | ---: | ---: | ---: |
| Balanced Tape | 350 bps | 83 / 1,024 = 8.105% | 340 bps | 75 / 1,024 = 7.324% |
| Compression Break | 1,800 bps | 23 / 256 = 8.984% | 1,600 bps | 15 / 256 = 5.859% |
| Opening Rush | uniform 300 bps | 57 / 256 = 22.266% | 125 bps | 47 / 1,024 = 4.590% |
| Pulse | 550 bps screen | 3 / 24 = 12.500% | 450 bps | 45 / 1,024 = 4.395% |

These are selection runs, not the retained release report. The final campaign
below is rerun after catalog, Rust, exact Practice hit resolution, WASM, and
fixtures are frozen.

### Retained exact pacing campaign

The retained campaign uses 1,024 deterministic seeds independently for each
deck. It exercises real bot placement, the Rust/SolMath WASM path, canonical
fixed-string/BigInt barriers and extrema, crowding, and exact hit resolution.
Each deck ran as its own test process so an aggregate could not hide a failing
shape.

| Deck | Survivors median / mean | Full-round no hit | No hit through 10 s | Early 3+ cluster | First-10 s 8-hit stress | 10–15 s mean hits | 10–15 s 3+ cluster | Any 3+ cluster |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Balanced Tape | 5 / 5.6465 | 0 / 1,024 | 834 / 1,024 (81.45%) | 75 / 1,024 (7.324%) | 0 / 1,024 | 9.5762 | 1,007 / 1,024 (98.34%) | 1,022 / 1,024 (99.80%) |
| Compression Break | 5 / 5.6377 | 0 / 1,024 | 838 / 1,024 (81.84%) | 74 / 1,024 (7.227%) | 2 / 1,024 (0.195%) | 4.0938 | 664 / 1,024 (64.84%) | 1,001 / 1,024 (97.75%) |
| Opening Rush | 5 / 5.8926 | 0 / 1,024 | 895 / 1,024 (87.40%) | 47 / 1,024 (4.590%) | 0 / 1,024 | 12.0566 | 1,021 / 1,024 (99.71%) | 1,021 / 1,024 (99.71%) |
| Pulse | 5 / 5.7617 | 0 / 1,024 | 885 / 1,024 (86.43%) | 45 / 1,024 (4.395%) | 0 / 1,024 | 7.9121 | 970 / 1,024 (94.73%) | 1,020 / 1,024 (99.61%) |

All four medians are inside 2–6; full-round no-hit rates and canonical early
mass-wipe rates are below the public 10% limits; every early-cluster point rate
also clears the internal 8% selection ceiling; every lobby is two-sided with a
median of at least six risk bands; and full-battle cluster drama is far above
the 25% floor. The 10–15 second window confirms that the runway moves action
rather than removing it.

If the deterministic seeds are treated as independent draws, descriptive 95%
Wilson intervals for early-cluster rates are 5.883–9.084% (Balanced),
5.795–8.977% (Compression), 3.469–6.050% (Opening Rush), and 3.300–5.830%
(Pulse). These intervals are context, not a replacement for the exact checked
corpus or observed-player evidence.

The report is reproducible one deck at a time, replacing the final deck ID with
each active slug:

```sh
VITE_BALANCE_REPORT=1 \
VITE_BALANCE_SAMPLES=1024 \
VITE_BALANCE_DECK=balanced-tape \
npx vitest run src/game/balance.test.ts --disableConsoleIntercept
```

### No-dominant-band campaign

`src/game/balanceG2.test.ts` runs the four launch decks with the shipped scoring
defaults `d_target = 0.8` and `h = 1.25` normalized sigma distance. It evaluates
eight probability bands on both sides using four independently locked lobbies
and 320 domain-separated common continuations per lobby and deck: 1,280 paths
per deck and 2,560 side outcomes per band/deck.

The retained run's maximum exact expected band/deck-mean ratio was about 1.126
against a 1.15 ceiling. Its worst paired one-sided 99% realized-advantage upper
bound was 17.3% against 22%. Every natural lobby used both sides and at least six
risk bands. Exact crowd-factor ranges were 0.75–1.10649 for Balanced Tape and
Compression Break, 0.75–1.08408 for Opening Rush, and 0.75–1.20883 for Pulse;
every span exceeded 0.30.

This closes the automated no-dominant-band and engine-distribution check for
the current synthetic alpha catalog. Checklist items 1–2 and 8 remain open:
licensed provenance and observed browser behavior cannot be inferred from a
deterministic campaign.

## Boundary between this tool and the game engine

The calibrator owns offline feature extraction, provenance, catalogue
compilation, and an independent smoke campaign. The Rust core owns the runtime
fixed-point schedule, deterministic random words, path generation, touch
semantics, scoring, and replay. SolMath supplies numerical primitives; it does
not own deck data or game randomness.

The calibrator's simulation deliberately does not claim price accuracy. It is
useful because a malformed schedule, collapsed shape, broken monotonic ladder,
or zero score variance is caught before integration. Product pacing still has
to be measured where the real game rules run.

## Reproducibility

The sample was generated from `tools/deck-calibrator/fixtures` with:

```sh
python3 calibrate.py derive \
  --source fixtures/synthetic_returns.csv fixtures/synthetic_source.json \
  --window-size 16 --stride 16 --clusters 4 \
  --output /tmp/strikefall-calibration-v3.json

python3 calibrate.py compile \
  --template fixtures/four_decks.template.json \
  --calibration /tmp/strikefall-calibration-v3.json \
  --simulation-rounds 512 \
  --output ../../docs/decks/sample-catalog.v3.json
```

Expected sanitized calibration digest:
`f96678f938085b1b17a62318ef8332478f3b56eb5b78160d31cff71cb9651a15`.

Expected canonical catalog digest:
`ec4b1629a2c7d40bc4c5eb5fc484276a2ac4f5a5af94586d4cc2e738463927fd`.

Expected SHA-256 of the complete formatted catalog file:
`32f5db0583d3d46ec28c6fe4667db1de55613696b66eac70a3d256f4c8f09054`.

The v2 catalog is not regenerated by this command. It is an immutable
compatibility input for historical deck references and ranked-replay-v3
payloads that committed deck version 2.
