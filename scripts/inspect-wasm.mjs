import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? "src/emulator/sameboy.wasm");
const bytes = await readFile(path);
const module = await WebAssembly.compile(bytes);
const imports = WebAssembly.Module.imports(module);
const exports = WebAssembly.Module.exports(module);
const allowedImports = new Set([
  "env.abort",
  "env.emscripten_date_now",
  "env.emscripten_get_now",
  "env.emscripten_notify_memory_growth",
  "wasi_snapshot_preview1.clock_time_get",
  "wasi_snapshot_preview1.fd_close",
  "wasi_snapshot_preview1.fd_fdstat_get",
  "wasi_snapshot_preview1.fd_seek",
  "wasi_snapshot_preview1.fd_write",
  "wasi_snapshot_preview1.proc_exit",
]);

console.log(`Wasm: ${path}`);
console.log(`Bytes: ${bytes.byteLength.toLocaleString()}`);
console.log("Imports:");
for (const entry of imports) {
  console.log(`  ${entry.module}.${entry.name} (${entry.kind})`);
}
console.log("Exports:");
for (const entry of exports) {
  console.log(`  ${entry.name} (${entry.kind})`);
}

if (!exports.some((entry) => entry.name === "memory")) {
  throw new Error("The Wasm module must export memory");
}

const unsupported = imports.filter((entry) => !allowedImports.has(`${entry.module}.${entry.name}`));
if (unsupported.length > 0) {
  throw new Error(
    `Unsupported Wasm imports: ${unsupported
      .map((entry) => `${entry.module}.${entry.name}`)
      .join(", ")}`,
  );
}

const requiredExports = [
  "memory",
  "_initialize",
  "db_create",
  "db_destroy",
  "db_load_rom",
  "db_run_frame",
  "db_framebuffer",
  "db_save_state",
  "db_load_state",
];
const exportNames = new Set(exports.map((entry) => entry.name));
const missing = requiredExports.filter(
  (name) => !exportNames.has(name) && !exportNames.has(`_${name}`),
);
if (missing.length > 0) {
  throw new Error(`Missing Wasm exports: ${missing.join(", ")}`);
}
