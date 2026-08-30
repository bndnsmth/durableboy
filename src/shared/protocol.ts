export const FRAME_WIDTH = 160;
export const FRAME_HEIGHT = 144;
export const FRAME_HEADER_BYTES = 24;
export const FRAME_MAGIC = "DBF1";

export const enum FrameFormat {
  Rgba8888 = 1,
  Dmg2Bit = 2,
  Rgb565 = 3,
}

export const enum Button {
  Right = 1 << 0,
  Left = 1 << 1,
  Up = 1 << 2,
  Down = 1 << 3,
  A = 1 << 4,
  B = 1 << 5,
  Select = 1 << 6,
  Start = 1 << 7,
}

export type ConsoleModel = "DMG" | "CGB";

export type ConsoleLifecycle =
  | "empty"
  | "loading"
  | "running"
  | "paused"
  | "checkpointing"
  | "sleeping"
  | "linked"
  | "deleting"
  | "faulted";

export interface ConsoleStatus {
  id: string;
  model: ConsoleModel;
  lifecycle: ConsoleLifecycle;
  cartridge: {
    id: string;
    hash: string;
    title: string;
  } | null;
  frame: string;
  ticks: string;
  checkpointHash: string | null;
  connectedClients: number;
  hasController: boolean;
  telemetry: {
    framesRun: string;
    chunksRun: number;
    emulatedSeconds: number;
    observedWallMs: number;
    wasmMemoryBytes: number;
    lastStateBytes: number;
  };
}

export type ClientMessage =
  | { type: "advance"; frames?: number }
  | { type: "input"; buttons: number }
  | { type: "checkpoint" }
  | { type: "pause" };

export type ServerMessage =
  | {
      type: "hello";
      role: "player" | "spectator";
      status: ConsoleStatus;
    }
  | { type: "status"; status: ConsoleStatus }
  | {
      type: "role";
      role: "player" | "spectator";
      status: ConsoleStatus;
    }
  | { type: "checkpointed"; status: ConsoleStatus }
  | { type: "error"; code: string; message: string };

export interface DecodedFrame {
  format: FrameFormat;
  width: number;
  height: number;
  frame: bigint;
  ticks: bigint;
  pixels: Uint8Array;
}

export function parseClientMessage(value: string): ClientMessage {
  if (value.length > 1_024) {
    throw new Error("Message is too large");
  }

  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("Invalid message");
  }

  switch (parsed.type) {
    case "advance": {
      const frames = parsed.frames === undefined ? 1 : parsed.frames;
      if (typeof frames !== "number") {
        throw new Error("frames must be an integer from 1 to 4");
      }
      if (!Number.isInteger(frames) || frames < 1 || frames > 4) {
        throw new Error("frames must be an integer from 1 to 4");
      }
      return { type: "advance", frames };
    }
    case "input": {
      const buttons = parsed.buttons;
      if (
        typeof buttons !== "number" ||
        !Number.isInteger(buttons) ||
        buttons < 0 ||
        buttons > 0xff
      ) {
        throw new Error("buttons must be an unsigned byte");
      }
      return { type: "input", buttons };
    }
    case "checkpoint":
    case "pause":
      return { type: parsed.type };
    default:
      throw new Error("Unknown message type");
  }
}

export function encodeFrame(
  rgba: Uint8Array,
  model: ConsoleModel,
  frame: bigint,
  ticks: bigint,
): ArrayBuffer {
  const format = model === "DMG" ? FrameFormat.Dmg2Bit : FrameFormat.Rgb565;
  const payload = format === FrameFormat.Dmg2Bit ? packDmgPixels(rgba) : packRgb565(rgba);
  const output = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  output.set(new TextEncoder().encode(FRAME_MAGIC), 0);
  output[4] = format;
  output[5] = FRAME_WIDTH;
  output[6] = FRAME_HEIGHT;
  const view = new DataView(output.buffer);
  view.setBigUint64(8, frame, true);
  view.setBigUint64(16, ticks, true);
  output.set(payload, FRAME_HEADER_BYTES);
  return output.buffer;
}

