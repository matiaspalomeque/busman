import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOURNAL_KEY, JOURNAL_RETENTION_MS, journalMetadata, loadOperationJournal, saveOperationJournal } from "./operationJournal";
import type { EventLogEntry } from "../types";

const entry = (): EventLogEntry => ({ id: "run-1", time: new Date().toISOString(), namespace: "demo", entity: "orders", entityType: "Queue", operation: "Move", status: "running" });
beforeEach(() => { localStorage.clear(); });

describe("operation journal", () => {
  it("allows an interrupted non-destructive browse to be retried without broker reconciliation", () => {
    saveOperationJournal([{ ...entry(), operation: "Browse" }]);
    expect(loadOperationJournal().entries[0]).toMatchObject({ status: "error", errorMessage: expect.stringContaining("Retry the read") });
  });
  it("recovers interrupted work as unknown, never success or stopped", () => {
    saveOperationJournal([{ ...entry(), checkpoint: { at: new Date().toISOString(), counts: { sent: 10, settled: 9, sendUnconfirmed: 0, settlementUnconfirmed: 1, sources: {} } } }]);
    const loaded = loadOperationJournal();
    expect(loaded.error).toBeNull();
    expect(loaded.entries[0].status).toBe("unknown");
    expect(loaded.entries[0].errorMessage).toContain("Reconcile");
    expect(loaded.entries[0].checkpoint?.counts).toMatchObject({ sent: 10, settled: 9, settlementUnconfirmed: 1 });
  });
  it("persists only metadata, including inside terminal outcomes", () => {
    const value = { ...entry(), errorMessage: "secret payload", body: "private", connectionString: "secret", outcome: {
      version: 1, runId: "run-1", status: "unknown", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      counts: { sent: 3, settled: 2, sendUnconfirmed: 0, settlementUnconfirmed: 1, sources: {} }, errorMessage: "secret payload", errorCode: "broker_acknowledgment_unknown",
    } };
    saveOperationJournal([value as EventLogEntry]);
    const raw = localStorage.getItem(JOURNAL_KEY)!;
    expect(raw).not.toMatch(/secret|private|errorMessage|connectionString|body/);
    expect(loadOperationJournal().entries[0].outcome?.counts.settled).toBe(2);
  });
  it("bounds retention and entry count", () => {
    const old = { ...entry(), time: new Date(Date.now() - JOURNAL_RETENTION_MS - 1).toISOString() };
    expect(journalMetadata([old])).toHaveLength(0);
    expect(journalMetadata(Array.from({ length: 600 }, (_, id) => ({ ...entry(), id: String(id) })))).toHaveLength(500);
  });
  it("reports corrupted data and storage failure", () => {
    localStorage.setItem(JOURNAL_KEY, "{invalid");
    expect(loadOperationJournal().error).toBeTruthy();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(saveOperationJournal([entry()])).toContain("Export");
    spy.mockRestore();
  });
});
