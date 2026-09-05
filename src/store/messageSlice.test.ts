import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./appStore";
import { MAX_LOADED_BYTES, MAX_LOADED_MESSAGES, fitMessages, messageBytes } from "./messageSlice";
import { filterMessages } from "../utils/messageSearch";
import type { PeekedMessage } from "../types";

const message = (id: number): PeekedMessage => ({ messageId: String(id), sequenceNumber: String(id), body: { status: "Retry" },
  subject: null, contentType: null, correlationId: null, partitionKey: null, traceParent: null, applicationProperties: null,
  enqueuedTimeUtc: null, expiresAtUtc: null, sourceSubQueue: "deadLetter", _source: "Dead Letter Queue: orders" });
beforeEach(() => { useAppStore.setState(useAppStore.getInitialState()); });
describe("loaded messages", () => {
  it("retains a bounded prefix and never advances the cursor past omitted results", () => {
    const messages = Array.from({ length: MAX_LOADED_MESSAGES + 1 }, (_, index) => message(index + 1));
    useAppStore.getState().setPeekResults(messages);
    const state = useAppStore.getState();
    expect(state.peekMessages).toHaveLength(MAX_LOADED_MESSAGES);
    expect(state.lastPeekDlqMaxSeqNum).toBe(String(MAX_LOADED_MESSAGES));
    expect(state.messageBudgetReached).toBe(true);
  });
  it("enforces the byte budget before appending and releases results on clear", () => {
    const value = message(1);
    expect(fitMessages([value], 0, MAX_LOADED_BYTES - messageBytes(value) + 1).accepted).toHaveLength(0);
    useAppStore.getState().setPeekResults([value]);
    useAppStore.getState().setSelectedMessage(value);
    useAppStore.getState().clearPeekResults();
    expect(useAppStore.getState().loadedMessageBytes).toBe(0);
    expect(useAppStore.getState().selectedMessage).toBeNull();
  });
  it("preserves case-insensitive body searches and combines property filters", () => {
    const messages = [message(1), message(2)];
    expect(filterMessages(messages, { messageId: "1", body: "RETRY", deadLetterReason: "", deadLetterErrorDescription: "" })).toEqual([messages[0]]);
    expect(filterMessages(messages, { messageId: "", body: "missing", deadLetterReason: "", deadLetterErrorDescription: "" })).toEqual([]);
  });
});
