import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import type { Connection, PeekedMessage, QueueProperties } from "../../types";
import { openResend } from "./messageActions";
import { SendMessageModal } from "./SendMessageModal";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

const CONN: Connection = {
  id: "conn-1",
  name: "Test",
  connectionString:
    "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA==",
  env: {},
};

const SESSION_MESSAGE: PeekedMessage = {
  messageId: "message-42",
  sequenceNumber: "42",
  sessionId: "session-42",
  body: { ok: true },
  subject: "subject",
  contentType: "application/json",
  correlationId: "correlation-42",
  partitionKey: "partition-42",
  traceParent: null,
  applicationProperties: { source: "test" },
  enqueuedTimeUtc: null,
  expiresAtUtc: null,
  _source: "Normal Queue: q1",
};

function queueProperties(name: string, requiresSession: boolean): QueueProperties {
  return {
    name,
    lockDuration: "PT1M",
    maxSizeInMegabytes: 1024,
    requiresDuplicateDetection: false,
    requiresSession,
    defaultMessageTimeToLive: "P14D",
    deadLetteringOnMessageExpiration: true,
    maxDeliveryCount: 10,
    enablePartitioning: false,
    enableBatchedOperations: true,
    status: "Active",
    autoDeleteOnIdle: null,
    forwardTo: null,
    forwardDeadLetteredMessagesTo: null,
    maxMessageSizeInKilobytes: null,
    sizeInBytes: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    accessedAt: "2024-01-01T00:00:00Z",
    totalMessageCount: 0,
    activeMessageCount: 0,
    deadLetterMessageCount: 0,
    scheduledMessageCount: 0,
    transferMessageCount: 0,
    transferDeadLetterMessageCount: 0,
  };
}

function configureStore(requiresSession = false) {
  const store = useAppStore.getState();
  store.setConnections([CONN]);
  store.setActiveConnectionId(CONN.id);
  store.setExplorerQueue("q1");
  store.setEntityPropertiesState({ kind: "queue", data: queueProperties("q1", requiresSession) }, false, null);
  return store;
}

function inputFor(label: string): HTMLInputElement {
  const input = screen.getByText(label).parentElement?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for ${label}`);
  return input;
}

describe("SendMessageModal", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    localStorage.clear();
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves a source message Session Id through resend and send", async () => {
    const store = configureStore();
    openResend(SESSION_MESSAGE, store);

    expect(useAppStore.getState().sendDraft).toMatchObject({ sessionId: "session-42" });

    render(<SendMessageModal />);
    fireEvent.click(screen.getByRole("button", { name: "Advanced properties" }));

    expect(inputFor("Session Id").value).toBe("session-42");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("send_message", {
        args: {
          entityName: "q1",
          entityKind: "queue",
          connectionId: CONN.id,
          message: expect.objectContaining({ sessionId: "session-42" }),
        },
      });
    });
  });

  it("keeps Session Id unset for a manual send without a draft", async () => {
    configureStore();
    render(<SendMessageModal />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("send_message", {
        args: {
          entityName: "q1",
          entityKind: "queue",
          connectionId: CONN.id,
          message: expect.objectContaining({ sessionId: undefined }),
        },
      });
    });
  });

  it("blocks a cached session-required queue until Session Id is entered", async () => {
    configureStore(true);
    render(<SendMessageModal />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("requires sessions");
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(inputFor("Session Id").value).toBe("");
  });

  it("queries an edited queue target and blocks it when it requires sessions", async () => {
    configureStore(false);
    mocks.invoke.mockResolvedValueOnce(queueProperties("q2", true));
    render(<SendMessageModal />);

    fireEvent.change(inputFor("Entity Name"), { target: { value: "q2" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("get_queue_properties", {
        args: { connectionId: CONN.id, queueName: "q2" },
      });
      expect(screen.getByRole("alert").textContent).toContain("requires sessions");
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not infer session requirements for a topic send", async () => {
    const store = configureStore(false);
    store.setExplorerSubscription("events", "processor");
    render(<SendMessageModal />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("send_message", {
        args: {
          entityName: "events",
          entityKind: "topic",
          connectionId: CONN.id,
          message: expect.objectContaining({ sessionId: undefined }),
        },
      });
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
