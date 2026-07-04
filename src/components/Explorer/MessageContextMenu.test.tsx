import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import type { Connection, PeekedMessage } from "../../types";
import { MessageContextMenu } from "./MessageContextMenu";

vi.mock("../../hooks/useScript", () => ({
  useScript: () => ({
    runOperation: vi.fn(),
  }),
}));

const CONN: Connection = {
  id: "conn-1",
  name: "Test",
  connectionString: "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA==",
  env: {},
};

function message(source: string): PeekedMessage {
  return {
    messageId: "msg-1",
    sequenceNumber: "42",
    body: { ok: true },
    subject: null,
    contentType: "application/json",
    correlationId: null,
    partitionKey: null,
    traceParent: null,
    applicationProperties: null,
    enqueuedTimeUtc: null,
    expiresAtUtc: null,
    deadLetterReason: source.startsWith("Dead Letter") ? "failed" : null,
    deadLetterErrorDescription: null,
    _source: source,
  };
}

function renderMenu(msg: PeekedMessage) {
  const store = useAppStore.getState();
  store.setConnections([CONN]);
  store.setActiveConnectionId(CONN.id);
  store.setExplorerQueue("q1");
  store.setMessageContextMenu({ x: 10, y: 10, msg });
  render(<MessageContextMenu />);
}

describe("MessageContextMenu", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("does not expose destructive single-message actions for active messages", () => {
    renderMenu(message("Normal Queue: q1"));

    expect(screen.getByText("Copy Message ID")).toBeTruthy();
    expect(screen.getByText("Resend (send a copy)")).toBeTruthy();
    expect(screen.queryByText(/Move to queue/)).toBeNull();
    expect(screen.queryByText("Replay to main queue")).toBeNull();
    expect(screen.queryByText("Delete this message")).toBeNull();
  });

  it("keeps single-message recovery actions for DLQ messages", () => {
    renderMenu(message("Dead Letter Queue: q1"));

    expect(screen.getByText(/Move to queue/)).toBeTruthy();
    expect(screen.getByText("Replay to main queue")).toBeTruthy();
    expect(screen.getByText("Delete this message")).toBeTruthy();
  });
});
