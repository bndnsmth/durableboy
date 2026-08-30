import { describe, expect, it } from "vite-plus/test";
import {
  decodeFrame,
  encodeFrame,
  FrameFormat,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  parseClientMessage,
  unpackFrameRgba,
} from "../src/shared/protocol";

describe("WebSocket protocol", () => {
  it("validates controller commands", () => {
    expect(parseClientMessage('{"type":"advance"}')).toEqual({
      type: "advance",
      frames: 1,
    });
    expect(parseClientMessage('{"type":"input","buttons":255}')).toEqual({
      type: "input",
      buttons: 255,
    });
    expect(() => parseClientMessage('{"type":"advance","frames":5}')).toThrow();
    expect(() => parseClientMessage('{"type":"input","buttons":-1}')).toThrow();
  });

  it("packs a DMG framebuffer into two bits per pixel", () => {
    const rgba = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
    for (let pixel = 0; pixel < FRAME_WIDTH * FRAME_HEIGHT; pixel += 1) {
      const shade = (pixel % 4) * 85;
      const offset = pixel * 4;
      rgba[offset] = shade;
      rgba[offset + 1] = shade;
      rgba[offset + 2] = shade;
      rgba[offset + 3] = 255;
    }

    const decoded = decodeFrame(encodeFrame(rgba, "DMG", 42n, 70_224n));
    expect(decoded.format).toBe(FrameFormat.Dmg2Bit);
    expect(decoded.pixels).toHaveLength((FRAME_WIDTH * FRAME_HEIGHT) / 4);
    expect(decoded.frame).toBe(42n);
    expect(decoded.ticks).toBe(70_224n);
    expect(unpackFrameRgba(decoded)).toHaveLength(FRAME_WIDTH * FRAME_HEIGHT * 4);
  });

  it("packs CGB frames as little-endian RGB565", () => {
    const rgba = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
    rgba.set([255, 128, 0, 255], 0);
    const decoded = decodeFrame(encodeFrame(rgba, "CGB", 1n, 2n));
    expect(decoded.format).toBe(FrameFormat.Rgb565);
    expect(decoded.pixels).toHaveLength(FRAME_WIDTH * FRAME_HEIGHT * 2);
    expect(decoded.pixels[0]).toBe(0);
    expect(decoded.pixels[1]).toBe(252);
    expect(Array.from(unpackFrameRgba(decoded).subarray(0, 4))).toEqual([255, 130, 0, 255]);
  });

  it("rejects malformed frame payloads", () => {
    const rgba = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
    const encoded = encodeFrame(rgba, "DMG", 1n, 2n);
    expect(() => decodeFrame(encoded.slice(0, -1))).toThrow(/length/i);
  });
});
