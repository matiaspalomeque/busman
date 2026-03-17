import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useEntityList } from "./useEntityList";
import { useAppStore } from "../store/appStore";

// Mock safeInvoke so we don't hit the Tauri bridge
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

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();

  // Set up an active connection so the hook has a connId to work with
  useAppStore.getState().setConnections([CONN]);
  useAppStore.getState().setActiveConnectionId(CONN.id);

  // Prevent fetchEntities from firing (list_entities not under test here)
  mockSafeInvoke.mockResolvedValue({ queues: [], topics: {} });
});

describe("useEntityList.refreshEntityCount", () => {
  it("calls get_queue_count and updates queue count in store", async () => {
    mockSafeInvoke.mockResolvedValueOnce({ queues: [], topics: {} }); // fetchEntities on mount
    mockSafeInvoke.mockResolvedValueOnce({ name: "my-queue", active: 42, dlq: 3 }); // refreshEntityCount

    const { result } = renderHook(() => useEntityList());

    await act(async () => {
      await result.current.refreshEntityCount({ type: "queue", name: "my-queue" });
    });

    expect(mockSafeInvoke).toHaveBeenCalledWith(
      "get_queue_count",
      expect.anything(),
      { args: { connectionId: CONN.id, queueName: "my-queue" } }
    );

    const queueCounts = useAppStore.getState().queueCounts;
    expect(queueCounts["my-queue"]).toEqual({ active: 42, dlq: 3 });
  });

  it("calls get_subscription_count and updates subscription count in store", async () => {
    mockSafeInvoke.mockResolvedValueOnce({ queues: [], topics: {} }); // fetchEntities on mount
    mockSafeInvoke.mockResolvedValueOnce({ topic: "my-topic", subscription: "my-sub", active: 7, dlq: 0 });

    const { result } = renderHook(() => useEntityList());

    await act(async () => {
      await result.current.refreshEntityCount({ type: "subscription", topicName: "my-topic", subscriptionName: "my-sub" });
    });

    expect(mockSafeInvoke).toHaveBeenCalledWith(
      "get_subscription_count",
      expect.anything(),
      { args: { connectionId: CONN.id, topicName: "my-topic", subscriptionName: "my-sub" } }
    );

    const subscriptionCounts = useAppStore.getState().subscriptionCounts;
    // store uses SUBSCRIPTION_KEY_SEP ("\0") as separator
    const key = Object.keys(subscriptionCounts).find((k) => k.includes("my-topic") && k.includes("my-sub"));
    expect(key).toBeDefined();
    expect(subscriptionCounts[key!]).toEqual({ active: 7, dlq: 0 });
  });

  it("does not throw when safeInvoke rejects, just logs a warning", async () => {
    mockSafeInvoke.mockResolvedValueOnce({ queues: [], topics: {} }); // fetchEntities on mount
    mockSafeInvoke.mockRejectedValueOnce(new Error("network error"));

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useEntityList());

    await act(async () => {
      await expect(result.current.refreshEntityCount({ type: "queue", name: "bad-queue" })).resolves.toBeUndefined();
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[refreshEntityCount]"), expect.any(Error));
    consoleSpy.mockRestore();
  });

  it("does nothing when there is no active connection", async () => {
    useAppStore.setState(useAppStore.getInitialState()); // clear connection
    vi.clearAllMocks();

    const { result } = renderHook(() => useEntityList());

    await act(async () => {
      await result.current.refreshEntityCount({ type: "queue", name: "q1" });
    });

    // safeInvoke should never be called for refreshEntityCount (no fetchEntities either since conn is null)
    expect(mockSafeInvoke).not.toHaveBeenCalledWith("get_queue_count", expect.anything(), expect.anything());
  });
});
