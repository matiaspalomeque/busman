import { describe, it, expect } from "vitest";
import { safeColor } from "./color";

describe("safeColor", () => {
  it("accepts valid 3-digit hex colors", () => {
    expect(safeColor("#abc")).toBe("#abc");
    expect(safeColor("#FFF")).toBe("#FFF");
    expect(safeColor("#0A1")).toBe("#0A1");
  });

  it("accepts valid 6-digit hex colors", () => {
    expect(safeColor("#aabbcc")).toBe("#aabbcc");
    expect(safeColor("#FFFFFF")).toBe("#FFFFFF");
    expect(safeColor("#123456")).toBe("#123456");
  });

  it("rejects values without a hash prefix", () => {
    expect(safeColor("red")).toBeUndefined();
    expect(safeColor("aabbcc")).toBeUndefined();
  });

  it("rejects values with an incorrect digit count", () => {
    expect(safeColor("#1")).toBeUndefined();
    expect(safeColor("#12")).toBeUndefined();
    expect(safeColor("#1234")).toBeUndefined();
    expect(safeColor("#12345")).toBeUndefined();
    expect(safeColor("#1234567")).toBeUndefined();
  });

  it("rejects values with non-hex characters", () => {
    expect(safeColor("#gggggg")).toBeUndefined();
    expect(safeColor("#xyz")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(safeColor("")).toBeUndefined();
  });

  it("returns undefined when input is undefined", () => {
    expect(safeColor(undefined)).toBeUndefined();
  });
});
