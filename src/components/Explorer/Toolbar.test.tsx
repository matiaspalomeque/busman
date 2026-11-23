import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import { MAX_LOADED_BYTES, messageBytes } from "../../store/messageSlice";
import type { PeekedMessage } from "../../types";
import { Toolbar } from "./Toolbar";

const mocks = vi.hoisted(() => ({ runOperation: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../../hooks/useConnections", () => ({
  useConnections: () => ({
    setActive: vi.fn(),
  }),
}));

vi.mock("../../hooks/useScript", () => ({
  useScript: () => ({
    runOperation: mocks.runOperation,
    stop: vi.fn(),
  }),
}));

const CONN = {
  id: "conn-1",
  name: "Test",
  connectionString: "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA==",
  env: {},
};

const mockInvoke = vi.mocked(invoke);

function peekedMessage(messageId: string, sequenceNumber: string, source: string): PeekedMessage {
  return {
    messageId,
    sequenceNumber,
    body: {},
    subject: null,
    contentType: null,
    correlationId: null,
    partitionKey: null,
    traceParent: null,
    applicationProperties: null,
    enqueuedTimeUtc: null,
    expiresAtUtc: null,
    _source: source,
  };
}

function peekResult(messages: PeekedMessage[]) {
  return { messages };
}

describe("Toolbar", () => {
  beforeEach(() => {
    mocks.runOperation.mockReset();
    mockInvoke.mockReset();
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.getState().setConnections([CONN]);
    useAppStore.getState().setActiveConnectionId(CONN.id);
  });

  it.each(["Drain / delete messages", "Replay", "Republish"])("records an actionable rejected %s without leaving a running entry", async (action) => {
    if (action === "Republish") useAppStore.getState().setExplorerSubscription("billing", "processor");
    else useAppStore.getState().setExplorerQueue("orders");
    mocks.runOperation.mockRejectedValueOnce(new Error("Check the earlier unknown outcome in Event Log"));
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: action }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(useAppStore.getState().eventLog[0]).toMatchObject({ status: "error", errorMessage: expect.stringContaining("unknown outcome") }));
    expect(useAppStore.getState().isRunning).toBe(false);
  });

  it("hides entity actions until an entity is selected", () => {
    render(<Toolbar />);

    expect(screen.queryByRole("button", { name: /More/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Browse" })).toBeNull();
  });

  it("shows Manage Rules for subscriptions and opens the modal", () => {
    useAppStore.getState().setExplorerSubscription("billing", "processor");

    render(<Toolbar />);

    const moreButton = screen.getByRole("button", { name: /More/ }) as HTMLButtonElement;
    expect(moreButton.disabled).toBe(false);
    expect(moreButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(moreButton);
    expect(moreButton.getAttribute("aria-expanded")).toBe("true");

    const manageRulesButton = screen.getByRole("menuitem", { name: "Manage Rules" }) as HTMLButtonElement;
    expect(manageRulesButton.disabled).toBe(false);

    fireEvent.click(manageRulesButton);

    expect(useAppStore.getState().isSubscriptionRulesModalOpen).toBe(true);
  });

  it("requests the initial Both page once and stores independent source cursors", async () => {
    useAppStore.getState().setExplorerQueue("orders");
    mockInvoke.mockResolvedValueOnce(
      peekResult(
        [
          peekedMessage("normal-10", "10", "Normal Queue: orders"),
          peekedMessage("dlq-500", "500", "Dead Letter Queue: orders"),
        ]
      )
    );

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Both" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    expect(mockInvoke).toHaveBeenCalledWith("peek_messages", {
      args: {
        argv: ["queue", "orders", "100", "both", ""],
        connectionId: CONN.id,
        runId: expect.any(String),
      },
    });
    await waitFor(() => {
      const state = useAppStore.getState();
      expect(state.peekMessages.map((message) => message.messageId)).toEqual(["normal-10", "dlq-500"]);
      expect(state.lastPeekNormalMaxSeqNum).toBe("10");
      expect(state.lastPeekDlqMaxSeqNum).toBe("500");
    });
  });

  it("loads repeated Both pages from independent normal and DLQ cursors", async () => {
    useAppStore.getState().setExplorerQueue("orders");
    useAppStore.getState().setPeekResults(
      [
        peekedMessage("normal-10", "10", "Normal Queue: orders"),
        peekedMessage("dlq-500", "500", "Dead Letter Queue: orders"),
      ]
    );
    mockInvoke
      .mockResolvedValueOnce(
        peekResult([peekedMessage("normal-11", "11", "Normal Queue: orders")])
      )
      .mockResolvedValueOnce(
        peekResult([peekedMessage("dlq-501", "501", "Dead Letter Queue: orders")])
      )
      .mockResolvedValueOnce(
        peekResult([peekedMessage("normal-12", "12", "Normal Queue: orders")])
      )
      .mockResolvedValueOnce(
        peekResult([peekedMessage("dlq-502", "502", "Dead Letter Queue: orders")])
      );

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Both" }));
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "peek_messages", {
      args: {
        argv: ["queue", "orders", "100", "normal", "11"],
        connectionId: CONN.id,
        runId: expect.any(String),
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "peek_messages", {
      args: {
        argv: ["queue", "orders", "100", "dlq", "501"],
        connectionId: CONN.id,
        runId: expect.any(String),
      },
    });

    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Load More" }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(4));
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "peek_messages", {
      args: {
        argv: ["queue", "orders", "100", "normal", "12"],
        connectionId: CONN.id,
        runId: expect.any(String),
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(4, "peek_messages", {
      args: {
        argv: ["queue", "orders", "100", "dlq", "502"],
        connectionId: CONN.id,
        runId: expect.any(String),
      },
    });

    await waitFor(() => {
      const state = useAppStore.getState();
      expect(state.peekMessages.map((message) => message.messageId)).toEqual([
        "normal-10",
        "dlq-500",
        "normal-11",
        "dlq-501",
        "normal-12",
        "dlq-502",
      ]);
      expect(state.lastPeekNormalMaxSeqNum).toBe("12");
      expect(state.lastPeekDlqMaxSeqNum).toBe("502");
    });
  });

  it.each([
    { action: "Browse", reset: "reselecting the queue" },
    { action: "Load More", reset: "reselecting the queue" },
    { action: "Load More", reset: "clearing the results" },
  ])("discards a pending $action after $reset", async ({ action, reset }) => {
    const store = useAppStore.getState();
    store.setExplorerQueue("orders");
    store.setPeekMode("both");
    store.setPeekResults([peekedMessage("normal-1", "1", "Normal Queue: orders")], ["dlq"]);

    const page = peekResult([peekedMessage("normal-2", "2", "Normal Queue: orders")]);
    let finishRead!: () => void;
    const pending = new Promise<void>((resolve) => { finishRead = resolve; });
    mockInvoke.mockImplementationOnce(async () => {
      await pending;
      if (action === "Load More") throw new Error("DLQ read failed");
      return page;
    }).mockResolvedValueOnce(page);

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    act(() => {
      if (reset === "clearing the results") store.clearPeekResults();
      else {
        store.setExplorerQueue("billing");
        store.setExplorerQueue("orders");
      }
    });
    await act(async () => finishRead());

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState()).toMatchObject({
      hasBrowsed: false,
      peekMessages: [],
      lastPeekNormalMaxSeqNum: null,
      lastPeekDlqMaxSeqNum: null,
      lastBrowseError: null,
      eventLog: [expect.objectContaining({ status: "stopped" })],
    });
  });

  it("loads a DLQ record deferred by the shared frame before more Normal records fill the view", async () => {
    useAppStore.getState().setExplorerQueue("orders");
    const normal = peekedMessage("normal-1", "1", "Normal Queue: orders");
    const dlq = peekedMessage("dlq-501", "501", "Dead Letter Queue: orders");
    mockInvoke.mockImplementation(async (_command, payload) => {
      const { argv } = (payload as { args: { argv: string[] } }).args;
      if (argv[3] === "both") return { messages: [normal], truncatedSources: ["dlq"] };
      if (argv[3] === "dlq") return peekResult([dlq]);
      return peekResult([peekedMessage("normal-2", "2", "Normal Queue: orders")]);
    });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Both" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await waitFor(() => expect(useAppStore.getState().peekMessages).toHaveLength(1));
    // Exactly one DLQ record still fits. Keep the regression fixture small.
    useAppStore.setState({ loadedMessageBytes: MAX_LOADED_BYTES - messageBytes(dlq) });
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await waitFor(() => expect(useAppStore.getState().eventLog[0].status).toBe("success"));
    const state = useAppStore.getState();
    expect(state.peekMessages.map((message) => message.messageId)).toEqual(["normal-1", "dlq-501"]);
    expect([state.lastPeekNormalMaxSeqNum, state.lastPeekDlqMaxSeqNum]).toEqual(["1", "501"]);
    expect(state.messageBudgetReached).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("increments a large cursor exactly and skips a source already at i64 max", async () => {
    useAppStore.getState().setExplorerQueue("orders");
    useAppStore.getState().setPeekResults(
      [
        peekedMessage("normal-large", "9007199254740993", "Normal Queue: orders"),
        peekedMessage("dlq-max", "9223372036854775807", "Dead Letter Queue: orders"),
      ]
    );
    mockInvoke.mockResolvedValueOnce(
      peekResult(
        [peekedMessage("normal-partition", "9288674231451771", "Normal Queue: orders")]
      )
    );

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Both" }));
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    expect(mockInvoke).toHaveBeenCalledWith("peek_messages", {
      args: {
        argv: ["queue", "orders", "100", "normal", "9007199254740994"],
        connectionId: CONN.id,
        runId: expect.any(String),
      },
    });
    await waitFor(() => {
      const state = useAppStore.getState();
      expect(state.lastPeekNormalMaxSeqNum).toBe("9288674231451771");
      expect(state.lastPeekDlqMaxSeqNum).toBe("9223372036854775807");
    });
  });

  it("keeps the oversized DLQ error and advances Normal on the same Load More", async () => {
    const store = useAppStore.getState();
    store.setExplorerQueue("orders");
    store.setPeekMode("both");
    store.setPeekResults([peekedMessage("normal-1", "1", "Normal Queue: orders")], ["dlq"]);
    const sizeError = "message 501 in Dead Letter Queue: orders needs 68157886 encoded bytes, exceeding the browse limit of 67108864 bytes";
    mockInvoke.mockRejectedValueOnce(new Error(sizeError))
      .mockResolvedValueOnce(peekResult([peekedMessage("normal-2", "2", "Normal Queue: orders")]));
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await waitFor(() => expect(useAppStore.getState().eventLog[0].status).toBe("error"));
    const state = useAppStore.getState();
    expect(state.peekMessages.map((row) => row.messageId)).toEqual(["normal-1", "normal-2"]);
    expect([state.lastPeekNormalMaxSeqNum, state.lastPeekDlqMaxSeqNum]).toEqual(["2", null]);
    expect(state.lastBrowseError).toContain(sizeError);
    expect(state.eventLog[0].errorMessage).toBe(state.lastBrowseError);
    expect(state.truncatedPeekSources).toEqual(["dlq"]);
  });

  it.each([
    { first: "Operation cancelled.", calls: 1, error: "DLQ: Operation cancelled." },
    { first: "DLQ read failed", calls: 2, error: "DLQ: DLQ read failed\nNormal: Normal read failed" },
  ])("finishes Both after $calls source reads when the first reports $first", async ({ first, calls, error }) => {
    const store = useAppStore.getState();
    store.setExplorerQueue("orders");
    store.setPeekMode("both");
    store.setPeekResults([peekedMessage("normal-1", "1", "Normal Queue: orders")], ["dlq"]);
    mockInvoke.mockRejectedValueOnce(first).mockRejectedValueOnce("Normal read failed");
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await waitFor(() => expect(useAppStore.getState().eventLog[0].status).toBe("error"));
    expect(mockInvoke).toHaveBeenCalledTimes(calls);
    expect(useAppStore.getState().lastBrowseError).toBe(error);
  });

  it("retains a fitting record from the other source when the interrupted source cannot fit", async () => {
    const store = useAppStore.getState();
    store.setExplorerQueue("orders");
    store.setPeekMode("both");
    const normal = peekedMessage("normal-2", "2", "Normal Queue: orders");
    const dlq = { ...peekedMessage("dlq-501", "501", "Dead Letter Queue: orders"), body: "x".repeat(200) };
    store.setPeekResults([peekedMessage("normal-1", "1", "Normal Queue: orders")], ["dlq"]);
    useAppStore.setState({ loadedMessageBytes: MAX_LOADED_BYTES - messageBytes(normal) - 1 });
    mockInvoke.mockResolvedValueOnce(peekResult([dlq])).mockResolvedValueOnce(peekResult([normal]));
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await waitFor(() => expect(useAppStore.getState().eventLog[0].status).toBe("success"));
    const state = useAppStore.getState();
    expect(state.peekMessages.map((record) => record.messageId)).toEqual(["normal-1", "normal-2"]);
    expect([state.lastPeekNormalMaxSeqNum, state.lastPeekDlqMaxSeqNum]).toEqual(["2", null]);
    expect(state.messageBudgetReached).toBe(true);
  });

  it("rechecks an initially empty Both source without resetting the other cursor", async () => {
    useAppStore.getState().setExplorerQueue("orders");
    useAppStore.getState().setPeekResults([
      peekedMessage("normal-10", "10", "Normal Queue: orders"),
    ]);
    mockInvoke
      .mockResolvedValueOnce(
        peekResult([peekedMessage("normal-11", "11", "Normal Queue: orders")])
      )
      .mockResolvedValueOnce(
        peekResult([peekedMessage("dlq-500", "500", "Dead Letter Queue: orders")])
      );

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Both" }));
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "peek_messages", {
      args: {
        argv: ["queue", "orders", "100", "normal", "11"],
        connectionId: CONN.id,
        runId: expect.any(String),
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "peek_messages", {
      args: {
        argv: ["queue", "orders", "100", "dlq", ""],
        connectionId: CONN.id,
        runId: expect.any(String),
      },
    });

    await waitFor(() => {
      const state = useAppStore.getState();
      expect(state.peekMessages.map((message) => message.messageId)).toEqual([
        "normal-10",
        "normal-11",
        "dlq-500",
      ]);
      expect(state.lastPeekNormalMaxSeqNum).toBe("11");
      expect(state.lastPeekDlqMaxSeqNum).toBe("500");
    });
  });
});
