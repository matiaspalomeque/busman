import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./appStore";
import { loadOperationJournal, saveOperationJournal } from "./operationJournal";
import { REPLAY_RUN_ID_PROPERTY, replaySourceKey } from "../utils/messageOperation";
import type { EventLogEntry, PeekedMessage } from "../types";

const returnedMessage = (runId = "resend-1"): PeekedMessage => ({
  messageId: "new-id-after-duplicate-detection", sequenceNumber: "9007199254740993", body: "body",
  subject: null, contentType: null, correlationId: null, partitionKey: null, traceParent: null,
  enqueuedTimeUtc: null, expiresAtUtc: null, _source: "Dead Letter Queue: orders", sourceSubQueue: "deadLetter",
  applicationProperties: { [REPLAY_RUN_ID_PROPERTY]: runId },
});
const entry = (id = "resend-1"): EventLogEntry => ({
  id, time: new Date().toISOString(), namespace: "test", entity: "orders #1", entityType: "Queue",
  operation: "ReplayMessage", status: "success",
  scope: { connectionId: "conn", mode: "dlq", destination: "orders", replaySource: replaySourceKey({ kind: "queue", queueName: "orders", topicName: null, subscriptionName: null }) },
});

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.getState().setActiveConnectionId("conn");
  useAppStore.getState().setExplorerQueue("orders");
  useAppStore.getState().addEventLogEntry(entry());
});

describe("resend return detection", () => {
  it.each(["setPeekResults", "appendPeekResults"] as const)("detects a changed message ID through %s, preserving send success", (action) => {
    useAppStore.getState()[action]([returnedMessage()]);
    const observed = useAppStore.getState().eventLog[0];
    expect(observed.status).toBe("success");
    expect(observed.replayReturn).toEqual({ observedAt: expect.any(String), sequenceNumber: "9007199254740993" });
    useAppStore.getState().setPeekResults([returnedMessage()]);
    expect(useAppStore.getState().eventLog[0].replayReturn).toEqual(observed.replayReturn);
  });

  it("only attributes a return to the exact resend attempt", () => {
    useAppStore.getState().addEventLogEntry(entry("resend-2"));
    useAppStore.getState().setPeekResults([returnedMessage("resend-2")]);
    const entries = useAppStore.getState().eventLog;
    expect(entries.find((value) => value.id === "resend-2")?.replayReturn).toBeTruthy();
    expect(entries.find((value) => value.id === "resend-1")?.replayReturn).toBeUndefined();
  });

  it.each(["connection", "queue", "subscription", "active", "unmarked", "unknown-run", "failed-operation"])("does not misattribute %s messages", (scenario) => {
    const state = useAppStore.getState();
    const message = returnedMessage();
    if (scenario === "connection") state.setActiveConnectionId("other");
    if (scenario === "queue") state.setExplorerQueue("billing");
    if (scenario === "subscription") state.setExplorerSubscription("orders", "worker");
    if (scenario === "active") message.sourceSubQueue = "active";
    if (scenario === "unmarked") message.applicationProperties = null;
    if (scenario === "unknown-run") message.applicationProperties = { [REPLAY_RUN_ID_PROPERTY]: "unknown" };
    if (scenario === "failed-operation") state.updateEventLogEntry("resend-1", "unknown");
    state.setPeekResults([message]);
    expect(useAppStore.getState().eventLog[0].replayReturn).toBeUndefined();
  });

  it("handles a return observed before the resend completion arrives", () => {
    const state = useAppStore.getState();
    useAppStore.setState({ eventLog: [{ ...entry(), status: "running" }] });
    state.setPeekResults([returnedMessage()]);
    expect(useAppStore.getState().eventLog[0].replayReturn).toBeUndefined();
    state.updateEventLogEntry("resend-1", "success");
    expect(useAppStore.getState().eventLog[0].replayReturn).toBeTruthy();
  });

  it("recognizes subscription returns only in the original subscription", () => {
    const state = useAppStore.getState();
    state.setExplorerSubscription("events", "worker");
    state.recordOperationScope("resend-1", { connectionId: "conn", mode: "dlq", destination: "events",
      replaySource: replaySourceKey(useAppStore.getState().explorerSelection) });
    state.setPeekResults([returnedMessage()]);
    expect(useAppStore.getState().eventLog[0].replayReturn).toBeTruthy();
  });

  it("retains only observation metadata across restart", () => {
    const state = useAppStore.getState();
    state.setPeekResults([returnedMessage()]);
    saveOperationJournal(useAppStore.getState().eventLog);
    const loaded = loadOperationJournal();
    expect(loaded.entries[0].replayReturn).toEqual(useAppStore.getState().eventLog[0].replayReturn);
    expect(loaded.entries[0].scope?.replaySource).toBe(entry().scope?.replaySource);
    expect(JSON.stringify(loaded.entries)).not.toContain("body");
  });
});
