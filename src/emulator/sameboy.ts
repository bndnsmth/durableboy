import sameBoyModule from "./sameboy.wasm";
import { FRAME_HEIGHT, FRAME_WIDTH, type ConsoleModel } from "../shared/protocol";
import type { Emulator } from "./types";

type NumberFunction = (...args: number[]) => number;
type BigIntFunction = (...args: number[]) => bigint;

interface SameBoyExports {
  memory: WebAssembly.Memory;
  initialize: () => void;
  malloc: NumberFunction;
  free: NumberFunction;
  create: NumberFunction;
  destroy: NumberFunction;
  loadRom: NumberFunction;
  setButtons: NumberFunction;
  runFrame: BigIntFunction;
  framebuffer: NumberFunction;
  framebufferSize: NumberFunction;
  stateSize: NumberFunction;
  saveState: NumberFunction;
  loadState: NumberFunction;
  stateHash: BigIntFunction;
  batterySize: NumberFunction;
  saveBattery: NumberFunction;
  loadBattery: NumberFunction;
  batteryDirty: NumberFunction;
  clearBatteryDirty: NumberFunction;
}

export class SameBoyEmulator implements Emulator {
  readonly model: ConsoleModel;

  readonly #exports: SameBoyExports;
  #handle: number;

  private constructor(model: ConsoleModel, exports: SameBoyExports, handle: number) {
    this.model = model;
    this.#exports = exports;
    this.#handle = handle;
  }

  static async create(model: ConsoleModel, rom: Uint8Array): Promise<SameBoyEmulator> {
    let memory: WebAssembly.Memory | null = null;
    const imports = createImports(() => memory);
    const instance = await WebAssembly.instantiate(sameBoyModule, imports);
    const exports = resolveExports(instance.exports);
    memory = exports.memory;
    exports.initialize();

    const handle = exports.create(model === "CGB" ? 1 : 0);
    if (handle === 0) {
      throw new Error("SameBoy could not allocate a machine");
    }

    try {
      withInput(exports, rom, (pointer, length) => {
        const result = exports.loadRom(handle, pointer, length);
        if (result !== 0) {
          throw new Error(`SameBoy rejected the ROM (${result})`);
        }
      });
      return new SameBoyEmulator(model, exports, handle);
    } catch (error) {
      exports.destroy(handle);
      throw error;
    }
  }

  get memoryBytes(): number {
    return this.#exports.memory.buffer.byteLength;
  }

  destroy(): void {
    if (this.#handle !== 0) {
      this.#exports.destroy(this.#handle);
      this.#handle = 0;
    }
  }

  setButtons(buttons: number): void {
    this.assertAlive();
    this.#exports.setButtons(this.#handle, buttons & 0xff);
  }

  runFrame(): bigint {
    this.assertAlive();
    return BigInt(this.#exports.runFrame(this.#handle));
  }

  framebuffer(): Uint8Array {
    this.assertAlive();
    const pointer = this.#exports.framebuffer(this.#handle);
    const size = this.#exports.framebufferSize(this.#handle);
    const expectedSize = FRAME_WIDTH * FRAME_HEIGHT * 4;
    if (pointer === 0 || size !== expectedSize) {
      throw new Error(`SameBoy returned an invalid framebuffer (${size} bytes)`);
    }
    return new Uint8Array(this.#exports.memory.buffer, pointer, size).slice();
  }

  saveState(): Uint8Array {
    this.assertAlive();
    const size = this.#exports.stateSize(this.#handle);
    return withOutput(this.#exports, size, (pointer) => {
      const result = this.#exports.saveState(this.#handle, pointer, size);
      if (result !== 0) {
        throw new Error(`SameBoy could not serialize state (${result})`);
      }
    });
  }

  loadState(state: Uint8Array): void {
    this.assertAlive();
    withInput(this.#exports, state, (pointer, length) => {
      const result = this.#exports.loadState(this.#handle, pointer, length);
      if (result !== 0) {
        throw new Error(`SameBoy could not restore state (${result})`);
      }
    });
  }

  stateHash(): string {
    this.assertAlive();
    return BigInt.asUintN(64, this.#exports.stateHash(this.#handle)).toString(16).padStart(16, "0");
  }

  batteryDirty(): boolean {
    this.assertAlive();
    return this.#exports.batteryDirty(this.#handle) !== 0;
  }

  saveBattery(): Uint8Array | null {
    this.assertAlive();
    const size = this.#exports.batterySize(this.#handle);
    if (size === 0) {
      return null;
    }
    return withOutput(this.#exports, size, (pointer) => {
      const result = this.#exports.saveBattery(this.#handle, pointer, size);
      if (result !== 0) {
        throw new Error(`SameBoy could not serialize battery data (${result})`);
      }
    });
  }

