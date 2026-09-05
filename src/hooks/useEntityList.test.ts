import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
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
  it.each([false, true])("does not overwrite a newer refresh (separate consumer: %s)", async (separateConsumer) => {
    const pending: Array<(value: unknown) => void> = [];
    mockSafeInvoke.mockImplementation((command) => command === "get_queue_count"
      ? new Promise((resolve) => pending.push(resolve)) as ReturnType<typeof safeInvoke>
      : Promise.resolve({ queues: [], topics: {} }) as ReturnType<typeof safeInvoke>);
    const { result } = renderHook(() => useEntityList());
    const other = renderHook(() => useEntityList());
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = result.current.refreshEntityCount({ type: "queue", name: "orders" }); second = (separateConsumer ? other.result : result).current.refreshEntityCount({ type: "queue", name: "orders" }); });
    await act(async () => { pending[1]({ name: "orders", active: 7, dlq: 0 }); await second; });
    await act(async () => { pending[0]({ name: "orders", active: 999, dlq: 0 }); await first; });
    expect(useAppStore.getState().queueCounts.orders.active).toBe(7);
  });

  it.each([false, true])("ignores delayed counts across connection changes (return to A: %s)", async (returnToA) => {
    const other = { ...CONN, id: "conn-2" };
    useAppStore.getState().setConnections([CONN, other]);
    let resolveCount!: (value: unknown) => void;
    mockSafeInvoke.mockImplementation((command) => command === "get_queue_count"
      ? new Promise((resolve) => { resolveCount = resolve; }) as ReturnType<typeof safeInvoke>
      : Promise.resolve({ queues: [], topics: {} }) as ReturnType<typeof safeInvoke>);
    const { result } = renderHook(() => useEntityList());
    let request!: Promise<void>;
    act(() => { request = result.current.refreshEntityCount({ type: "queue", name: "orders" }); });
    await act(async () => { useAppStore.getState().setActiveConnectionId(other.id); });
    if (returnToA) await act(async () => { useAppStore.getState().setActiveConnectionId(CONN.id); });
    act(() => { useAppStore.getState().batchSetCounts([{ name: "orders", active: 7, dlq: 0 }], []); });
    await act(async () => { resolveCount({ name: "orders", active: 999, dlq: 0 }); await request; });
    expect(useAppStore.getState().queueCounts.orders.active).toBe(7);
  });

  it("retains the last count with a failure status and clears it after retry", async () => {
    const { result } = renderHook(() => useEntityList());
    await act(async () => {});
    useAppStore.getState().batchSetCounts([{ name: "orders", active: 7, dlq: 0 }], []);
    mockSafeInvoke.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await result.current.refreshEntityCount({ type: "queue", name: "orders" }); });
    expect(useAppStore.getState().queueCounts.orders.active).toBe(7);
    expect(useAppStore.getState().countRefresh["queue:orders"].error).toContain("offline");
    mockSafeInvoke.mockResolvedValueOnce({ name: "orders", active: 8, dlq: 0 });
    await act(async () => { await result.current.refreshEntityCount({ type: "queue", name: "orders" }); });
    expect(useAppStore.getState().countRefresh["queue:orders"].error).toBeUndefined();
    expect(useAppStore.getState().countRefresh["queue:orders"].updatedAt).toBeTruthy();
  });

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

describe("useEntityList entity count batching", () => {
  it("loads all queue and topic counts through one bounded backend request", async () => {
    mockSafeInvoke.mockResolvedValueOnce({ queues: ["orders"], topics: { billing: ["processor"] } });
    mockSafeInvoke.mockResolvedValueOnce({
      queues: [{ name: "orders", active: 12, dlq: 1 }],
      subscriptions: [{ topic: "billing", subscription: "processor", active: 4, dlq: 2 }],
      errors: [],
    });

    renderHook(() => useEntityList());

    await waitFor(() => {
      expect(useAppStore.getState().queueCounts.orders).toEqual({ active: 12, dlq: 1 });
    });
    expect(mockSafeInvoke).toHaveBeenCalledWith(
      "get_entity_counts",
      expect.anything(),
      { args: { connectionId: CONN.id, queueNames: ["orders"], topicNames: ["billing"] } }
    );
    expect(mockSafeInvoke).toHaveBeenCalledTimes(2);
  });

  it("skips overlapping full count refreshes", async () => {
    mockSafeInvoke.mockResolvedValueOnce({ queues: [], topics: {} });
    const { result } = renderHook(() => useEntityList());
    await waitFor(() => expect(mockSafeInvoke).toHaveBeenCalledTimes(1));

    useAppStore.getState().setEntities({ queues: ["orders"], topics: {} });
    mockSafeInvoke.mockImplementationOnce(() => new Promise(() => {}));

    let first!: boolean;
    let second!: boolean;
    act(() => {
      first = result.current.refreshAllCounts();
      second = result.current.refreshAllCounts();
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(mockSafeInvoke).toHaveBeenCalledTimes(2);
  });
});
