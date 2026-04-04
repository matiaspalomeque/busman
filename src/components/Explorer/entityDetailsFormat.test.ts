import { describe, expect, it } from "vitest";
import { formatDuration } from "./entityDetailsFormat";

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
