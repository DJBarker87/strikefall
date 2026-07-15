# Strikefall security and supply-chain policy

Strikefall is a points-only closed-alpha game: it has no wallet, custody,
payment, prize, redeemable balance, or per-round blockchain transaction. These
controls protect its anonymous sessions, unpublished round futures, signed
replays, and build pipeline; they are not a substitute for an independent
production security review.

## Automated dependency gates

CI installs the pinned `cargo-audit 0.22.0` release with its published lockfile
and runs `scripts/audit-rust.sh`. The script denies vulnerability,
unmaintained, unsound, and yanked advisories. Web CI audits runtime and build
dependencies at high severity or above with the committed npm lockfile.

GitHub Actions are referenced by full upstream commit SHA, checkout does not
persist the workflow token, and Docker build/runtime plus Postgres images are
referenced by multi-platform content digest. Version comments beside action
SHAs and readable image tags beside digests make deliberate updates reviewable.
An update must refresh the pin, run the relevant locked test lane, and retain
the evidence in a clean release commit.

### Narrow RustSec exception

`Cargo.lock` contains `rsa 0.9.10` through SQLx's optional MySQL dependency
surface, so a lockfile-wide audit reports `RUSTSEC-2023-0071` (the Marvin timing
attack). Strikefall configures SQLx with `default-features = false` and only
the Postgres, Tokio/Rustls, JSON, migration, and macro features. Neither
`sqlx-mysql 0.8.6` nor `rsa 0.9.10` appears in the active workspace feature
tree, and no Strikefall runtime uses RSA.

The CI exception ignores only `RUSTSEC-2023-0071` and first fails if either
exact crate becomes active. Any SQLx feature or version change must re-run both
the active-graph guard and the full audit. Remove the exception when the lockfile
no longer contains the affected package or upstream ships a fixed version.

## Secret handling

- No populated `.env` file belongs in source control; `.gitignore` excludes all
  `.env*` files except the placeholder-only `.env.example`.
- Production prefers `STRIKEFALL_SIGNING_KEY_FILE` from a secret manager. On
  Unix the service refuses a production key file readable by group or others.
  Inline key injection remains an orchestrator alternative and must never be
  committed or printed.
- Compose requires explicit random Postgres and signing secrets. CI generates
  fresh masked values per job rather than embedding reusable credentials.
- Raw session tokens, invite codes, and client IP addresses are not stored in
  Postgres; the service persists domain-separated digests. The operator metrics
  endpoint fails closed unless its own token is configured.
- Round futures, seeds, bot roots, and salts are currently stored in the
  canonical round JSONB document for crash recovery. Production therefore
  requires encrypted Postgres storage, encrypted backups, a private service
  network, and strict database access. Application envelope encryption remains
  a documented hardening item.
- Logs and telemetry must never contain authorization headers, signing keys,
  unrevealed path material, invite codes, raw IP addresses, or replay mismatch
  payloads.

## Residual release requirements

Before an Internet-facing alpha, run repository secret scanning and container
vulnerability/SBOM scanning in the actual hosting environment, verify TLS and
secret-manager configuration, schedule the documented retention cleanup, and
exercise backup restore plus signing-key rotation. A clean hosted CI run and an
independent security review remain external release evidence.
