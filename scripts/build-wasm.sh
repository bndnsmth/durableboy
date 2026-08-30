#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SAMEBOY_DIR="$ROOT/vendor/SameBoy"
GENERATED_DIR="$ROOT/wasm/generated"
OUTPUT="$ROOT/src/emulator/sameboy.wasm"
SAMEBOY_COMMIT="213a12ce93d66b105a113debd9396306066a7cfc"

MISSING_TOOLS=()
for tool in git make rgbasm emcc xxd; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    MISSING_TOOLS+=("$tool")
  fi
done
if [[ ${#MISSING_TOOLS[@]} -gt 0 ]]; then
  printf 'Missing required build tools: %s\n' "${MISSING_TOOLS[*]}" >&2
  printf 'Install Emscripten and RGBDS, then rerun npm run wasm:build.\n' >&2
  exit 1
fi

mkdir -p "$ROOT/vendor" "$GENERATED_DIR" "$(dirname "$OUTPUT")"

if [[ ! -d "$SAMEBOY_DIR/.git" ]]; then
  git clone --filter=blob:none https://github.com/LIJI32/SameBoy.git "$SAMEBOY_DIR"
fi

git -C "$SAMEBOY_DIR" fetch --depth 1 origin "$SAMEBOY_COMMIT"
git -C "$SAMEBOY_DIR" checkout --detach "$SAMEBOY_COMMIT"
make -C "$SAMEBOY_DIR" -j bootroms CONF=release

BOOTROMS_C="$GENERATED_DIR/bootroms.c"
{
  printf '#include <stddef.h>\n#include <stdint.h>\n\n'
  xxd -i -n db_dmg_boot "$SAMEBOY_DIR/build/bin/BootROMs/dmg_boot.bin"
  xxd -i -n db_cgb_boot "$SAMEBOY_DIR/build/bin/BootROMs/cgb_boot.bin"
} > "$BOOTROMS_C"

SOURCES=(
  "$ROOT/wasm/durableboy.c"
  "$BOOTROMS_C"
  "$SAMEBOY_DIR/Core/gb.c"
  "$SAMEBOY_DIR/Core/sgb.c"
  "$SAMEBOY_DIR/Core/apu.c"
  "$SAMEBOY_DIR/Core/memory.c"
  "$SAMEBOY_DIR/Core/mbc.c"
  "$SAMEBOY_DIR/Core/timing.c"
  "$SAMEBOY_DIR/Core/display.c"
  "$SAMEBOY_DIR/Core/camera.c"
  "$SAMEBOY_DIR/Core/sm83_cpu.c"
  "$SAMEBOY_DIR/Core/joypad.c"
  "$SAMEBOY_DIR/Core/save_state.c"
  "$SAMEBOY_DIR/Core/random.c"
  "$SAMEBOY_DIR/Core/rumble.c"
)

EXPORTED_FUNCTIONS='["_malloc","_free","_db_create","_db_destroy","_db_load_rom","_db_reset","_db_set_buttons","_db_run_frame","_db_framebuffer","_db_framebuffer_size","_db_state_size","_db_save_state","_db_load_state","_db_state_hash","_db_battery_size","_db_save_battery","_db_load_battery","_db_battery_dirty","_db_clear_battery_dirty","_db_connect_link","_db_disconnect_link","_db_run_link_frame"]'

emcc "${SOURCES[@]}" \
  -I"$SAMEBOY_DIR" -I"$ROOT/wasm" \
  -std=gnu11 -D_GNU_SOURCE -DGB_INTERNAL -DGB_VERSION='"1.0.3-durableboy"' \
  -DGB_DISABLE_TIMEKEEPING -DGB_DISABLE_REWIND -DGB_DISABLE_DEBUGGER \
  -DGB_DISABLE_CHEATS -DGB_DISABLE_CHEAT_SEARCH \
  -O3 -flto -ffast-math -DNDEBUG -fno-stack-protector -lm \
  --no-entry -sSTANDALONE_WASM=1 -sFILESYSTEM=0 \
  -sMALLOC=emmalloc -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=100663296 -sSTACK_SIZE=1048576 \
  -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -Wl,--strip-all \
  -o "$OUTPUT"

printf 'Built %s (%s bytes)\n' "$OUTPUT" "$(wc -c < "$OUTPUT" | tr -d ' ')"
node "$ROOT/scripts/inspect-wasm.mjs" "$OUTPUT"
