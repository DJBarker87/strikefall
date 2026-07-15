#!/usr/bin/env bash
set -euo pipefail

# Cargo.lock includes rsa 0.9.10 through SQLx's optional MySQL support even
# though this workspace enables only Postgres. Cargo-audit correctly scans the
# complete lockfile and therefore reports RUSTSEC-2023-0071. Keep the exception
# narrow and fail before the audit if that exact vulnerable crate ever enters
# the active feature graph.
if cargo tree --locked --target all --prefix none -i rsa@0.9.10 2>/dev/null \
  | grep -q '^rsa v0\.9\.10'; then
  echo 'RUSTSEC-2023-0071 exception is invalid: rsa 0.9.10 is active' >&2
  exit 1
fi

if cargo tree --locked --target all --prefix none -i sqlx-mysql@0.8.6 2>/dev/null \
  | grep -q '^sqlx-mysql v0\.8\.6'; then
  echo 'RUSTSEC-2023-0071 exception is invalid: sqlx-mysql 0.8.6 is active' >&2
  exit 1
fi

cargo audit --deny warnings --ignore RUSTSEC-2023-0071
