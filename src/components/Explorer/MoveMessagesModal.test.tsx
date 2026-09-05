import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import type { Connection, PeekedMessage } from "../../types";
import { MoveMessagesModal } from "./MoveMessagesModal";

const mocks = vi.hoisted(() => ({
  runOperation: vi.fn(),
}));

vi.mock("../../hooks/useScript", () => ({
  useScript: () => ({
    runOperation: mocks.runOperation,
  }),
}));

const CONN: Connection = {
  id: "conn-1",
  name: "Test",
  connectionString: "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA==",
  env: {},
};

function message(sequenceNumber = "42"): PeekedMessage {
  return {
    messageId: `msg-${sequenceNumber}`,
    sequenceNumber,
    body: { ok: true },
    subject: null,
    contentType: "application/json",
    correlationId: null,
    partitionKey: null,
    sessionId: "session-42",
    state: "deferred",
    sourceSubQueue: "deadLetter",
    traceParent: null,
    applicationProperties: null,
    enqueuedTimeUtc: null,
    expiresAtUtc: null,
    deadLetterReason: "failed",
    deadLetterErrorDescription: null,
    _source: "Dead Letter Queue: q1",
  };
}

function renderSingleMoveModal(msg: PeekedMessage = message()) {
  const store = useAppStore.getState();
  store.setConnections([CONN]);
  store.setActiveConnectionId(CONN.id);
  store.setExplorerQueue("q1");
  store.setEntities({ queues: ["q1", "q2"], topics: {} });
  store.setSingleMessageMoveTarget(msg);
  store.setIsMoveModalOpen(true);
  render(<MoveMessagesModal />);
}

describe("MoveMessagesModal", () => {
  beforeEach(() => {
    mocks.runOperation.mockClear();
    useAppStore.setState(useAppStore.getInitialState());
    mocks.runOperation.mockResolvedValue({ exitCode: 0 });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes peeked message metadata to single-message move actions", () => {
    renderSingleMoveModal();

    fireEvent.change(screen.getByPlaceholderText("target-queue"), {
      target: { value: "q2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    expect(mocks.runOperation).toHaveBeenCalledWith(
      "single_message_action",
      expect.objectContaining({
        action: "move",
        sequenceNumber: "42",
        isDlq: true,
        queueName: "q1",
        destQueue: "q2",
        connectionId: "conn-1",
        messageId: "msg-42",
        sessionId: "session-42",
        state: "deferred",
        source: "Dead Letter Queue: q1",
        sourceSubQueue: "deadLetter",
      }),
      { scope: "atomic", runId: "00000000-0000-0000-0000-000000000001" },
    );
  });

  it("passes the signed int64 maximum to an atomic move as an exact string", () => {
    renderSingleMoveModal(message("9223372036854775807"));

    fireEvent.change(screen.getByPlaceholderText("target-queue"), {
      target: { value: "q2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    expect(mocks.runOperation).toHaveBeenCalledWith(
      "single_message_action",
      expect.objectContaining({ sequenceNumber: "9223372036854775807" }),
      { scope: "atomic", runId: "00000000-0000-0000-0000-000000000001" },
    );
  });

  it.each(["normal", "dlq", "both"] as const)("preserves %s scope in the dialog and command", (mode) => {
    const store = useAppStore.getState();
    store.setConnections([CONN]);
    store.setActiveConnectionId(CONN.id);
    store.setExplorerQueue("orders_error");
    store.setPeekMode(mode);
    render(<MoveMessagesModal />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText(/Destination Queue/));
    expect(screen.getByText(/Browse count and loaded-message filters/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(mocks.runOperation).toHaveBeenCalledWith("move_messages", expect.objectContaining({
      mode, sourceQueue: "orders_error", destQueue: "orders", connectionId: CONN.id,
    }), expect.anything());
  });

  it("keeps the original source and prevents a connection change from retargeting the move", () => {
    const store = useAppStore.getState();
    store.setConnections([CONN, { ...CONN, id: "conn-2" }]);
    store.setActiveConnectionId(CONN.id);
    store.setExplorerQueue("orders_error");
    render(<MoveMessagesModal />);
    act(() => { store.setExplorerQueue("different"); });
    expect((screen.getByLabelText(/Source Queue/) as HTMLInputElement).value).toBe("orders_error");
    act(() => { store.setActiveConnectionId("conn-2"); });
    expect((screen.getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("connection changed");
  });

  it("traps keyboard focus, closes with Escape, and restores focus", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const store = useAppStore.getState();
    store.setConnections([CONN]); store.setActiveConnectionId(CONN.id); store.setExplorerQueue("orders_error");
    store.setIsMoveModalOpen(true);
    const view = render(<MoveMessagesModal />);
    const move = screen.getByRole("button", { name: "Move" });
    move.focus();
    fireEvent.keyDown(move, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getAllByRole("button", { name: "Close" })[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(useAppStore.getState().isMoveModalOpen).toBe(false);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
