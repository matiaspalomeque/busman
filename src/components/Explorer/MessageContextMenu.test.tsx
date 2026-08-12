import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import type { Connection, PeekedMessage } from "../../types";
import { MessageContextMenu } from "./MessageContextMenu";
import { messageOperationKey } from "../../utils/messageOperation";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  runOperation: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
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

function message(source: string, sequenceNumber = "42"): PeekedMessage {
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
    mocks.invoke.mockReset();
    mocks.runOperation.mockReset();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("gets, replaces, and clears the exact queue session state from a DLQ message", async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        encoding: "base64",
        stateBase64: "AP8=",
        byteLength: 2,
        hasState: true,
      })
      .mockResolvedValueOnce({
        encoding: "base64",
        stateBase64: "aGVsbG8=",
        byteLength: 5,
        hasState: true,
      })
      .mockResolvedValueOnce({
        encoding: "base64",
        stateBase64: "",
        byteLength: 0,
        hasState: false,
      });
    renderMenu({
      ...message("Dead Letter Queue: q1"),
      sessionId: "session-42",
    });

    fireEvent.click(screen.getByText("Manage Session State…"));

    const stateInput = await screen.findByLabelText("Session state (base64)");
    await waitFor(() => {
      expect((stateInput as HTMLTextAreaElement).value).toBe("AP8=");
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "get_session_state", {
      args: {
        connectionId: CONN.id,
        queueName: "q1",
        topicName: undefined,
        subscriptionName: undefined,
        sessionId: "session-42",
      },
    });

    fireEvent.change(stateInput, { target: { value: "aGVsbG8=" } });
    fireEvent.click(screen.getByRole("button", { name: "Set State" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace State" }));
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenNthCalledWith(2, "set_session_state", {
        args: {
          connectionId: CONN.id,
          queueName: "q1",
          topicName: undefined,
          subscriptionName: undefined,
          sessionId: "session-42",
          stateBase64: "aGVsbG8=",
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear State" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Clear State" })[0]);
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenNthCalledWith(3, "clear_session_state", {
        args: {
          connectionId: CONN.id,
          queueName: "q1",
          topicName: undefined,
          subscriptionName: undefined,
          sessionId: "session-42",
        },
      });
    });
  });

  it.each(["AB==", "AAB="])(
    "blocks noncanonical session state %s before invoking the set command",
    async (stateBase64) => {
      mocks.invoke.mockResolvedValueOnce({
        encoding: "base64",
        stateBase64: "",
        byteLength: 0,
        hasState: false,
      });
      renderMenu({
        ...message("Dead Letter Queue: q1"),
        sessionId: "session-42",
      });

      fireEvent.click(screen.getByText("Manage Session State…"));

      const stateInput = await screen.findByLabelText("Session state (base64)");
      await waitFor(() => {
        expect((stateInput as HTMLTextAreaElement).disabled).toBe(false);
      });
      fireEvent.change(stateInput, { target: { value: stateBase64 } });
      fireEvent.click(screen.getByRole("button", { name: "Set State" }));

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Enter canonical standard base64",
      );
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Replace State" })).toBeNull();
    },
  );

  it("maps a subscription session message to its parent topic and subscription", async () => {
    mocks.invoke.mockResolvedValueOnce({
      encoding: "base64",
      stateBase64: "",
      byteLength: 0,
      hasState: false,
    });
    const store = useAppStore.getState();
    store.setConnections([CONN]);
    store.setActiveConnectionId(CONN.id);
    store.setExplorerSubscription("events", "processor");
    store.setMessageContextMenu({
      x: 10,
      y: 10,
      msg: { ...message("Normal Subscription: events/processor"), sessionId: "s-1" },
    });
    render(<MessageContextMenu />);

    fireEvent.click(screen.getByText("Manage Session State…"));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("get_session_state", {
        args: {
          connectionId: CONN.id,
          queueName: undefined,
          topicName: "events",
          subscriptionName: "processor",
          sessionId: "s-1",
        },
      });
    });
  });

  it("starts a pending row operation and clears it when the action settles", async () => {
    let resolveRun!: (value: { exitCode: number }) => void;
    mocks.runOperation.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );

    const msg: PeekedMessage = {
      ...message("Dead Letter Queue: q1"),
      sessionId: "session-42",
      state: "deferred",
      sourceSubQueue: "deadLetter",
    };
    renderMenu(msg);

    fireEvent.click(screen.getByText("Replay to main queue"));
    fireEvent.click(screen.getByText("Replay"));

    const key = messageOperationKey(msg);
    expect(key).toBeTruthy();
    expect(useAppStore.getState().pendingMessageOperations[key!]?.operation).toBe("ReplayMessage");
    expect(mocks.runOperation).toHaveBeenCalledWith(
      "single_message_action",
      expect.objectContaining({
        action: "replay",
        sequenceNumber: "42",
        messageId: "msg-42",
        sessionId: "session-42",
        state: "deferred",
        source: "Dead Letter Queue: q1",
        sourceSubQueue: "deadLetter",
      }),
      { scope: "atomic", runId: "00000000-0000-0000-0000-000000000001" },
    );

    resolveRun({ exitCode: 0 });
    await waitFor(() => {
      expect(useAppStore.getState().pendingMessageOperations[key!]).toBeUndefined();
    });
  });

  it("targets a sequence number beyond JavaScript's safe integer range without coercion", () => {
    mocks.runOperation.mockResolvedValue({ exitCode: 0 });
    renderMenu(message("Dead Letter Queue: q1", "9007199254740993"));

    fireEvent.click(screen.getByText("Delete this message"));
    fireEvent.click(screen.getByText("Delete"));

    expect(mocks.runOperation).toHaveBeenCalledWith(
      "single_message_action",
      expect.objectContaining({ sequenceNumber: "9007199254740993" }),
      { scope: "atomic", runId: "00000000-0000-0000-0000-000000000001" },
    );
  });

  it("disables destructive actions only for the row that is already pending", () => {
    const pendingMsg = message("Dead Letter Queue: q1", "42");
    const availableMsg = message("Dead Letter Queue: q1", "43");
    const pendingKey = messageOperationKey(pendingMsg);
    expect(pendingKey).toBeTruthy();

    const store = useAppStore.getState();
    store.setConnections([CONN]);
    store.setActiveConnectionId(CONN.id);
    store.setExplorerQueue("q1");
    store.startMessageOperation(pendingKey!, {
      runId: "run-1",
      operation: "DeleteMessage",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    store.setMessageContextMenu({ x: 10, y: 10, msg: pendingMsg });

    render(<MessageContextMenu />);
    expect((screen.getByText(/Move to queue/).closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Replay to main queue").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Delete this message").closest("button") as HTMLButtonElement).disabled).toBe(true);

    useAppStore.getState().setMessageContextMenu({ x: 10, y: 10, msg: availableMsg });
    render(<MessageContextMenu />);

    const moveButtons = screen.getAllByText(/Move to queue/);
    const replayButtons = screen.getAllByText("Replay to main queue");
    const deleteButtons = screen.getAllByText("Delete this message");
    expect((moveButtons[moveButtons.length - 1].closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect((replayButtons[replayButtons.length - 1].closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect((deleteButtons[deleteButtons.length - 1].closest("button") as HTMLButtonElement).disabled).toBe(false);
  });
});
