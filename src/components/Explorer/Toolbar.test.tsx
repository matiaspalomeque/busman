import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
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

  it("hides Manage Rules unless a subscription is selected", () => {
    render(<Toolbar />);

    // With no selection the More dropdown is disabled, so Manage Rules is not reachable.
    const moreButton = screen.getByRole("button", { name: /More/ }) as HTMLButtonElement;
    expect(moreButton.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Manage Rules" })).toBeNull();
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
