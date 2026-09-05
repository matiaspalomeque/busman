import type { StateCreator } from "zustand";
import type { AppState } from "./appStore";
import type { PeekedMessage } from "../types";
import { computeMaxSeqNums } from "./peekCursors";
import { compareSequenceNumbers } from "../utils/sequenceNumber";
import { findMessageReplay } from "../utils/messageOperation";

// Called only with observed browse results; absence never proves processing succeeded.
export function observeReplayReturns(state: Pick<AppState, "eventLog" | "activeConnectionId" | "explorerSelection">, messages: PeekedMessage[]) {
  for (const message of messages) {
    const entry = findMessageReplay(state.eventLog, state.activeConnectionId, state.explorerSelection, message);
    if (entry && !entry.replayReturn && message.sequenceNumber != null) {
      entry.replayReturn = { observedAt: new Date().toISOString(), sequenceNumber: message.sequenceNumber };
    }
  }
}

export const MAX_LOADED_MESSAGES = 5_000;
export const MAX_LOADED_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
export const messageBytes = (message: PeekedMessage): number => encoder.encode(JSON.stringify(message)).byteLength;

export interface MessageSlice {
  peekMessages: PeekedMessage[];
  hasBrowsed: boolean;
  lastPeekNormalMaxSeqNum: string | null;
  lastPeekDlqMaxSeqNum: string | null;
  loadedMessageBytes: number;
  messageBudgetReached: boolean;
  setPeekResults: (messages: PeekedMessage[]) => void;
  appendPeekResults: (messages: PeekedMessage[]) => void;
  clearPeekResults: () => void;
}

export function fitMessages(messages: PeekedMessage[], count: number, bytes: number) {
  const accepted: PeekedMessage[] = [];
  for (const message of messages) {
    const size = messageBytes(message);
    if (count + accepted.length >= MAX_LOADED_MESSAGES || bytes + size > MAX_LOADED_BYTES) break;
    accepted.push(message); bytes += size;
  }
  return { accepted, bytes, reached: accepted.length < messages.length || count + accepted.length >= MAX_LOADED_MESSAGES || bytes >= MAX_LOADED_BYTES };
}

export const createMessageSlice: StateCreator<AppState, [["zustand/immer", never]], [], MessageSlice> = (set) => ({
  peekMessages: [], hasBrowsed: false, lastPeekNormalMaxSeqNum: null, lastPeekDlqMaxSeqNum: null,
  loadedMessageBytes: 0, messageBudgetReached: false,
  setPeekResults: (messages) => set((state) => {
    observeReplayReturns(state, messages);
    const result = fitMessages(messages, 0, 0);
    state.peekMessages = result.accepted;
    state.loadedMessageBytes = result.bytes; state.messageBudgetReached = result.reached; state.hasBrowsed = true;
    const cursors = computeMaxSeqNums(result.accepted);
    state.lastPeekNormalMaxSeqNum = cursors.normal; state.lastPeekDlqMaxSeqNum = cursors.dlq;
  }),
  appendPeekResults: (messages) => set((state) => {
    observeReplayReturns(state, messages);
    const result = fitMessages(messages, state.peekMessages.length, state.loadedMessageBytes);
    state.peekMessages.push(...result.accepted);
    state.loadedMessageBytes = result.bytes; state.messageBudgetReached = result.reached; state.hasBrowsed = true;
    const cursors = computeMaxSeqNums(result.accepted);
    if (cursors.normal !== null && (state.lastPeekNormalMaxSeqNum === null || compareSequenceNumbers(cursors.normal, state.lastPeekNormalMaxSeqNum) > 0)) state.lastPeekNormalMaxSeqNum = cursors.normal;
    if (cursors.dlq !== null && (state.lastPeekDlqMaxSeqNum === null || compareSequenceNumbers(cursors.dlq, state.lastPeekDlqMaxSeqNum) > 0)) state.lastPeekDlqMaxSeqNum = cursors.dlq;
  }),
  clearPeekResults: () => set((state) => {
    state.peekMessages = []; state.hasBrowsed = false; state.selectedMessage = null;
    state.lastPeekNormalMaxSeqNum = null; state.lastPeekDlqMaxSeqNum = null;
    state.loadedMessageBytes = 0; state.messageBudgetReached = false;
  }),
});
