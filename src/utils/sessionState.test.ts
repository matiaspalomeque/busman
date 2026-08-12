import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_STATE_BASE64_BYTES,
  sessionStateBase64ByteLength,
} from "./sessionState";

describe("sessionStateBase64ByteLength", () => {
  it.each([
    ["", 0],
    ["AA==", 1],
    ["AAA=", 2],
    ["AAAA", 3],
    ["AP+A", 3],
  ])("accepts canonical standard base64 %j", (value, expectedLength) => {
    expect(sessionStateBase64ByteLength(value)).toBe(expectedLength);
  });

  it.each([
    "AB==",
    "AAB=",
    "AA",
    "A===",
    "_w==",
    " AA==",
    "AA==\n",
  ])("rejects malformed or noncanonical standard base64 %j", (value) => {
    expect(sessionStateBase64ByteLength(value)).toBeNull();
  });

  it("rejects a canonical encoding whose decoded payload exceeds the limit", () => {
    const oversized = "A".repeat(MAX_SESSION_STATE_BASE64_BYTES);
    expect(sessionStateBase64ByteLength(oversized)).toBeNull();
  });
});
