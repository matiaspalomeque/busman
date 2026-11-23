import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./appStore";
import { MAX_LOADED_BYTES, MAX_LOADED_MESSAGES, fitMessages, messageBytes } from "./messageSlice";
import { filterMessages } from "../utils/messageSearch";
import * as messageBody from "../utils/messageBody";
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
  it("keeps each interrupted source until it completes and clears the list on a queue change", () => {
    const store = useAppStore.getState();
    store.setPeekResults([], ["normal", "dlq"]);
    store.appendPeekResults([], "normal");
    expect(useAppStore.getState().truncatedPeekSources).toEqual(["dlq"]);
    store.appendPeekResults([], "dlq", ["dlq"]);
    expect(useAppStore.getState().truncatedPeekSources).toEqual(["dlq"]);
    store.setExplorerQueue("another-queue");
    expect(useAppStore.getState().truncatedPeekSources).toEqual([]);
  });
  it("preserves case-insensitive body searches and combines property filters", () => {
    const messages = [message(1), message(2)];
    expect(filterMessages(messages, { messageId: "1", body: "RETRY", deadLetterReason: "", deadLetterErrorDescription: "" })).toEqual([messages[0]]);
    expect(filterMessages(messages, { messageId: "", body: "missing", deadLetterReason: "", deadLetterErrorDescription: "" })).toEqual([]);
  });

  it("matches raw and formatted JSON, decoded strings, and exact numeric IDs", () => {
    const record = { ...message(1), bodyIsJson: true,
      body: String.raw`{"name":"Jos\u00E9 O\u0027Brien","email":"a\u002Bb@x.com","id":9007199254740993}` };
    const search = (body: string) => filterMessages([record], { body, messageId: "", deadLetterReason: "", deadLetterErrorDescription: "" });
    for (const term of ["José", "O'Brien", "a+b@x.com", '"name": "jos', String.raw`"name": "Jos\u00E9`, '"id": 9007199254740993']) {
      expect(search(term), term).toEqual([record]);
    }
    expect(search("9007199254740992")).toEqual([]);
  });

  it("reuses dense JSON search text and preserves exact indentation for copied snippets", () => {
    const record = { ...message(1), bodyIsJson: true,
      body: JSON.stringify({ readings: Array.from({ length: 80 }, () => [0, 0, 1]) }) };
    const search = (body: string) => filterMessages([record], { body, messageId: "", deadLetterReason: "", deadLetterErrorDescription: "" });
    const formatter = vi.spyOn(messageBody, "formatBodyJson");
    try {
      expect(search('"readings": [')).toEqual([record]);
      expect(search('"readings": 1')).toEqual([]);
      expect(search('"readings": 0')).toEqual([]);
      for (const yes of ['  "readings": [', '[\n    [\n      0,', '0,\n      0,']) {
        expect(search(yes), yes).toEqual([record]);
      }
      for (const no of ['   "readings": [', '[\n   [', '0,\n     0,', '0,\n0,']) {
        expect(search(no), no).toEqual([]);
      }
      expect(formatter.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      formatter.mockRestore();
    }
  });
});