export function decodeFrame(buffer: ArrayBuffer): DecodedFrame {
  if (buffer.byteLength < FRAME_HEADER_BYTES) {
    throw new Error("Frame is truncated");
  }

  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== FRAME_MAGIC) {
    throw new Error("Unknown frame format");
  }

  const format = bytes[4] as FrameFormat;
  if (
    format !== FrameFormat.Rgba8888 &&
    format !== FrameFormat.Dmg2Bit &&
    format !== FrameFormat.Rgb565
  ) {
    throw new Error("Unsupported pixel format");
  }

  const width = bytes[5] ?? 0;
  const height = bytes[6] ?? 0;
  if (width !== FRAME_WIDTH || height !== FRAME_HEIGHT) {
    throw new Error("Unexpected frame dimensions");
  }
  const expectedPayloadBytes =
    format === FrameFormat.Rgba8888
      ? width * height * 4
      : format === FrameFormat.Rgb565
        ? width * height * 2
        : (width * height) / 4;
  if (buffer.byteLength !== FRAME_HEADER_BYTES + expectedPayloadBytes) {
    throw new Error("Frame payload has an invalid length");
  }

  const view = new DataView(buffer);
  return {
    format,
    width,
    height,
    frame: view.getBigUint64(8, true),
    ticks: view.getBigUint64(16, true),
    pixels: bytes.subarray(FRAME_HEADER_BYTES),
  };
}

export function unpackFrameRgba(frame: DecodedFrame): Uint8ClampedArray {
  if (frame.format === FrameFormat.Rgba8888) {
    return new Uint8ClampedArray(
      frame.pixels.buffer.slice(
        frame.pixels.byteOffset,
        frame.pixels.byteOffset + frame.pixels.byteLength,
      ),
    );
  }

  if (frame.format === FrameFormat.Rgb565) {
    const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
    const view = new DataView(
      frame.pixels.buffer,
      frame.pixels.byteOffset,
      frame.pixels.byteLength,
    );
    for (let pixel = 0; pixel < frame.width * frame.height; pixel += 1) {
      const packed = view.getUint16(pixel * 2, true);
      const offset = pixel * 4;
      rgba[offset] = Math.round(((packed >> 11) & 0x1f) * (255 / 31));
      rgba[offset + 1] = Math.round(((packed >> 5) & 0x3f) * (255 / 63));
      rgba[offset + 2] = Math.round((packed & 0x1f) * (255 / 31));
      rgba[offset + 3] = 0xff;
    }
    return rgba;
  }

  const palette = [
    [224, 248, 208],
    [136, 192, 112],
    [52, 104, 86],
    [8, 24, 32],
  ] as const;
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);

  for (let pixel = 0; pixel < frame.width * frame.height; pixel += 1) {
    const packed = frame.pixels[pixel >> 2] ?? 0;
    const shade = (packed >> ((3 - (pixel & 3)) * 2)) & 0x03;
    const color = palette[shade] ?? palette[0];
    const offset = pixel * 4;
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = 0xff;
  }

  return rgba;
}

function packRgb565(rgba: Uint8Array): Uint8Array {
  const pixelCount = FRAME_WIDTH * FRAME_HEIGHT;
  if (rgba.byteLength < pixelCount * 4) {
    throw new Error("RGBA framebuffer is truncated");
  }

  const packed = new Uint8Array(pixelCount * 2);
  const view = new DataView(packed.buffer);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const red = (rgba[offset] ?? 0) >> 3;
    const green = (rgba[offset + 1] ?? 0) >> 2;
    const blue = (rgba[offset + 2] ?? 0) >> 3;
    view.setUint16(pixel * 2, (red << 11) | (green << 5) | blue, true);
  }
  return packed;
}

function packDmgPixels(rgba: Uint8Array): Uint8Array {
  const pixelCount = FRAME_WIDTH * FRAME_HEIGHT;
  if (rgba.byteLength < pixelCount * 4) {
    throw new Error("RGBA framebuffer is truncated");
  }

  const packed = new Uint8Array(pixelCount / 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const luminance =
      (77 * (rgba[offset] ?? 0) + 150 * (rgba[offset + 1] ?? 0) + 29 * (rgba[offset + 2] ?? 0)) >>
      8;
    const shade = 3 - Math.min(3, luminance >> 6);
    const packedIndex = pixel >> 2;
    packed[packedIndex] = (packed[packedIndex] ?? 0) | (shade << ((3 - (pixel & 3)) * 2));
  }
  return packed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
