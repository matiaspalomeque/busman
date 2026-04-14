import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useScript } from "./useScript";
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
  it("resolves with exitCode 0 and no errorMessage on success", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useScript());

    const opPromise = result.current.runOperation("peek_messages", { queue: "q1" });

    // Let the three listen() calls and the invoke() settle.
    await act(async () => {});

    expect(eventListeners.size).toBe(3);

    emit(`script-done:${RUN_ID}`, { exitCode: 0 });

    const outcome = await opPromise;

    expect(outcome.exitCode).toBe(0);
    expect(outcome.errorMessage).toBeUndefined();
    expect(useAppStore.getState().isRunning).toBe(false);
  });

  it("appends output lines to the store during the operation", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useScript());
    const opPromise = result.current.runOperation("peek_messages", {});

    await act(async () => {});

    emit(`script-output:${RUN_ID}`, { line: "line 1", isStderr: false, elapsedMs: 10 });
    emit(`script-output:${RUN_ID}`, { line: "stderr msg", isStderr: true, elapsedMs: 20 });
    emit(`script-done:${RUN_ID}`, { exitCode: 0 });

    await opPromise;

    const lines = useAppStore.getState().outputLines;
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("line 1");
    expect(lines[1].text).toBe("stderr msg");
    expect(lines[1].isStderr).toBe(true);
  });

  it("returns the last stderr line as errorMessage on non-zero exit", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useScript());
    const opPromise = result.current.runOperation("peek_messages", {});

    await act(async () => {});

    emit(`script-output:${RUN_ID}`, { line: "first error", isStderr: true, elapsedMs: 5 });
    emit(`script-output:${RUN_ID}`, { line: "fatal: timeout", isStderr: true, elapsedMs: 10 });
    emit(`script-done:${RUN_ID}`, { exitCode: 1 });

    const outcome = await opPromise;

    expect(outcome.exitCode).toBe(1);
    expect(outcome.errorMessage).toBe("fatal: timeout");
  });

  it("resolves with exitCode -1 when invoke throws before script-done fires", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Connection refused"));

    const { result } = renderHook(() => useScript());
    const opPromise = result.current.runOperation("peek_messages", {});

    // invoke rejects → resolveDone(-1) is called internally → no done event needed
    await act(async () => {});

    const outcome = await opPromise;

    expect(outcome.exitCode).toBe(-1);
    expect(outcome.errorMessage).toBe("Error: Connection refused");
    expect(useAppStore.getState().isRunning).toBe(false);
  });

  it("throws immediately when an operation is already running", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const { result } = renderHook(() => useScript());

    // Start first operation (don't await)
    result.current.runOperation("peek_messages", {});
    await act(async () => {}); // let setRunning(true) propagate to the ref via effect

    await expect(result.current.runOperation("peek_messages", {})).rejects.toThrow(
      "An operation is already running",
    );

    // Clean up the first operation
    emit(`script-done:${RUN_ID}`, { exitCode: 0 });
  });

  it("stop() invokes stop_current_operation with the active runId", async () => {
    mockInvoke.mockResolvedValue(undefined); // operation invoke + stop invoke

    const { result } = renderHook(() => useScript());

    const opPromise = result.current.runOperation("peek_messages", {});
    await act(async () => {});

    await act(async () => { await result.current.stop(); });

    expect(mockInvoke).toHaveBeenCalledWith("stop_current_operation", { runId: RUN_ID });

    // Complete the operation to avoid a hanging promise
    emit(`script-done:${RUN_ID}`, { exitCode: 130 });
    const outcome = await opPromise;
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

    const opPromise = result.current.runOperation("peek_messages", {});
    await act(async () => {});

    expect(mockListen).toHaveBeenCalledTimes(3);
    expect(mockListen).toHaveBeenCalledWith(`script-output:${RUN_ID}`, expect.any(Function));
    expect(mockListen).toHaveBeenCalledWith(`script-progress:${RUN_ID}`, expect.any(Function));
    expect(mockListen).toHaveBeenCalledWith(`script-done:${RUN_ID}`, expect.any(Function));

    emit(`script-done:${RUN_ID}`, { exitCode: 0 });
    await opPromise;
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
    const opPromise = result.current.runOperation("peek_messages", {});
    await act(async () => {});

    emit(`script-done:${RUN_ID}`, { exitCode: 0 });
    await opPromise;

    expect(unlistenFns).toHaveLength(3);
    unlistenFns.forEach((fn) => expect(fn).toHaveBeenCalledOnce());
  });

  it("sets isRunning=true during the operation and false after", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useScript());

    const opPromise = result.current.runOperation("peek_messages", {});
    await act(async () => {});

    await waitFor(() => expect(useAppStore.getState().isRunning).toBe(true));

    emit(`script-done:${RUN_ID}`, { exitCode: 0 });
    await opPromise;

    expect(useAppStore.getState().isRunning).toBe(false);
  });
});
