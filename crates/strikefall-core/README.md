# strikefall-core

This crate implements Strikefall's game-specific deterministic rules. Fixed
point values use SolMath's `SCALE = 1e12`.

## SolMath dependency

The workspace pins the official crates.io package `solmath = "=0.2.0"`
(repository `https://github.com/DJBarker87/solmath`; the `v0.2.0` tag
resolves to `79cd09f2032eac0e76e45b37d7f72faa38847a4a`). Path generation and
drift-aware quotes use its public `fp_*`, `ln_fixed_i`,
`exp_fixed_i`, `norm_cdf_poly`, and `inverse_norm_cdf` primitives.

## Current first-passage API gap

The build document proposes a drift-aware SolMath `first-passage` feature that
accepts remaining integrated variance. That feature does not exist in the
published 0.2.0 API. Until it ships independently, this product crate:

- assembles the disclosed constant-drift formula from released SolMath
  primitives for neutral and future public continuation decks; and
- preserves `survival + hit == SCALE` through paired public rounding.

No game decks, RNG, crowding, or points logic has been added to SolMath.

## Monitoring convention

Active deck v3 uses `strikefall/brownian-bridge-extrema/v1` and an explicit
40-step opening runway. The runway assigns a versioned share of first-quarter
variance to those steps, then catches up exactly by step 60; all four public
quarter totals and final integrated variance remain unchanged. Frozen deck v2
references retain their original linear clock for historical replay.

Each generated 250 ms point carries its close and conditional Brownian-bridge
`interval_high` / `interval_low` in log space. Upper and lower extrema use
independent, domain-separated uniforms: each continuous one-sided marginal is
exact before fixed-point rounding, while their joint dependence is explicitly
approximate. Hits, closest approach, candles, streams, and replays use the
retained extrema. Touch time remains quantized to the public interval boundary,
and the engine does not claim an exact two-sided corridor path.