  loadBattery(battery: Uint8Array): void {
    this.assertAlive();
    withInput(this.#exports, battery, (pointer, length) => {
      const result = this.#exports.loadBattery(this.#handle, pointer, length);
      if (result !== 0) {
        throw new Error(`SameBoy could not restore battery data (${result})`);
      }
    });
  }

  clearBatteryDirty(): void {
    this.assertAlive();
    this.#exports.clearBatteryDirty(this.#handle);
  }

  private assertAlive(): void {
    if (this.#handle === 0) {
      throw new Error("SameBoy machine has been destroyed");
    }
  }
}

function createImports(getMemory: () => WebAssembly.Memory | null): WebAssembly.Imports {
  const clockTimeGet = (_clockId: number, _precision: bigint, resultPointer: number): number => {
    const memory = getMemory();
    if (!memory) {
      return 21;
    }
    new DataView(memory.buffer).setBigUint64(resultPointer, BigInt(Date.now()) * 1_000_000n, true);
    return 0;
  };

  return {
    env: {
      abort: () => {
        throw new Error("SameBoy Wasm aborted");
      },
      emscripten_date_now: () => Date.now(),
      emscripten_get_now: () => performance.now(),
      emscripten_notify_memory_growth: () => undefined,
    },
    wasi_snapshot_preview1: {
      clock_time_get: clockTimeGet,
      fd_close: () => 8,
      fd_fdstat_get: () => 8,
      fd_seek: () => 8,
      fd_write: () => 8,
      proc_exit: (code: number) => {
        throw new Error(`SameBoy Wasm exited (${code})`);
      },
    },
  };
}

function resolveExports(raw: WebAssembly.Exports): SameBoyExports {
  const memory = raw.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("SameBoy Wasm does not export linear memory");
  }

  return {
    memory,
    initialize: requiredFunction(raw, "_initialize"),
    malloc: requiredFunction(raw, "malloc", "_malloc"),
    free: requiredFunction(raw, "free", "_free"),
    create: requiredFunction(raw, "db_create", "_db_create"),
    destroy: requiredFunction(raw, "db_destroy", "_db_destroy"),
    loadRom: requiredFunction(raw, "db_load_rom", "_db_load_rom"),
    setButtons: requiredFunction(raw, "db_set_buttons", "_db_set_buttons"),
    runFrame: requiredFunction(raw, "db_run_frame", "_db_run_frame"),
    framebuffer: requiredFunction(raw, "db_framebuffer", "_db_framebuffer"),
    framebufferSize: requiredFunction(raw, "db_framebuffer_size", "_db_framebuffer_size"),
    stateSize: requiredFunction(raw, "db_state_size", "_db_state_size"),
    saveState: requiredFunction(raw, "db_save_state", "_db_save_state"),
    loadState: requiredFunction(raw, "db_load_state", "_db_load_state"),
    stateHash: requiredFunction(raw, "db_state_hash", "_db_state_hash"),
    batterySize: requiredFunction(raw, "db_battery_size", "_db_battery_size"),
    saveBattery: requiredFunction(raw, "db_save_battery", "_db_save_battery"),
    loadBattery: requiredFunction(raw, "db_load_battery", "_db_load_battery"),
    batteryDirty: requiredFunction(raw, "db_battery_dirty", "_db_battery_dirty"),
    clearBatteryDirty: requiredFunction(raw, "db_clear_battery_dirty", "_db_clear_battery_dirty"),
  };
}

function requiredFunction<T extends Function>(exports: WebAssembly.Exports, ...names: string[]): T {
  const fn = optionalFunction<T>(exports, ...names);
  if (!fn) {
    throw new Error(`SameBoy Wasm is missing export ${names[0]}`);
  }
  return fn;
}

function optionalFunction<T extends Function>(
  exports: WebAssembly.Exports,
  ...names: string[]
): T | undefined {
  for (const name of names) {
    const candidate = exports[name];
    if (typeof candidate === "function") {
      return candidate as T;
    }
  }
  return undefined;
}

function withInput<T>(
  exports: SameBoyExports,
  bytes: Uint8Array,
  operation: (pointer: number, length: number) => T,
): T {
  const pointer = exports.malloc(bytes.byteLength || 1);
  if (pointer === 0) {
    throw new Error("SameBoy Wasm allocation failed");
  }

  try {
    new Uint8Array(exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
    return operation(pointer, bytes.byteLength);
  } finally {
    exports.free(pointer);
  }
}

function withOutput(
  exports: SameBoyExports,
  size: number,
  operation: (pointer: number) => void,
): Uint8Array {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`SameBoy requested an invalid buffer (${size} bytes)`);
  }
  const pointer = exports.malloc(size);
  if (pointer === 0) {
    throw new Error("SameBoy Wasm allocation failed");
  }

  try {
    operation(pointer);
    return new Uint8Array(exports.memory.buffer, pointer, size).slice();
  } finally {
    exports.free(pointer);
  }
}
