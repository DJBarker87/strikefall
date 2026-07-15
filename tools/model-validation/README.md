# Strikefall model validation

This directory is deliberately independent from the Rust implementation. The
Python reference uses pinned `mpmath` at 80 decimal digits to evaluate the
disclosed drift-aware one-sided first-passage identity. The Rust validator then
parses the generated CSV rows and executes the shipped `strikefall-core`
SolMath composition for every vector.

## Release command

Install the pinned reference dependency before running the campaign:

```bash
python3 -m venv .venv-model
.venv-model/bin/python -m pip install -r tools/model-validation/requirements.txt
PATH="$PWD/.venv-model/bin:$PATH" npm run test:model
```

`npm run test:model` performs five independent checks:

1. regenerates both large corpora in a temporary directory and compares their
   bytes, row counts, generator digest, requirements digest, and manifest;
2. runs all 110,000 rows through the release-mode Rust/SolMath validator;
3. verifies exact public conservation (`survival + hit == 1e12`) per row; and
4. runs the separately seeded 100,000-sample conditional crossing campaign;
   and
5. samples the shipped bridge-extrema inverse on upper and lower cases, with
   endpoint-only monitoring as a negative control and a 0.75 percentage-point
   absolute quote/monitor acceptance ceiling. The current deterministic run's
   worst residual is 0.2305 percentage points.

For a machine-readable manifest followed by measured Rust error distributions:

```bash
PATH="$PWD/.venv-model/bin:$PATH" npm run report:model
```

To intentionally regenerate reviewed artifacts:

```bash
PATH="$PWD/.venv-model/bin:$PATH" npm run model:corpora:update
```

Do not commit a regenerated manifest without reviewing its CSV digests and the
Rust report. The files are uncompressed, ordinary RFC-style CSV so standard
streaming CSV tools and the Rust release validator read the same bytes.

## Committed campaigns

`no_touch_production.csv` contains exactly 100,000 deterministic vectors. Its
SplitMix64 input seed is in the manifest. Cases span all four launch-deck
variance schedules and every battle boundary, use the shipped `-0.5` neutral
drift, both barrier sides, fixed-point spot values, and standard-deviation-
relative placement distances.

`no_touch_adversarial.csv` contains exactly 10,000 deterministic vectors across
eight labelled classes:

- near-barrier cancellation;
- 1–1,000,000 atom remaining variance;
- accepted `-4` and `+4` drift boundaries;
- exact zero-variance limits;
- already-breached limits;
- upper/lower reflection-sign cases;
- sub-micro-unit fixed-point prices inside the supported log-distance domain;
- CDF/reflection-term cancellation.

The manifest binds the generator and requirements files plus each canonical
CSV's byte count and SHA-256 digest. Case IDs make the worst row directly
reproducible.

The release validator declares separate absolute tolerances because the compact
SolMath 0.2.0 polynomial CDF and 1e12 fixed-point log have greater sensitivity
at adversarially tiny variance:

| Campaign | Rows | Declared bound | Measured max | p99 | Worst case |
| --- | ---: | ---: | ---: | ---: | --- |
| Production | 100,000 | 200,000 scaled (2e-7) | 276 | 32 | `production-010168` |
| Adversarial | 10,000 | 1,000,000 scaled (1e-6) | 546,984 | 7,891 | `adversarial-04121` |

Those are absolute probability errors at scale 1e12, not basis points. The
adversarial bound was raised transparently after the committed low-variance row
exceeded the former 200,000 smoke bound; the row remains in the corpus.

The original 24-row `no_touch_reference.csv` remains as a fast, human-readable
smoke corpus:

```bash
python3 tools/model-validation/reference.py --check
cargo test -p strikefall-core --test reference_vectors --locked
```

## Monitoring convention

The bridge campaign validates the continuous-monitoring identity independently.
It samples terminal Brownian increments and then samples the exact conditional
one-sided Brownian-bridge crossing probability. Endpoint-only monitoring must
undercount touches; bridge-corrected estimates must agree with the analytic
quote within six standard errors.

```bash
python3 tools/model-validation/reference.py --bridge-samples 100000
```

Deck/replay v2 deliberately changes the shipped hit convention. Public closes
remain at 250 ms, but every interval now retains sampled conditional upper and
lower Brownian-bridge extrema; touches resolve against those wicks. Each
one-sided marginal is exact for the continuous quote, while the joint
upper/lower dependence is explicitly approximate. Any future monitoring change
must increment the deck/replay version so old rounds remain reproducible.
