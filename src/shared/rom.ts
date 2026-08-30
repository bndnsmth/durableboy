import type { ConsoleModel } from "./protocol";

export const MAX_ROM_BYTES = 8 * 1024 * 1024;
const ROM_HEADER_BYTES = 0x150;
const TITLE_START = 0x134;
const TITLE_END = 0x144;
const CGB_FLAG = 0x143;

export interface RomMetadata {
  title: string;
  suggestedModel: ConsoleModel;
  byteLength: number;
}

export function inspectRom(bytes: Uint8Array): RomMetadata {
  if (bytes.byteLength < ROM_HEADER_BYTES) {
    throw new Error("The file is too small to contain a Game Boy ROM header");
  }
  if (bytes.byteLength > MAX_ROM_BYTES) {
    throw new Error("ROM exceeds the 8 MiB proof-of-concept limit");
  }

  const titleBytes = bytes.subarray(TITLE_START, TITLE_END);
  const terminator = titleBytes.indexOf(0);
  const title = new TextDecoder("ascii")
    .decode(terminator === -1 ? titleBytes : titleBytes.subarray(0, terminator))
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
  const cgbFlag = bytes[CGB_FLAG] ?? 0;

  return {
    title: title || "UNTITLED CARTRIDGE",
    suggestedModel: cgbFlag === 0x80 || cgbFlag === 0xc0 ? "CGB" : "DMG",
    byteLength: bytes.byteLength,
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
