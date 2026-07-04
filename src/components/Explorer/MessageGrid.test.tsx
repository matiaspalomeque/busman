import { fireEvent, render, screen } from "@testing-library/react";
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

  it("keeps the grid visible and renders pending message rows as loading rows", () => {
    const pending = message("42", "Dead Letter Queue: q1");
    const available = message("43", "Dead Letter Queue: q1");
    const pendingKey = messageOperationKey(pending);
    expect(pendingKey).toBeTruthy();

    const store = useAppStore.getState();
    store.setPeekResults([pending, available], "peek.json");
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
  });
});
