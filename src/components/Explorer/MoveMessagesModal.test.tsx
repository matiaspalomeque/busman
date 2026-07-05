import { fireEvent, render, screen } from "@testing-library/react";
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

function message(): PeekedMessage {
  return {
    messageId: "msg-42",
    sequenceNumber: "42",
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
        sequenceNumber: 42,
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
});
