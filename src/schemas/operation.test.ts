import { describe, expect, it } from "vitest";
import fixture from "../../contracts/operation-outcome.json";
import { OperationOutcomeSchema } from "./operation";

describe("operation outcome contract", () => {
  it("preserves partial counts and the unknown status across the shared fixture", () => {
    const result = OperationOutcomeSchema.parse(fixture);
    expect(result.status).toBe("unknown");
    expect(result.counts.sent).toBe(5);
    expect(result.counts.sources.dlq.settlementUnconfirmed).toBe(1);
  });
  it("rejects a version mismatch and imprecise or negative counts", () => {
    expect(OperationOutcomeSchema.safeParse({ ...fixture, version: 2 }).success).toBe(false);
    for (const sent of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(OperationOutcomeSchema.safeParse({ ...fixture, counts: { ...fixture.counts, sent } }).success).toBe(false);
    }
  });
});
