import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutoRefresh } from "./useAutoRefresh";
import { useAppStore } from "../store/appStore";

const CONN = { id: "conn-1", name: "Test", connectionString: "sb://test.servicebus.windows.net/", env: {} };
const ENTITIES = { queues: ["q1", "q2"], topics: { t1: ["s1"] } };

beforeEach(() => {
  vi.useFakeTimers();
  useAppStore.setState(useAppStore.getInitialState());

  // Set up active connection and entities
  useAppStore.getState().setConnections([CONN]);
  useAppStore.getState().setActiveConnectionId(CONN.id);
  useAppStore.getState().setEntities(ENTITIES);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutoRefresh", () => {
  it("calls refreshAllCounts at the configured interval when enabled", () => {
    const refreshAllCounts = vi.fn();
    useAppStore.getState().setAutoRefreshEnabled(true);
    useAppStore.getState().setAutoRefreshInterval(15);

    renderHook(() => useAutoRefresh(refreshAllCounts));

    expect(refreshAllCounts).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(15_000); });
    expect(refreshAllCounts).toHaveBeenCalledTimes(1);

    // Simulate refresh lifecycle: loading goes up then back to 0
    act(() => { useAppStore.setState({ entityCountsLoading: 1 }); });
    act(() => { useAppStore.setState({ entityCountsLoading: 0 }); });

    act(() => { vi.advanceTimersByTime(15_000); });
    expect(refreshAllCounts).toHaveBeenCalledTimes(2);
  });

  it("does not poll when disabled", () => {
    const refreshAllCounts = vi.fn();
    useAppStore.getState().setAutoRefreshEnabled(false);

    renderHook(() => useAutoRefresh(refreshAllCounts));

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(refreshAllCounts).not.toHaveBeenCalled();
  });

  it("stops polling when disabled after being enabled", () => {
    const refreshAllCounts = vi.fn();
    useAppStore.getState().setAutoRefreshEnabled(true);
    useAppStore.getState().setAutoRefreshInterval(15);

    const { rerender } = renderHook(() => useAutoRefresh(refreshAllCounts));

    act(() => { vi.advanceTimersByTime(15_000); });
    expect(refreshAllCounts).toHaveBeenCalledTimes(1);

    // Disable auto-refresh
    act(() => { useAppStore.getState().setAutoRefreshEnabled(false); });
    rerender();

    act(() => { vi.advanceTimersByTime(30_000); });
    // Should still be 1, no more calls after disable
    expect(refreshAllCounts).toHaveBeenCalledTimes(1);
  });

  it("does not poll when there is no active connection", () => {
    const refreshAllCounts = vi.fn();
    useAppStore.getState().setAutoRefreshEnabled(true);
    useAppStore.getState().setActiveConnectionId(null);

    renderHook(() => useAutoRefresh(refreshAllCounts));

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(refreshAllCounts).not.toHaveBeenCalled();
  });

  it("does not poll when there are no entities", () => {
    const refreshAllCounts = vi.fn();
    useAppStore.getState().setAutoRefreshEnabled(true);
    useAppStore.getState().setEntities(null);

    renderHook(() => useAutoRefresh(refreshAllCounts));

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(refreshAllCounts).not.toHaveBeenCalled();
  });

  it("detects changed entities and sets changedEntities in store", () => {
    const refreshAllCounts = vi.fn();
    useAppStore.getState().setAutoRefreshEnabled(true);
    useAppStore.getState().setAutoRefreshInterval(15);

    // Set initial counts
    useAppStore.getState().batchSetCounts(
      [{ name: "q1", active: 5, dlq: 0 }, { name: "q2", active: 10, dlq: 1 }],
      [{ topic: "t1", subscription: "s1", active: 3, dlq: 0 }],
    );

    renderHook(() => useAutoRefresh(refreshAllCounts));

    // Trigger a refresh tick
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(refreshAllCounts).toHaveBeenCalledTimes(1);

    // Simulate in-flight requests (entityCountsLoading goes up)
    act(() => { useAppStore.setState({ entityCountsLoading: 3 }); });

    // Simulate counts changing (as if refreshAllCounts resolved)
    act(() => {
      useAppStore.getState().batchSetCounts(
        [{ name: "q1", active: 8, dlq: 0 }], // q1 changed
        [{ topic: "t1", subscription: "s1", active: 3, dlq: 2 }], // s1 changed
      );
    });

    // Signal completion by transitioning entityCountsLoading to 0
    act(() => { useAppStore.setState({ entityCountsLoading: 0 }); });

    const changed = useAppStore.getState().changedEntities;
    expect(changed).toContain("queue:q1");
    expect(changed).toContain("sub:t1/s1");
    // q2 did not change
    expect(changed).not.toContain("queue:q2");
  });

  it("auto-clears changedEntities after 2 seconds", () => {
    act(() => {
      useAppStore.getState().setChangedEntities(["queue:q1"]);
    });
    expect(useAppStore.getState().changedEntities).toEqual(["queue:q1"]);

    act(() => { vi.advanceTimersByTime(2000); });
    expect(useAppStore.getState().changedEntities).toEqual([]);
  });

  it("skips tick if previous refresh is still in-flight", () => {
    const refreshAllCounts = vi.fn();
    useAppStore.getState().setAutoRefreshEnabled(true);
    useAppStore.getState().setAutoRefreshInterval(15);

    // Set entityCountsLoading > 0 to simulate in-flight refresh
    useAppStore.setState({ entityCountsLoading: 5 });

    renderHook(() => useAutoRefresh(refreshAllCounts));

    // First tick
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(refreshAllCounts).toHaveBeenCalledTimes(1);

    // Second tick should be skipped because refreshInFlight is still true
    // (entityCountsLoading never went to 0)
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(refreshAllCounts).toHaveBeenCalledTimes(1);
  });
});
