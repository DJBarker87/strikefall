# Strikefall SBF quote benchmark

This isolated harness measures the exact `strikefall-core` one-sided no-touch
quote linked against the workspace's pinned `solmath = "=0.2.0"`. It is release
evidence, not an on-chain game or deployment path.

The script builds a parsing-only baseline and the quote variant with the same
Solana 2.3 SBF toolchain, reports linked bytes, then loads the quote artifact at
genesis in an ephemeral local validator. It uses unsigned simulations only—no
wallet, keypair, fee, public cluster, or signed transaction is involved. CU is
the difference between log markers immediately before and after the product
quote. The default campaign spans 200 deterministic upper/lower, drift,
variance, and distance inputs and enforces the plan's `<30,000 CU` maximum.

```sh
cd tools/sbf-benchmark
npm ci
cd ../..
NO_DNA=1 ./tools/sbf-benchmark/run.sh
```

The machine-readable result is written to `report.json`. The script also
retains the exact measured parsing baseline and quote binaries under
`artifacts/`. The report binds their byte counts and SHA-256 digests to a
SHA-256 inventory of the workspace manifests, isolated lockfile, harness, and
`strikefall-core` source. Run `npm run test:sbf:report` from the repository root
to recompute all retained source and binary hashes without claiming to rerun
Agave. Toolchain or bound-source changes must regenerate the campaign;
measurements are not portable across SVM versions. A report generated without
a clean git commit remains useful regression evidence but is not release-bound.
