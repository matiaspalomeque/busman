import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import type { Connection, PeekedMessage } from "../../types";
import { messageOperationKey } from "../../utils/messageOperation";
import { MessageGrid } from "./MessageGrid";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

const CONN: Connection = {
  id: "conn-1",
  name: "Test",
  connectionString: "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA==",
  env: {},
};

function message(sequenceNumber: string, source: string): PeekedMessage {
  return {
    messageId: `msg-${sequenceNumber}`,
    sequenceNumber,
    body: { ok: true },
    subject: null,
    contentType: "application/json",
    correlationId: null,
    partitionKey: null,
    traceParent: null,
    applicationProperties: null,
    enqueuedTimeUtc: "2026-01-01T00:00:00.000Z",
    expiresAtUtc: null,
    deadLetterReason: source.startsWith("Dead Letter") ? "failed" : null,
    deadLetterErrorDescription: null,
    _source: source,
  };
}

describe("MessageGrid", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    const store = useAppStore.getState();
    store.setConnections([CONN]);
    store.setActiveConnectionId(CONN.id);
    store.setExplorerQueue("q1");
  });

  it("shows an empty browse result without relying on a persisted filename", () => {
    const store = useAppStore.getState();
    expect(store.hasBrowsed).toBe(false);
    store.setPeekResults([]);

    render(<MessageGrid />);

    expect(useAppStore.getState().hasBrowsed).toBe(true);
    expect(screen.getByText("No messages found. This queue appears to be empty.")).toBeTruthy();
  });

  it("keeps the grid visible and renders pending message rows as loading rows", () => {
    const pending = message("42", "Dead Letter Queue: q1");
    const available = message("43", "Dead Letter Queue: q1");
    const pendingKey = messageOperationKey(pending);
    expect(pendingKey).toBeTruthy();

    const store = useAppStore.getState();
    store.setPeekResults([pending, available]);
    store.startMessageOperation(pendingKey!, {
      runId: "run-1",
      operation: "ReplayMessage",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    render(<MessageGrid />);

    expect(screen.getByText("1 message operation running")).toBeTruthy();
    expect(screen.getByText(/Replaying/)).toBeTruthy();
    expect(screen.queryByText("msg-42")).toBeNull();
    expect(screen.getByText("msg-43")).toBeTruthy();

    fireEvent.click(screen.getByText(/Replaying/).closest("tr")!);
    expect(useAppStore.getState().selectedMessage).toBeNull();

    fireEvent.click(screen.getByText("msg-43"));
    expect(useAppStore.getState().selectedMessage?.messageId).toBe("msg-43");

    fireEvent.keyDown(screen.getByText("msg-43").closest("tr")!, { key: "Enter" });
    expect(useAppStore.getState().selectedMessage).toBeNull();
  });

  it("keeps the message grid mounted while a bulk operation runs and shows its result until dismissed", () => {
    const available = message("43", "Dead Letter Queue: q1");
    const store = useAppStore.getState();
    store.setPeekResults([available]);
    store.addEventLogEntry({
      id: "bulk-run-1",
      time: "2026-01-01T00:00:00.000Z",
      namespace: "test",
      entity: "q1",
      entityType: "Queue",
      operation: "Replay",
      status: "running",
    });
    store.setRunning(true, "bulk-run-1", "bulk");
    store.setProgress({ text: "12 | Avg Rate: 4", elapsedMs: 3_000 });

    render(<MessageGrid />);

    expect(screen.getByText("msg-43")).toBeTruthy();
    expect(screen.getByText("Replay in progress")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();

    act(() => {
      useAppStore.getState().setRunning(false);
      useAppStore.getState().updateEventLogEntry("bulk-run-1", "success");
    });

    expect(screen.getByText("msg-43")).toBeTruthy();
    expect(screen.getByText("OK")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("OK")).toBeNull();
  });
});
