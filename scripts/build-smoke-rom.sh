#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT/.tmp"

for tool in rgbasm rgblink rgbfix; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing required smoke-ROM tool: %s\n' "$tool" >&2
    exit 1
  fi
done

mkdir -p "$OUTPUT_DIR"
rgbasm -Wall -Werror -o "$OUTPUT_DIR/smoke.o" "$ROOT/test/fixtures/smoke.asm"
rgblink -d -o "$OUTPUT_DIR/smoke.gb" "$OUTPUT_DIR/smoke.o"
rgbfix -v -p 0xff -t DB-SMOKE "$OUTPUT_DIR/smoke.gb"

size="$(wc -c < "$OUTPUT_DIR/smoke.gb" | tr -d ' ')"
if [[ "$size" != "32768" ]]; then
  printf 'Unexpected smoke ROM size: %s\n' "$size" >&2
  exit 1
fi
printf 'Built original smoke ROM at %s\n' "$OUTPUT_DIR/smoke.gb"
