import { describe, expect, it } from "vite-plus/test";
import { createConsoleId, isConsoleId } from "../src/shared/id";

describe("console IDs", () => {
  it("creates sortable Crockford-base32 identifiers", () => {
    const id = createConsoleId(1_788_048_000_000);
    expect(id).toHaveLength(29);
    expect(isConsoleId(id)).toBe(true);
    expect(id.startsWith("gb_")).toBe(true);
  });

  it("rejects ambiguous and malformed characters", () => {
    expect(isConsoleId(`gb_${"0".repeat(26)}`)).toBe(true);
    expect(isConsoleId(`gb_${"O".repeat(26)}`)).toBe(false);
    expect(isConsoleId("console-123")).toBe(false);
  });
});
