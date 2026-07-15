#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly RUST_TOOLCHAIN_VERSION="1.85.1"
readonly REQUESTED_TARGET_DIR="${CARGO_TARGET_DIR:-target}"
if [[ "${REQUESTED_TARGET_DIR}" = /* ]]; then
  readonly TARGET_CANDIDATE="${REQUESTED_TARGET_DIR}"
else
  readonly TARGET_CANDIDATE="${ROOT_DIR}/${REQUESTED_TARGET_DIR#./}"
fi
mkdir -p "${TARGET_CANDIDATE}"
readonly TARGET_DIR="$(cd "${TARGET_CANDIDATE}" && pwd -P)"
readonly ACTUAL_GOLDENS="${TARGET_DIR}/strikefall-wasm-goldens.json"
readonly EXPECTED_GOLDENS="${ROOT_DIR}/src/wasm/golden-vectors.json"

export CARGO_TARGET_DIR="${TARGET_DIR}"

"${ROOT_DIR}/scripts/build-wasm.sh" --check

CARGO_TARGET_DIR="${TARGET_DIR}/wasm-goldens" rustup run "${RUST_TOOLCHAIN_VERSION}" cargo run \
  --quiet \
  --locked \
  --manifest-path "${ROOT_DIR}/scripts/wasm-goldens/Cargo.toml" \
  > "${ACTUAL_GOLDENS}"

if ! diff -u "${EXPECTED_GOLDENS}" "${ACTUAL_GOLDENS}"; then
  echo "Native Rust golden vectors changed. Review and run scripts/update-wasm-goldens.sh." >&2
  exit 1
fi

node "${ROOT_DIR}/scripts/check-wasm-goldens.mjs"
node "${ROOT_DIR}/scripts/check-wasm-vite.mjs"
