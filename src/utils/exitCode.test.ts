import { describe, it, expect } from "vitest";
import { exitCodeToStatus, STOP_EXIT_CODE } from "./exitCode";

describe("exitCodeToStatus", () => {
  it("returns 'success' for exit code 0", () => {
    expect(exitCodeToStatus(0)).toBe("success");
  });

  it("returns 'stopped' for the SIGINT exit code (130)", () => {
    expect(exitCodeToStatus(STOP_EXIT_CODE)).toBe("stopped");
    expect(exitCodeToStatus(130)).toBe("stopped");
  });

  it("returns 'error' for any other exit code", () => {
    expect(exitCodeToStatus(1)).toBe("error");
    expect(exitCodeToStatus(-1)).toBe("error");
    expect(exitCodeToStatus(2)).toBe("error");
    expect(exitCodeToStatus(255)).toBe("error");
  });
});
