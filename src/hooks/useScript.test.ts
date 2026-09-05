import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { OPERATION_INACTIVITY_MS, useScript } from "./useScript";
import { useAppStore } from "../store/appStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventCallback } from "@tauri-apps/api/event";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

/** A deterministic UUID used across all tests. */
const RUN_ID = "00000000-0000-0000-0000-000000000001";

type ListenCallback = EventCallback<unknown>;
type OpResult = { exitCode: number; errorMessage?: string };

let eventListeners: Map<string, ListenCallback>;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();

  eventListeners = new Map();

  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    RUN_ID as `${string}-${string}-${string}-${string}-${string}`,
  );

  mockListen.mockImplementation(async (eventName: string, cb: ListenCallback) => {
    eventListeners.set(eventName as string, cb);
    return vi.fn() as unknown as () => void;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Fires a registered Tauri event with the given payload. */
function emit(eventName: string, payload: unknown) {
  const cb = eventListeners.get(eventName);
  if (!cb) throw new Error(`No listener registered for "${eventName}"`);
  cb({ event: eventName, id: 0, payload });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("useScript", () => {
  it("records the source of a single resend for later return detection", async () => {
    const state = useAppStore.getState();
    state.addEventLogEntry({ id: RUN_ID, time: new Date().toISOString(), namespace: "test", entity: "orders #1", entityType: "Queue", operation: "ReplayMessage", status: "running" });
    mockInvoke.mockResolvedValue({ exitCode: 0 });
    const { result } = renderHook(() => useScript());
    await act(async () => { await result.current.runOperation("single_message_action", {
      action: "replay", connectionId: "conn-1", queueName: "orders", destQueue: "orders", isDlq: true, sequenceNumber: "1",
    }, { scope: "atomic", runId: RUN_ID }); });
    expect(useAppStore.getState().eventLog[0].scope).toEqual({ connectionId: "conn-1", mode: "dlq", destination: "orders", replaySource: '["queue","orders"]' });
  });

  it("keeps single-message uncertainty visible and allows Stop after navigation", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementationOnce(() => new Promise(() => {}));
    const store = useAppStore.getState();
    store.setExplorerQueue("orders");
    const { result } = renderHook(() => useScript());
    const params = { connectionId: "conn-1", queueName: "orders", sequenceNumber: "9007199254740993", isDlq: true };
    let pending!: Promise<OpResult>;
    await act(async () => { pending = result.current.runOperation("single_message_action", params, { scope: "atomic", runId: RUN_ID }); });
    act(() => { store.setExplorerQueue("billing"); });
    await expect(result.current.runOperation("single_message_action", params, { scope: "atomic", runId: "other" })).rejects.toThrow("this message");
    await act(async () => { vi.advanceTimersByTime(OPERATION_INACTIVITY_MS + 1); });
    expect(useAppStore.getState().activeOperationRuns[RUN_ID]).toMatchObject({ phase: "unknown", error: expect.stringContaining("Outcome unknown") });
    await expect(result.current.runOperation("single_message_action", { ...params, sequenceNumber: "2" }, { scope: "atomic", runId: "other" })).rejects.toThrow("unknown outcome");
    mockInvoke.mockResolvedValueOnce(undefined);
    await act(async () => { await result.current.stop(RUN_ID); });
    expect(mockInvoke).toHaveBeenLastCalledWith("stop_current_operation", { runId: RUN_ID });
    expect(useAppStore.getState().activeOperationRuns[RUN_ID].phase).toBe("stopRequested");
    await act(async () => { emit(`script-done:${RUN_ID}`, { exitCode: 130 }); await pending; });
    expect(useAppStore.getState().activeOperationRuns[RUN_ID]).toBeUndefined();
  });

  it("saves throttled progress checkpoints for interrupted-history recovery", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementationOnce(() => new Promise(() => {}));
    const store = useAppStore.getState();
    store.addEventLogEntry({ id: RUN_ID, time: new Date().toISOString(), namespace: "demo", entity: "orders", entityType: "Queue", operation: "Move", status: "running" });
    const { result } = renderHook(() => useScript());
    let pending!: Promise<OpResult>;
    await act(async () => { pending = result.current.runOperation("move_messages", {}); });
    const counts = { sent: 3, settled: 2, sendUnconfirmed: 0, settlementUnconfirmed: 1, sources: {} };
    await act(async () => { emit(`script-progress:${RUN_ID}`, { text: "", heartbeat: true, elapsedMs: 0, counts }); });
    expect(useAppStore.getState().eventLog[0].checkpoint?.counts.sent).toBe(3);
    await act(async () => { emit(`script-progress:${RUN_ID}`, { text: "", elapsedMs: 100, counts: { ...counts, sent: 4 } }); });
    expect(useAppStore.getState().eventLog[0].checkpoint?.counts.sent).toBe(3);
    await act(async () => { vi.advanceTimersByTime(5000); emit(`script-progress:${RUN_ID}`, { text: "", elapsedMs: 5000, counts: { ...counts, sent: 5 } }); });
    expect(useAppStore.getState().eventLog[0].checkpoint?.counts.sent).toBe(5);
    await act(async () => { emit(`script-done:${RUN_ID}`, { exitCode: 130 }); await pending; });
  });

  it("retains atomic ownership across navigation and ignores late changes to another view", async () => {
    mockInvoke.mockImplementationOnce(() => new Promise(() => {}));
    const store = useAppStore.getState();
    store.setExplorerQueue("orders");
    const { result } = renderHook(() => useScript());
    let pending!: Promise<OpResult & { contextCurrent?: boolean }>;
    await act(async () => { pending = result.current.runOperation("single_message_action", { queueName: "orders" }, { scope: "atomic", runId: RUN_ID }); });
    act(() => { store.setExplorerQueue("billing"); });
    await expect(result.current.runOperation("move_messages", {})).rejects.toThrow("Wait for message operations");
    await act(async () => { emit(`script-done:${RUN_ID}`, { exitCode: 0 }); });
    expect((await pending).contextCurrent).toBe(false);
    expect(Object.keys(useAppStore.getState().activeOperationRuns)).toHaveLength(0);
  });

  it("requires review of a prior unknown outcome before another operation", async () => {
    useAppStore.getState().addEventLogEntry({ id: "unknown", time: new Date().toISOString(), namespace: "demo", entity: "orders", entityType: "Queue", operation: "Move", status: "unknown", scope: { connectionId: "conn-1", mode: "dlq", destination: "dest" } });
    const { result } = renderHook(() => useScript());
    await expect(result.current.runOperation("move_messages", { connectionId: "conn-1" })).rejects.toThrow("unknown outcome");
    act(() => { useAppStore.getState().reconcileOperation("unknown"); });
    mockInvoke.mockResolvedValueOnce({ exitCode: 0, elapsedMs: 1 });
    await act(async () => { expect((await result.current.runOperation("move_messages", { connectionId: "conn-1" })).exitCode).toBe(0); });
    expect(useAppStore.getState().eventLog.find((entry) => entry.id === "unknown")?.status).toBe("unknown");
  });

  it("settles from the command response when the completion event is lost", async () => {
    mockInvoke.mockResolvedValueOnce({ exitCode: 130, elapsedMs: 50 });
    const { result } = renderHook(() => useScript());
    let outcome!: OpResult;
    await act(async () => { outcome = await result.current.runOperation("move_messages", {}); });
    expect(outcome.exitCode).toBe(130);
    expect(useAppStore.getState().isRunning).toBe(false);
  });

  it("settles from an authoritative event even if the command response never arrives", async () => {
    mockInvoke.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useScript());
    let pending!: Promise<OpResult>;
    await act(async () => { pending = result.current.runOperation("move_messages", {}); });
    await act(async () => { emit(`script-done:${RUN_ID}`, { exitCode: 0 }); await pending; });
    expect(useAppStore.getState().isRunning).toBe(false);
  });

  it("reports an unobserved outcome without unlocking another destructive operation", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useScript());
    let pending!: Promise<OpResult>;
    await act(async () => { pending = result.current.runOperation("move_messages", {}); });
    await act(async () => { vi.advanceTimersByTime(OPERATION_INACTIVITY_MS + 1); });
    expect(useAppStore.getState().operationPhase).toBe("unknown");
    expect(useAppStore.getState().isRunning).toBe(true);
    await expect(result.current.runOperation("empty_messages", {})).rejects.toThrow("unknown outcome");
    await act(async () => { emit(`script-done:${RUN_ID}`, { exitCode: 130 }); await pending; });
  });

  it("keeps a healthy transfer running beyond the old 30-minute limit", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useScript());
    let pending!: Promise<OpResult>;
    await act(async () => { pending = result.current.runOperation("move_messages", {}); });
    for (let minute = 0; minute < 35; minute++) await act(async () => {
      vi.advanceTimersByTime(60_000);
      emit(`script-progress:${RUN_ID}`, { heartbeat: true, text: "", elapsedMs: minute * 60_000 });
    });
    expect(useAppStore.getState().operationPhase).toBe("running");
    expect(useAppStore.getState().operationError).toBeNull();
    await act(async () => { emit(`script-done:${RUN_ID}`, { exitCode: 0 }); await pending; });
  });

  it("shows cancellation rejection and keeps the operation locked", async () => {
    mockInvoke.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useScript());
    let pending!: Promise<OpResult>;
    await act(async () => { pending = result.current.runOperation("move_messages", {}); });
    mockInvoke.mockRejectedValueOnce(new Error("worker did not stop"));
    await act(async () => { await result.current.stop(); });
    expect(useAppStore.getState().operationError).toContain("Stop failed");
    expect(useAppStore.getState().isRunning).toBe(true);
    await act(async () => { emit(`script-done:${RUN_ID}`, { exitCode: 130 }); await pending; });
  });

  it("releases listeners when a later listener registration fails before dispatch", async () => {
    const unlisten = vi.fn();
    mockListen.mockResolvedValueOnce(unlisten).mockRejectedValueOnce(new Error("event bridge unavailable"));
    const { result } = renderHook(() => useScript());
    await act(async () => { await result.current.runOperation("move_messages", {}); });
    expect(unlisten).toHaveBeenCalledOnce();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("resolves with exitCode 0 and no errorMessage on success", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useScript());

    // Wrap the initial call so clearOutput() + setRunning(true) fire inside act.
    let opPromise!: Promise<OpResult>;
    await act(async () => { opPromise = result.current.runOperation("peek_messages", { queue: "q1" }); });

    // Let the three listen() calls and the invoke() settle.
    await act(async () => {});

    expect(eventListeners.size).toBe(3);

    let outcome!: OpResult;
    await act(async () => {
      emit(`script-done:${RUN_ID}`, { exitCode: 0 });
      outcome = await opPromise;
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.errorMessage).toBeUndefined();
    expect(useAppStore.getState().isRunning).toBe(false);
  });

  it("appends output lines to the store during the operation", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useScript());
    let opPromise!: Promise<OpResult>;
    await act(async () => { opPromise = result.current.runOperation("peek_messages", {}); });
    await act(async () => {});

    await act(async () => {
      emit(`script-output:${RUN_ID}`, { line: "line 1", isStderr: false, elapsedMs: 10 });
      emit(`script-output:${RUN_ID}`, { line: "stderr msg", isStderr: true, elapsedMs: 20 });
      emit(`script-done:${RUN_ID}`, { exitCode: 0 });
      await opPromise;
    });

    const lines = useAppStore.getState().outputLines;
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("line 1");
    expect(lines[1].text).toBe("stderr msg");
    expect(lines[1].isStderr).toBe(true);
  });

  it("returns the last stderr line as errorMessage on non-zero exit", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useScript());
    let opPromise!: Promise<OpResult>;
    await act(async () => { opPromise = result.current.runOperation("peek_messages", {}); });
    await act(async () => {});

    let outcome!: OpResult;
    await act(async () => {
      emit(`script-output:${RUN_ID}`, { line: "first error", isStderr: true, elapsedMs: 5 });
      emit(`script-output:${RUN_ID}`, { line: "fatal: timeout", isStderr: true, elapsedMs: 10 });
      emit(`script-done:${RUN_ID}`, { exitCode: 1 });
      outcome = await opPromise;
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.errorMessage).toBe("fatal: timeout");
  });

  it("resolves with exitCode -1 when invoke throws before script-done fires", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Connection refused"));

    const { result } = renderHook(() => useScript());
    let opPromise!: Promise<OpResult>;
    await act(async () => { opPromise = result.current.runOperation("peek_messages", {}); });

    // invoke rejects → resolveDone(-1) is called internally → no done event needed
    let outcome!: OpResult;
    await act(async () => { outcome = await opPromise; });

    expect(outcome.exitCode).toBe(-1);
    expect(outcome.errorMessage).toBe("Error: Connection refused");
    expect(useAppStore.getState().isRunning).toBe(false);
  });

  it("throws immediately when an operation is already running", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const { result } = renderHook(() => useScript());

    // Start first operation inside act so setRunning(true) fires inside act.
    let firstOp!: Promise<OpResult>;
    await act(async () => { firstOp = result.current.runOperation("peek_messages", {}); });
    await act(async () => {}); // let setRunning(true) propagate to the ref via effect

    await expect(result.current.runOperation("peek_messages", {})).rejects.toThrow(
      "An operation is already running",
    );

    // Clean up the first operation
    await act(async () => {
      emit(`script-done:${RUN_ID}`, { exitCode: 0 });
      await firstOp;
    });
  });

  it("allows multiple atomic operations to run and settle independently", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const { result } = renderHook(() => useScript());

    let firstOp!: Promise<OpResult>;
    let secondOp!: Promise<OpResult>;
    await act(async () => {
      firstOp = result.current.runOperation(
        "single_message_action",
        { action: "delete" },
        { scope: "atomic", runId: "atomic-1" },
      );
      secondOp = result.current.runOperation(
        "single_message_action",
        { action: "replay" },
        { scope: "atomic", runId: "atomic-2" },
      );
    });
    await act(async () => {});

    expect(useAppStore.getState().isRunning).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenCalledWith("single_message_action", {
      args: { action: "delete", runId: "atomic-1" },
    });
    expect(mockInvoke).toHaveBeenCalledWith("single_message_action", {
      args: { action: "replay", runId: "atomic-2" },
    });
    expect(mockListen).toHaveBeenCalledTimes(6);

    let secondOutcome!: OpResult;
    await act(async () => {
      emit("script-done:atomic-2", { exitCode: 0 });
      secondOutcome = await secondOp;
    });
    expect(secondOutcome.exitCode).toBe(0);

    let firstOutcome!: OpResult;
    await act(async () => {
      emit("script-output:atomic-1", { line: "fatal", isStderr: true, elapsedMs: 10 });
      emit("script-done:atomic-1", { exitCode: 1 });
      firstOutcome = await firstOp;
    });
    expect(firstOutcome).toEqual({ exitCode: 1, errorMessage: "fatal" });
  });

  it("rejects atomic operations while a bulk operation is running", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const { result } = renderHook(() => useScript());

    let bulkOp!: Promise<OpResult>;
    await act(async () => {
      bulkOp = result.current.runOperation("move_messages", {});
    });
    await act(async () => {});

    await expect(
      result.current.runOperation("single_message_action", {}, { scope: "atomic" }),
    ).rejects.toThrow("An operation is already running");

    await act(async () => {
      emit(`script-done:${RUN_ID}`, { exitCode: 0 });
      await bulkOp;
    });
  });

  it("rejects bulk operations while atomic message work is pending", async () => {
    useAppStore.getState().startMessageOperation("deadLetter\0message-1", {
      runId: "atomic-1",
      operation: "ReplayMessage",
      startedAt: new Date().toISOString(),
    });
    const { result } = renderHook(() => useScript());

    await expect(result.current.runOperation("move_messages", {})).rejects.toThrow(
      "Wait for message operations to finish",
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("stop() invokes stop_current_operation with the active runId", async () => {
    mockInvoke.mockResolvedValue(undefined); // operation invoke + stop invoke

    const { result } = renderHook(() => useScript());

    let opPromise!: Promise<OpResult>;
    await act(async () => { opPromise = result.current.runOperation("peek_messages", {}); });
    await act(async () => {});

    await act(async () => { await result.current.stop(); });

    expect(mockInvoke).toHaveBeenCalledWith("stop_current_operation", { runId: RUN_ID });

    // Complete the operation to avoid a hanging promise
    let outcome!: OpResult;
    await act(async () => {
      emit(`script-done:${RUN_ID}`, { exitCode: 130 });
      outcome = await opPromise;
    });
    expect(outcome.exitCode).toBe(130);
  });

  it("stop() is a no-op when no operation is running", async () => {
    const { result } = renderHook(() => useScript());

    await act(async () => { await result.current.stop(); });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "stop_current_operation",
      expect.anything(),
    );
  });

  it("registers three event listeners per operation", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useScript());

    let opPromise!: Promise<OpResult>;
    await act(async () => { opPromise = result.current.runOperation("peek_messages", {}); });
    await act(async () => {});

    expect(mockListen).toHaveBeenCalledTimes(3);
    expect(mockListen).toHaveBeenCalledWith(`script-output:${RUN_ID}`, expect.any(Function));
    expect(mockListen).toHaveBeenCalledWith(`script-progress:${RUN_ID}`, expect.any(Function));
    expect(mockListen).toHaveBeenCalledWith(`script-done:${RUN_ID}`, expect.any(Function));

    await act(async () => {
      emit(`script-done:${RUN_ID}`, { exitCode: 0 });
      await opPromise;
    });
  });

  it("calls unlisten for all listeners after the operation completes", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const unlistenFns: ReturnType<typeof vi.fn>[] = [];

    mockListen.mockImplementation(async (name: string, cb: EventCallback<unknown>) => {
      eventListeners.set(name as string, cb);
      const unlisten = vi.fn() as unknown as () => void;
      unlistenFns.push(unlisten as ReturnType<typeof vi.fn>);
      return unlisten;
    });

    const { result } = renderHook(() => useScript());
    let opPromise!: Promise<OpResult>;
    await act(async () => { opPromise = result.current.runOperation("peek_messages", {}); });
    await act(async () => {});

    await act(async () => {
      emit(`script-done:${RUN_ID}`, { exitCode: 0 });
      await opPromise;
    });

    expect(unlistenFns).toHaveLength(3);
    unlistenFns.forEach((fn) => expect(fn).toHaveBeenCalledOnce());
  });

  it("sets isRunning=true during the operation and false after", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useScript());

    let opPromise!: Promise<OpResult>;
    await act(async () => { opPromise = result.current.runOperation("peek_messages", {}); });
    await act(async () => {});

    await waitFor(() => expect(useAppStore.getState().isRunning).toBe(true));

    await act(async () => {
      emit(`script-done:${RUN_ID}`, { exitCode: 0 });
      await opPromise;
    });

    expect(useAppStore.getState().isRunning).toBe(false);
  });
});
