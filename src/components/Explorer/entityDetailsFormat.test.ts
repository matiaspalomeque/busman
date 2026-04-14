import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatTimestamp } from "./entityDetailsFormat";

describe("entityDetailsFormat", () => {
  it("formats regular ISO durations into compact labels", () => {
    expect(formatDuration("P14D")).toBe("14d");
    expect(formatDuration("PT1M")).toBe("1m");
    expect(formatDuration("PT1H30M5.5S")).toBe("1h 30m 5.5s");
  });

  it("maps the .NET max timespan sentinel to a never label", () => {
    expect(formatDuration("P10675199DT2H48M5.4775807S")).toBe("Never");
    expect(formatDuration("10675199.02:48:05.4775807", "Nunca")).toBe("Nunca");
  });

  it("returns an em dash for empty values", () => {
    expect(formatDuration(null)).toBe("\u2014");
    expect(formatDuration(undefined)).toBe("\u2014");
  });
});

describe("formatBytes", () => {
  it("returns '0 B' for zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes without decimals", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats kilobytes with one decimal place", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats megabytes with one decimal place", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });

  it("formats gigabytes and terabytes", () => {
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });
});

describe("formatTimestamp", () => {
  it("returns an em dash for null, undefined, and empty string", () => {
    expect(formatTimestamp(null)).toBe("\u2014");
    expect(formatTimestamp(undefined)).toBe("\u2014");
    expect(formatTimestamp("")).toBe("\u2014");
  });

  it("returns a non-empty string for a valid ISO timestamp", () => {
    const result = formatTimestamp("2024-06-15T10:30:00.000Z");
    expect(result).toBeTruthy();
    expect(result).not.toBe("\u2014");
  });

  it("returns a non-empty string for an invalid date (V8 does not throw — returns 'Invalid Date')", () => {
    // In Node.js/V8, new Date("not-a-date").toLocaleString() returns "Invalid Date"
    // rather than throwing, so the catch branch is not exercised in this environment.
    const result = formatTimestamp("not-a-date");
    expect(result).toBeTruthy();
    expect(result).not.toBe("\u2014");
  });
});
