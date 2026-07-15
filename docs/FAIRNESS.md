# Strikefall fairness and model policy

Strikefall is a synthetic, non-redeemable points game against 19 disclosed
bots. The bots are never presented as people and do not receive the hidden
battle path.

## What is fixed before placement

A ranked service generates independent path and bot randomness, the complete
deck/path digest, and a salt before placement. It publishes a SHA-256
commitment that binds the protocol version, round, deck, path, isolated bot
root, and salt. After the round it reveals the material needed to regenerate the
path. The replay also contains a chained, Ed25519-signed event log. The standalone
inspector accepts an externally captured commitment and server public key so a
self-consistent forged bundle is not treated as proof.

The server rate-limits flag movement, freezes updates for the last 750 ms of
placement, then signs the locked-score vector and an absolute battle-start time
exactly 2,000 ms later. It validates at most one Escape during the public
window, recomputes every touch and score, and excludes a replay mismatch from
ranking. The Rust/WASM verifier rejects a shortened, extended, or reordered
lock beat.

## Bot policy

Every bot has a labelled persona, stable parameters, 250–1,500 ms reaction
latency, and one to three placement moves. Placement decisions sample public
state at a signed observation timestamp and act only after the declared
latency; intervening player moves are excluded. Escape policies are
persona-specific and use only public deck, time, line, crowd, rank, and isolated
bot randomness. Ranked replay v3 exposes every candidate barrier, quoted
survival, projected crowd factor, terminal score, utility, selected candidate,
public-input and entropy digests, observation/action timestamps, latency, and
reason. The service publishes only due actions and persists the schedule cursor,
so recovery cannot reveal a future bot move.

## Mathematical claim

The score quote is a one-sided, drift-aware no-touch / first-passage model over
remaining integrated variance. Strikefall composes the pinned `solmath =
"=0.2.0"` fixed-point primitives; it does not claim that this model is NIG, a vanilla
American option, a forecast, or investment advice.

The committed 80-decimal `mpmath` corpus contains 100,000 production vectors
across every launch schedule and boundary plus 10,000 labelled adversarial
near-barrier, tiny-variance, drift-limit, reflection, breach, and fixed-point
cases. Byte-for-byte regeneration and a manifest bind the CSVs, generator,
requirements, seeds, row counts, and SHA-256 digests. The current release-mode
Rust/SolMath report observes maximum absolute probability error of 276 scaled
units (2.76e-10) in production and 546,984 scaled units (5.46984e-7) in the
adversarial set, inside the declared 2e-7 and 1e-6 bounds respectively.

Active Deck v3, ranked replay v3, and local replay v4 use the explicit
monitoring marker `strikefall/brownian-bridge-extrema/v1`. Deck v3 preserves the
frozen v2 monitoring semantics while committing a disclosed per-deck opening
runway. Every 250 ms public frame retains its close plus a conditional upper
maximum and lower minimum obtained by analytic inverse-CDF sampling in log
space—not a sampled micro-path. Touches, closest
approach, Escape hindsight,
Canvas wicks, signed events, commitments, and replay verification all consume
those same extrema. The signed stream therefore remains 241 battle points
(initial point plus 240 intervals), rather than expanding into 40/60 Hz events.

Conditioned on two diffusion endpoints, drift drops out and the one-sided
maximum CDF is `1 - exp(-2(m-x)(m-y)/v)`. Strikefall inverts this law with
domain-separated randomness for each interval. The upper and lower extrema
each have the analytically exact continuous one-sided marginal before
fixed-point rounding. Their uniforms are independent, so Strikefall does **not**
claim the exact joint law of hitting both sides within one interval; same-frame
upper/lower cluster correlation is an approximation, and intra-interval touch
time is reported at the 250 ms frame boundary.

`python3 tools/model-validation/bridge_extrema.py --samples 100000` enforces a
0.75 percentage-point absolute quote/monitor residual ceiling across upper,
lower, near, launch-scale, and high-variance cases. The committed implementation
campaign currently observes a worst residual of 0.2305 percentage points;
endpoint-only monitoring undercounts materially in every case. This is
statistical validation, not a claim of zero numerical error or independent
quant sign-off.

The retained SBF harness measures the same product-core quote linked to
`solmath = "=0.2.0"`: 200 vectors record 10,904 average, 11,308 p99, and 11,317
maximum math CU against the 30,000-CU ceiling. The 107,608-byte quote artifact
has an 85,256-byte delta over its parsing baseline. These figures are
toolchain-bound engineering evidence, not an on-chain game or deployment.

## Balance claim

The scoring default uses target same-band density `d_target = 0.8` and kernel
bandwidth `h = 1.25` in normalized sigma distance. The production-engine G2
campaign in `src/game/balanceG2.test.ts` tests eight survival bands on both
sides, using four independently locked lobbies and 320 domain-separated common
continuations per lobby and deck (2,560 side outcomes per band/deck). The
retained run's largest exact expected band/deck-mean ratio was about 1.126
against a 1.15 ceiling; its worst paired one-sided 99% realized-advantage upper
bound was 17.3% against 22%. Every natural lobby used both sides and at least six
bands, with exact crowd-factor spans of at least 0.30.

That campaign rejects a generally dominant probability band in the tested
engine distribution. It does not replace observed player behavior, promotion-
ready deck provenance, or an independent quantitative review.

## Browser arithmetic boundary

The public-alpha browser loads and smoke-tests the generated Rust/SolMath WASM
before it creates any Practice round. A missing or failed module produces a
retry-only blocked screen; it does not select a JavaScript scoring formula.
The installed service worker precaches the hashed WASM asset with the rest of
the exact shell, which keeps the same engine available during offline Practice.

All score and quote inputs and outputs cross that boundary as canonical
SCALE=1e12 decimal strings. Practice Escape multiplies the retained locked
terminal score by the returned survival value with BigInt division by SCALE,
matching `solmath::fp_mul` truncation. Numeric conversions after that operation
are presentation values for canvas, copy, and telemetry; displaying a fixed
value as a `Number` is not treated as a financial or scoring calculation.

## Experiment boundary

Escape (`absent` or `midpoint`) and risk display (`probability` or
`danger-band`) are mandatory v2 assignments. Public Quick Run deliberately has
no deck assignment; one unbiased byte rotates the complete four-deck catalog.
An operator may explicitly enable the deck-structure (`flat` or
`compression-break`) closed-alpha A/B, in which case the assigned treatment
pins that Quick Run deck. Named Daily/Weekly decks override the optional deck
treatment, and a rematch keeps the selected deck without inventing a cohort.
Ranked assignments are copied from the anonymous server session into the round,
signed event log, replay, and public anchor. Practice hashes a separate local
subject, so its treatment need not match the same browser's ranked treatment.
Reported cuts are descriptive until sample thresholds and human A/B gates are
met. Existing three-key session/replay rows remain valid; new public sessions
use the two-key map, so this rollout needs no destructive data migration.

## Product boundary

Points cannot be bought, redeemed, transferred, or used as a claim on a pool.
There are no entry fees, deposits, survivor pots, or loss-chasing prompts. Any
future prize, payment, tradable value, or retail crypto exposure requires a new
legal, security, and responsible-product review.
