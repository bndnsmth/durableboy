import type { ConsoleModel } from "../shared/protocol";

export interface Emulator {
  readonly model: ConsoleModel;
  readonly memoryBytes: number;

  destroy(): void;
  setButtons(buttons: number): void;
  runFrame(): bigint;
  framebuffer(): Uint8Array;
  saveState(): Uint8Array;
  loadState(state: Uint8Array): void;
  stateHash(): string;
  batteryDirty(): boolean;
  saveBattery(): Uint8Array | null;
  loadBattery(battery: Uint8Array): void;
  clearBatteryDirty(): void;
}
