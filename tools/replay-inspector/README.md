# replay-inspector

Audit a revealed ranked replay by regenerating its path and bot roster,
recomputing locked SolMath scores, touches, ranks and proof, and checking the
ordered Ed25519 event chain.

Human output groups every clearly labelled BOT and prints each canonical
observation → action interval, reaction delay, candidate count, selected
side/barrier, chosen utility, and disclosed reason. The verified JSON retains
every candidate score and its public-state/entropy commitments for deeper
inspection.

```sh
cargo run -p replay-inspector -- replay.json \
  --expected-commitment <value-captured-at-round-creation> \
  --expected-server-key <trusted-ed25519-public-key>
```

Use `-` as the path for standard input and `--json` for a machine-readable
report. A mismatch exits unsuccessfully with the first failed invariant.
