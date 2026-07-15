# Strikefall performance evidence

This document records reproducible engineering budgets from the comprehensive
plan. Local and CI measurements are regression evidence; they are not a claim
about every phone, a normal mobile network, or physical Safari hardware.

## Enforced budgets

| Product boundary | Target | Command | Enforcement |
| --- | ---: | --- | --- |
| Quick Run enters deck reveal | `<2,000 ms` | `npm run test:qa:performance` | Chromium mobile-emulation CI |
| Ranked Quick Run enters committed deck reveal, warm assets | `<2,000 ms` | `npm run test:performance:ranked-mobile` | Production Compose with controlled Chromium network shaping |
| One-tap rematch enters deck reveal | `<2,000 ms` | `npm run test:qa:performance` | Chromium mobile-emulation CI |
| Placement/crowd UI input dispatch, p99 | `<16 ms` | `npm run test:qa:performance` | 160 alternating slider inputs in CI |
| Authoritative round creation, maximum | `<300 ms` | `npm run test:performance:api` | 3 warmups + 25 production-policy requests in Compose CI |
| SolMath quote on SBF, maximum | `<30,000 CU` | `npm run test:sbf` | Retained local-validator campaign and checked report |

The browser test attaches `performance-metrics.json` to its Playwright result.
The API test uses four ordinary anonymous sessions so all 28 calls respect the
same per-session and per-IP limits as the deployed alpha; it validates the
commitment, approach, round identity, and complete 19-bot roster on every
response. It writes `tools/performance/report.json` with every warmup and
measured duration, a SHA-256 inventory of the server/protocol/container source
inputs, runner and Docker versions, and the exact healthy container and image
IDs observed before and after the run. CI validates that JSON and uploads it as
a 30-day build artifact.

## Integrated local baselines

Measurements were taken on 2026-07-15 BST on an Apple M3 with 24 GiB RAM,
macOS 26.5, Chrome 150.0.7871.116, Docker 29.1.3, Node 23.1.0, and Rust 1.85.1.

The final uncommitted tree was rebuilt as production-shaped Compose images on a
fresh Postgres volume. The normal 3-warmup / 25-sample run returned:

```text
samples 25 · warmups 3 · sessions 4 · min 5.50 ms · p50 6.52 ms
p95 7.98 ms · p99/max 8.21 ms · target 300 ms · PASS
```

The retained report has a 45-file source/tooling manifest with SHA-256
`68f7d5c47653b4e9b4c5f2c3fc82cdb2e6b60214812d5761ddd95be128b7c718`
and records Docker 29.1.3, Compose 5.0.0-desktop.1, and the three exact healthy
image/container identities. Because this repository has no `HEAD` and the
entire worktree is untracked, the report correctly records
`releaseBound: false`; it is a current-tree regression result, not release
sign-off.

The ranked Compose browser journey then ran immediately, while all 28 benchmark
rounds were active and becoming due together. Bounded four-worker lifecycle
recovery kept the exact signed two-second lock responsive; the full ranked
round, proof receipt, identity-free public replay verification, and labelled
maintenance fallback passed in 1.6 minutes with no service failures.

The retained Agave/SBF report uses 200 deterministic vectors and records:

```text
math CU min 9,787 · average 10,904 · p95 11,303
p99 11,308 · max 11,317 · target 30,000 · PASS
quote artifact 107,608 bytes · parsing baseline 22,352 bytes
linked delta 85,256 bytes
```

`tools/sbf-benchmark/report.json` binds the exact toolchain, exact
`solmath = "=0.2.0"` dependency, CU percentiles, linked sizes, and a declared
22-file source/tooling manifest with tree SHA-256
`ac95ed7475531cdfaa23c7d32eb19a5fdeec449acd6a9f76a822537af5851fa0`.
The exact measured baseline and quote binaries are retained with SHA-256
`66af8eb3c5fc76bb19b934a80740a78efb5cef267ff65cfe4fe4f58b36e3933d`
and `dd5af1cd011668554cb0718c09bf48d56be39db39afcbf5a68a046c2f9253cf5`.
`npm run test:sbf:report` recomputes the current source inventory plus both
binary hashes and sizes in ordinary CI; regenerating CU values requires the
documented `solana-cli 2.3.0`, `solana-cargo-build-sbf 2.3.0`, platform-tools
1.48, and SBF rustc 1.84.1 toolchain plus an unsigned, genesis-loaded local
validator. This retained run also records no git commit and therefore is not
release-bound.

The current-tree mobile-emulation interaction lane recorded:

```text
Quick Run 491.81 ms · one-tap rematch 131.26 ms
crowd dispatch 160 samples · p50 0 ms · p95 0 ms · p99/max 1 ms · PASS
```

The Playwright reports retain `performance-metrics.json`; these local values
must still be associated with a clean release SHA before promotion.

## Controlled ranked network lane

`npm run test:performance:ranked-mobile` exercises the production Compose edge
in mobile Chromium. It first warms the fingerprinted JavaScript, CSS, and real
SolMath WASM assets without throttling, returns to a fresh ranked home screen,
then applies Chromium's Fast 3G profile: 150 ms latency, 1,600 Kbps download,
and 750 Kbps upload. The timed boundary begins at the player's Ranked Run click
and ends only when the committed deck phase and proof prefix are visible. This
keeps initial bundle download outside the interaction measurement while still
including the shaped ranked request, response transfer, validation, and render.

The current production-Compose run recorded:

```text
click to committed deck + proof 275.37 ms · target 2,000 ms · PASS
browser API transport 228.03 ms · informational under the shaped connection
create response 13,069 bytes · cold asset transfers during timing 0
```

The separate unshaped authoritative API command remained
`npm run test:performance:api` and recorded:

```text
min 5.50 ms · p50 6.52 ms · p95 7.98 ms · p99/max 8.21 ms
target 300 ms · PASS
```

CI intentionally runs the unshaped API gate first and this controlled browser
gate second. Those gates use four plus one anonymous sessions, reaching the
closed-alpha per-IP session allowance. CI therefore tears down the test stack,
removes its Postgres volume, and restarts the already-built Compose images
before the full ranked lifecycle journey. That reset prevents performance-gate
data and rate limits from contaminating lifecycle evidence; it does not alter
either performance result.

This lane is a repeatable regression check under synthetic Chromium shaping.
It is not real-radio, carrier, physical-device, thermal, or physical mobile
Safari/Chrome evidence, so the external normal-mobile performance gate remains
open.

## Interpretation boundaries

- The two-second browser checks measure immediate client responsiveness. The
  production API budget separately measures authoritative creation, but a real
  radio/network campaign is still required before claiming a universal
  “normal mobile connection” result.
- Playwright's mobile Chromium and WebKit signals do not replace physical iOS
  Safari, desktop Safari, physical mobile Chrome, thermal, battery, or OS-level
  memory testing. Fifty-round endurance remains open on real Safari and
  physical mobile Chrome devices.
- The final integrated browser and Compose reruns pass locally, but the tree has
  no commit and all files are untracked. Both machine-readable evidence reports
  explicitly say they are not release-bound. Regenerate them from a clean
  release SHA and retain hosted-CI artifacts before treating them as
  public-alpha sign-off. Public launch is therefore a no-go; it also requires a
  completed 100–250-user invite-only stage and the external gates in the release
  audit.
- Compute-unit and byte measurements are toolchain-specific; any Agave,
  platform-tools, Rust, compiler-option, core, or SolMath change requires a new
  report.
