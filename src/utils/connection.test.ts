import { describe, it, expect } from "vitest";
import { extractNamespace } from "./connection";

describe("extractNamespace", () => {
  it("extracts the namespace hostname from a standard connection string", () => {
    const cs =
      "Endpoint=sb://my-namespace.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=abc=";
    expect(extractNamespace(cs)).toBe("my-namespace.servicebus.windows.net");
  });

  it("is case-insensitive for the Endpoint prefix", () => {
    const cs = "endpoint=sb://case-test.servicebus.windows.net/;Key=val";
    expect(extractNamespace(cs)).toBe("case-test.servicebus.windows.net");
  });

  it("returns the original string when no Endpoint is found", () => {
    expect(extractNamespace("not-a-connection-string")).toBe("not-a-connection-string");
  });

  it("returns an empty string for empty input", () => {
    expect(extractNamespace("")).toBe("");
  });
});
