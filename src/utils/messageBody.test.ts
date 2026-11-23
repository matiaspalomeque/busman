import { describe, expect, it } from "vitest";
import { formatBodyJson } from "./messageBody";

describe("formatBodyJson", () => {
  it("only changes whitespace outside literals, including duplicate fields and escapes", () => {
    const input = String.raw`{"x":[{},[],1.0e-3,-0],"x":"a\",}:\\b\u0020 "}`;
    expect(formatBodyJson(input)).toBe([
      "{", '  "x": [', "    {},", "    [],", "    1.0e-3,", "    -0", "  ],",
      String.raw`  "x": "a\",}:\\b\u0020 "`, "}",
    ].join("\n"));
    expect(formatBodyJson(" invalid  {")).toBe(" invalid  {");
  });

  it("keeps a large string literal intact while formatting its containing object", () => {
    const literal = '"'.padEnd(4_000_001, "a") + '"';
    expect(formatBodyJson(`{"value":${literal}}`)).toBe(`{\n  "value": ${literal}\n}`);
  });
});
