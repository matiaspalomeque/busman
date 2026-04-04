import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEntityProperties } from "./useEntityProperties";
import { useAppStore } from "../store/appStore";

vi.mock("../schemas/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schemas/ipc")>();
  return {
    ...actual,
    safeInvoke: vi.fn(),
  };
});

import { safeInvoke } from "../schemas/ipc";

const mockSafeInvoke = vi.mocked(safeInvoke);
const CONN = { id: "conn-1", name: "Test", connectionString: "sb://test.servicebus.windows.net/", env: {} };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  useAppStore.getState().setConnections([CONN]);
  useAppStore.getState().setActiveConnectionId(CONN.id);
});

describe("useEntityProperties", () => {
  it("ignores stale property responses after clearing the selection", async () => {
    const pending = deferred<{
      name: string;
      lockDuration: string | null;
      maxSizeInMegabytes: number | null;
      requiresDuplicateDetection: boolean | null;
      requiresSession: boolean | null;
      defaultMessageTimeToLive: string | null;
      deadLetteringOnMessageExpiration: boolean | null;
      maxDeliveryCount: number | null;
      enablePartitioning: boolean | null;
      enableBatchedOperations: boolean | null;
      status: string | null;
      autoDeleteOnIdle: string | null;
      forwardTo: string | null;
      forwardDeadLetteredMessagesTo: string | null;
      maxMessageSizeInKilobytes: number | null;
      sizeInBytes: number;
      createdAt: string;
      updatedAt: string;
      accessedAt: string;
      totalMessageCount: number;
      activeMessageCount: number;
      deadLetterMessageCount: number;
      scheduledMessageCount: number;
      transferMessageCount: number;
      transferDeadLetterMessageCount: number;
    }>();
    mockSafeInvoke.mockReturnValueOnce(pending.promise);

    renderHook(() => useEntityProperties());

    act(() => {
      useAppStore.getState().setExplorerQueue("queue-a");
    });

    expect(useAppStore.getState().entityPropertiesLoading).toBe(true);

    act(() => {
      useAppStore.getState().clearExplorerSelection();
    });

    await act(async () => {
      pending.resolve({
        name: "queue-a",
        lockDuration: "PT1M",
        maxSizeInMegabytes: 1024,
        requiresDuplicateDetection: false,
        requiresSession: false,
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
      });
      await pending.promise;
    });

    const state = useAppStore.getState();
    expect(state.explorerSelection.kind).toBe("none");
    expect(state.entityProperties).toBeNull();
    expect(state.entityPropertiesError).toBeNull();
    expect(state.entityPropertiesLoading).toBe(false);
  });

  it("retries the current selection when refreshEntityProperties is triggered", async () => {
    mockSafeInvoke
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        name: "queue-a",
        lockDuration: "PT1M",
        maxSizeInMegabytes: 1024,
        requiresDuplicateDetection: false,
        requiresSession: false,
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
      });

    renderHook(() => useEntityProperties());

    act(() => {
      useAppStore.getState().setExplorerQueue("queue-a");
    });

    await waitFor(() => {
      expect(useAppStore.getState().entityPropertiesError).toBe("Error: boom");
    });

    act(() => {
      useAppStore.getState().refreshEntityProperties();
    });

    await waitFor(() => {
      expect(useAppStore.getState().entityProperties).toEqual(
        expect.objectContaining({
          kind: "queue",
        })
      );
    });

    expect(mockSafeInvoke).toHaveBeenNthCalledWith(
      1,
      "get_queue_properties",
      expect.anything(),
      { args: { connectionId: CONN.id, queueName: "queue-a" } }
    );
    expect(mockSafeInvoke).toHaveBeenNthCalledWith(
      2,
      "get_queue_properties",
      expect.anything(),
      { args: { connectionId: CONN.id, queueName: "queue-a" } }
    );
  });
});
