import { describe, expect, it } from "vitest";
import {
  compareSequenceNumbers,
  incrementSequenceNumber,
  isCanonicalSequenceNumber,
  MAX_SEQUENCE_NUMBER,
  normalizeSequenceNumber,
} from "./sequenceNumber";

describe("sequence numbers", () => {
  it("preserves exact signed-64-bit decimal strings", () => {
    for (const value of ["0", "9007199254740993", "9288674231451771", MAX_SEQUENCE_NUMBER]) {
      expect(normalizeSequenceNumber(value)).toBe(value);
      expect(isCanonicalSequenceNumber(value)).toBe(true);
    }
  });

  it("accepts only safe legacy numeric payloads", () => {
    expect(normalizeSequenceNumber(42)).toBe("42");
    expect(normalizeSequenceNumber(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(() => normalizeSequenceNumber(Number.MAX_SAFE_INTEGER + 1)).toThrow(/exact/);
    expect(() => normalizeSequenceNumber(1.5)).toThrow(/exact/);
  });

  it("rejects non-canonical and out-of-range strings", () => {
    for (const value of ["", "-1", "+1", "01", " 1", "1 ", "1.0", "9223372036854775808"]) {
      expect(() => normalizeSequenceNumber(value)).toThrow();
      expect(isCanonicalSequenceNumber(value)).toBe(false);
    }
  });

  it("compares and increments beyond JavaScript's safe integer range", () => {
    expect(compareSequenceNumbers("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareSequenceNumbers("9288674231451771", "9007199254740993")).toBe(1);
    expect(incrementSequenceNumber("9007199254740993")).toBe("9007199254740994");
    expect(incrementSequenceNumber(MAX_SEQUENCE_NUMBER)).toBeNull();
  });
});
