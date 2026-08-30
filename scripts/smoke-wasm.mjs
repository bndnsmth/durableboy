import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const wasmPath = resolve(process.argv[2] ?? "src/emulator/sameboy.wasm");
const romPath = resolve(process.argv[3] ?? ".tmp/smoke.gb");
const FIXED_CLOCK_NS = 1_788_048_000_000_000_000n;
const module = await WebAssembly.compile(await readFile(wasmPath));
let memory;

const instance = await WebAssembly.instantiate(module, {
  env: {
    emscripten_notify_memory_growth() {},
  },
  wasi_snapshot_preview1: {
    clock_time_get(_clockId, _precision, pointer) {
      new DataView(memory.buffer).setBigUint64(pointer, FIXED_CLOCK_NS, true);
      return 0;
    },
    fd_close() {
      return 8;
    },
    fd_seek() {
      return 8;
    },
    fd_write() {
      return 8;
    },
  },
});

const core = instance.exports;
memory = core.memory;
core._initialize();

const rom = new Uint8Array(await readFile(romPath));
const romPointer = core.malloc(rom.byteLength);
new Uint8Array(memory.buffer, romPointer, rom.byteLength).set(rom);
const machine = core.db_create(0);

try {
  assert(machine !== 0, "machine allocation failed");
  assert(core.db_load_rom(machine, romPointer, rom.byteLength) === 0, "ROM load failed");

  let ticks = 0n;
  for (let frame = 0; frame < 180; frame += 1) {
    ticks += core.db_run_frame(machine);
  }
  assert(ticks > 20_000_000n, "virtual clock did not advance at 8 MHz");
  assert(core.db_framebuffer_size(machine) === 160 * 144 * 4, "invalid framebuffer size");

  const stateSize = core.db_state_size(machine);
  const statePointer = core.malloc(stateSize);
  assert(core.db_save_state(machine, statePointer, stateSize) === 0, "state save failed");
  const savedHash = core.db_state_hash(machine);
  core.db_run_frame(machine);
  assert(core.db_load_state(machine, statePointer, stateSize) === 0, "state restore failed");
  assert(core.db_state_hash(machine) === savedHash, "state hash did not restore");
  core.free(statePointer);

  console.log(
    JSON.stringify({
      message: "SameBoy smoke test passed",
      frames: 180,
      ticks: ticks.toString(),
      stateBytes: stateSize,
      stateHash: BigInt.asUintN(64, savedHash).toString(16).padStart(16, "0"),
    }),
  );
} finally {
  core.db_destroy(machine);
  core.free(romPointer);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
