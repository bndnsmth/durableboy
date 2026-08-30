import { describe, expect, it } from "vite-plus/test";
import { inspectRom, sha256Hex } from "../src/shared/rom";

function rom(title: string, cgbFlag = 0): Uint8Array {
  const bytes = new Uint8Array(0x8000);
  bytes.set(new TextEncoder().encode(title), 0x134);
  bytes[0x143] = cgbFlag;
  return bytes;
}

describe("ROM inspection", () => {
  it("reads title and DMG compatibility from the cartridge header", () => {
    expect(inspectRom(rom("TETRIS"))).toEqual({
      title: "TETRIS",
      suggestedModel: "DMG",
      byteLength: 0x8000,
    });
  });

  it("detects CGB cartridges", () => {
    expect(inspectRom(rom("COLOR TEST", 0xc0)).suggestedModel).toBe("CGB");
  });

  it("rejects truncated input", () => {
    expect(() => inspectRom(new Uint8Array(32))).toThrow(/too small/i);
  });

  it("hashes exactly the supplied bytes", async () => {
    expect(await sha256Hex(new TextEncoder().encode("durableboy"))).toBe(
      "d52dc60bcd30d5776e9e0ad9db08f25a29becf09f63cacaa25d0fe77897da5bc",
    );
  });
});
