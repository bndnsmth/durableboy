#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_BASE="https://github.com/bndnsmth/durableboy/releases/latest/download"
OUTPUT="$ROOT/src/emulator/sameboy.wasm"
EXPECTED="$ROOT/wasm/sameboy.wasm.sha256"
TEMP="${OUTPUT}.download"

mkdir -p "$(dirname "$OUTPUT")"
trap 'rm -f "$TEMP"' EXIT

curl --fail --location --retry 3 \
  "$RELEASE_BASE/sameboy.wasm" \
  --output "$TEMP"

expected_hash="$(cut -d ' ' -f 1 "$EXPECTED")"
actual_hash="$(shasum -a 256 "$TEMP" | cut -d ' ' -f 1)"
if [[ "$actual_hash" != "$expected_hash" ]]; then
  printf 'Wasm checksum mismatch: expected %s, received %s\n' \
    "$expected_hash" "$actual_hash" >&2
  exit 1
fi

mv "$TEMP" "$OUTPUT"
printf 'Installed verified SameBoy Wasm at %s\n' "$OUTPUT"
