#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
harness="$root/tools/sbf-benchmark"
manifest="$harness/program/Cargo.toml"
artifact="$harness/program/target/deploy/strikefall_sbf_benchmark.so"
artifact_dir="$harness/artifacts"
program_id="BdR4cSgZGQgXNo33SZSYQXy7XgEK61sHT4NQaAkc3PBm"
fee_payer="Dr5QfdFEChkNpR9bPcAdRXNLuc1gTu955EnhS5bBg8m5"
rpc_port="${STRIKEFALL_SBF_RPC_PORT:-18899}"
rpc_url="http://127.0.0.1:${rpc_port}"
temporary="$(mktemp -d)"
validator_pid=""

cleanup() {
  if [[ -n "$validator_pid" ]]; then
    kill "$validator_pid" >/dev/null 2>&1 || true
    wait "$validator_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary"
}
trap cleanup EXIT

build() {
  local feature="$1"
  local destination="$2"
  local -a args=(
    NO_DNA=1 cargo build-sbf
    --manifest-path "$manifest"
    --no-default-features
  )
  if [[ -n "$feature" ]]; then
    args+=(--features "$feature")
  fi
  env "${args[@]}"
  cp "$artifact" "$destination"
}

build "" "$temporary/baseline.so"
build "quote" "$temporary/quote.so"
mkdir -p "$artifact_dir"
# These are the exact measured binaries. Retaining both lets ordinary CI
# recompute the byte counts and hashes without pretending to rerun Agave.
install -m 0644 "$temporary/baseline.so" "$artifact_dir/baseline.so"
install -m 0644 "$temporary/quote.so" "$artifact_dir/quote.so"
baseline_bytes="$(wc -c < "$temporary/baseline.so" | tr -d ' ')"
quote_bytes="$(wc -c < "$temporary/quote.so" | tr -d ' ')"

NO_DNA=1 solana-test-validator \
  --ledger "$temporary/ledger" \
  --reset \
  --quiet \
  --rpc-port "$rpc_port" \
  --faucet-port "$((rpc_port + 101))" \
  --mint "$fee_payer" \
  --bpf-program "$program_id" "$temporary/quote.so" \
  >"$temporary/validator.log" 2>&1 &
validator_pid="$!"

program_ready="false"
for _ in {1..120}; do
  if ! kill -0 "$validator_pid" >/dev/null 2>&1; then
    cat "$temporary/validator.log" >&2
    exit 1
  fi
  account_json="$(NO_DNA=1 solana account "$program_id" --url "$rpc_url" --output json 2>/dev/null || true)"
  current_slot="$(NO_DNA=1 solana slot --url "$rpc_url" 2>/dev/null || true)"
  if [[ "$account_json" == *'"executable": true'* ]] \
    && [[ "$current_slot" =~ ^[0-9]+$ ]] \
    && (( current_slot >= 1 )); then
    program_ready="true"
    break
  fi
  sleep 0.25
done
if [[ "$program_ready" != "true" ]]; then
  cat "$temporary/validator.log" >&2
  printf 'SBF benchmark program %s was not executable at %s\n' "$program_id" "$rpc_url" >&2
  exit 1
fi

STRIKEFALL_SBF_BASELINE_BYTES="$baseline_bytes" \
STRIKEFALL_SBF_BASELINE_ARTIFACT="$artifact_dir/baseline.so" \
STRIKEFALL_SBF_QUOTE_ARTIFACT="$artifact_dir/quote.so" \
STRIKEFALL_SBF_RPC="$rpc_url" \
STRIKEFALL_SBF_PROGRAM_ID="$program_id" \
STRIKEFALL_SBF_FEE_PAYER="$fee_payer" \
STRIKEFALL_SBF_SOLANA_VERSION="$(NO_DNA=1 solana --version)" \
STRIKEFALL_SBF_BUILD_VERSION="$(NO_DNA=1 cargo-build-sbf --version | paste -sd ';' -)" \
node "$harness/measure.mjs"

printf 'SBF footprint: baseline=%s quote=%s delta=%s bytes\n' \
  "$baseline_bytes" "$quote_bytes" "$((quote_bytes - baseline_bytes))"
