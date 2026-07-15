#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly RUST_TOOLCHAIN_VERSION="1.85.1"
readonly WASM_BINDGEN_VERSION="0.2.100"
readonly REQUESTED_TARGET_DIR="${CARGO_TARGET_DIR:-target}"
if [[ "${REQUESTED_TARGET_DIR}" = /* ]]; then
  readonly TARGET_CANDIDATE="${REQUESTED_TARGET_DIR}"
else
  readonly TARGET_CANDIDATE="${ROOT_DIR}/${REQUESTED_TARGET_DIR#./}"
fi
mkdir -p "${TARGET_CANDIDATE}"
readonly TARGET_DIR="$(cd "${TARGET_CANDIDATE}" && pwd -P)"
readonly CLI_ROOT="${TARGET_DIR}/wasm-bindgen-cli-${WASM_BINDGEN_VERSION}-rust-${RUST_TOOLCHAIN_VERSION}"
readonly CLI_BIN="${CLI_ROOT}/bin/wasm-bindgen"
readonly INPUT_WASM="${TARGET_DIR}/wasm32-unknown-unknown/release/strikefall_wasm.wasm"
readonly OUTPUT_DIR="${ROOT_DIR}/src/wasm/generated"
readonly STAGING_DIR="${TARGET_DIR}/strikefall-wasm-bindings"
readonly MODE="${1:-write}"

if [[ $# -gt 1 ]] || [[ "${MODE}" != "write" && "${MODE}" != "--check" ]]; then
  echo "Usage: $0 [--check]" >&2
  exit 2
fi

export CARGO_TARGET_DIR="${TARGET_DIR}"
cd "${ROOT_DIR}"

if ! rustup run "${RUST_TOOLCHAIN_VERSION}" rustc --version >/dev/null 2>&1; then
  rustup toolchain install "${RUST_TOOLCHAIN_VERSION}" --profile minimal --component rustfmt
fi
if ! rustup target list --installed --toolchain "${RUST_TOOLCHAIN_VERSION}" | grep -qx "wasm32-unknown-unknown"; then
  rustup target add --toolchain "${RUST_TOOLCHAIN_VERSION}" wasm32-unknown-unknown
fi

if [[ ! -x "${CLI_BIN}" ]] || [[ "$("${CLI_BIN}" --version 2>/dev/null)" != "wasm-bindgen ${WASM_BINDGEN_VERSION}" ]]; then
  rustup run "${RUST_TOOLCHAIN_VERSION}" cargo install wasm-bindgen-cli \
    --version "${WASM_BINDGEN_VERSION}" \
    --locked \
    --root "${CLI_ROOT}"
fi

rustup run "${RUST_TOOLCHAIN_VERSION}" cargo build \
  --locked \
  --package strikefall-wasm \
  --release \
  --target wasm32-unknown-unknown

rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}"
"${CLI_BIN}" \
  --target web \
  --typescript \
  --out-dir "${STAGING_DIR}" \
  --out-name strikefall_wasm \
  "${INPUT_WASM}"

if [[ "${MODE}" = "--check" ]]; then
  if ! diff -qr "${OUTPUT_DIR}" "${STAGING_DIR}"; then
    echo "Generated WASM bindings are stale. Run: ./scripts/build-wasm.sh" >&2
    exit 1
  fi
  echo "Committed Vite bindings match wasm-bindgen ${WASM_BINDGEN_VERSION} output."
else
  rm -rf "${OUTPUT_DIR}"
  mkdir -p "${OUTPUT_DIR}"
  cp "${STAGING_DIR}"/* "${OUTPUT_DIR}/"

  echo "Generated Vite bindings in ${OUTPUT_DIR} with wasm-bindgen ${WASM_BINDGEN_VERSION}."
fi
