import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import type { ScriptOutputEvent, ScriptProgressEvent, ScriptDoneEvent } from "../types";
import { logHandledError } from "../utils/logging";

const SCRIPT_DONE_TIMEOUT_MS = 30 * 60 * 1000;

export function useScript() {
  const { isRunning, runId: storeRunId, setRunning, appendOutputLine, setProgress, clearOutput } =
    useAppStore();

  // Track whether an operation is running via ref so the callback stays stable.
  const isRunningRef = useRef(isRunning);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  // Track active runIds owned by this hook instance without forcing rerenders.
  const activeRunIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    return () => {
      // In-flight operations clean up their own listeners in finally blocks.
      activeRunIdsRef.current.clear();
    };
  }, []);

  const runOperation = useCallback(
    async (
      command: string,
      params: Record<string, unknown>,
      options?: { scope?: "atomic" | "bulk"; runId?: string }
    ): Promise<{ exitCode: number; errorMessage?: string }> => {
      const scope = options?.scope ?? "bulk";
      const operationState = useAppStore.getState();
      if (operationState.isRunning) throw new Error("An operation is already running");
      if (scope === "bulk" && Object.keys(operationState.pendingMessageOperations).length > 0) {
        throw new Error("Wait for message operations to finish before starting a bulk operation");
      }

      const runId =
        options?.runId ??
        (typeof params.runId === "string" ? params.runId : crypto.randomUUID());
      activeRunIdsRef.current.add(runId);
      if (scope === "bulk") {
        clearOutput();
        setRunning(true, runId, scope);
      }

      let lastStderrLine = "";
      let watchdogId: ReturnType<typeof setTimeout> | null = null;
      let unlisteners: Array<() => void> = [];

      let resolveDone: (code: number) => void = () => {};
      const exitCodePromise = new Promise<number>((resolve) => {
        let settled = false;
        resolveDone = (code: number) => {
          if (settled) return;
          settled = true;
          resolve(code);
        };
        watchdogId = setTimeout(() => {
          const msg = "Operation timed out waiting for completion event";
          appendOutputLine(`Error: ${msg}`, true, 0);
          lastStderrLine = msg;
          resolveDone(-1);
        }, SCRIPT_DONE_TIMEOUT_MS);
      });

      try {
        // Set up all listeners BEFORE invoking to avoid race conditions.
        unlisteners = await Promise.all([
          listen<ScriptOutputEvent>(`script-output:${runId}`, (ev) => {
            appendOutputLine(ev.payload.line, ev.payload.isStderr, ev.payload.elapsedMs);
            if (ev.payload.isStderr && ev.payload.line.trim()) {
              lastStderrLine = ev.payload.line.trim();
            }
          }),
          listen<ScriptProgressEvent>(`script-progress:${runId}`, (ev) => {
            if (scope === "bulk") {
              setProgress({ text: ev.payload.text, elapsedMs: ev.payload.elapsedMs });
            }
          }),
          listen<ScriptDoneEvent>(`script-done:${runId}`, (ev) => {
            resolveDone(ev.payload.exitCode);
          }),
        ]);

        try {
          await invoke(command, {
            args: { ...params, runId },
          });
        } catch (e: unknown) {
          const errMsg = String(e);
          logHandledError(`Operation command failed: ${command}`, e, { command, runId, scope });
          appendOutputLine(`Error: ${errMsg}`, true, 0);
          lastStderrLine = errMsg;
          // If backend returns an error before emitting script-done,
          // resolve locally to avoid leaving the UI in a running state.
          resolveDone(-1);
        }

        // Wait for the done event.
        const code = await exitCodePromise;

        return {
          exitCode: code,
          errorMessage: code !== 0 && lastStderrLine ? lastStderrLine : undefined,
        };
      } catch (e: unknown) {
        const errMsg = String(e);
        logHandledError(`Operation failed before completion: ${command}`, e, { command, runId, scope });
        appendOutputLine(`Error: ${errMsg}`, true, 0);
        return { exitCode: -1, errorMessage: errMsg };
      } finally {
        if (watchdogId !== null) clearTimeout(watchdogId);
        unlisteners.forEach((fn) => fn());
        activeRunIdsRef.current.delete(runId);
        if (scope === "bulk") {
          setRunning(false);
        }
      }
    },
    // isRunning intentionally omitted — read via ref to keep the callback stable.
    [setRunning, appendOutputLine, setProgress, clearOutput]
  );

  // Ask the worker to cancel only the active run. The operation command emits
  // script-done with exit code 130 after the worker acknowledges cancellation.
  const stop = useCallback(async () => {
    // The store's runId tracks the current bulk operation so any hook instance
    // (e.g. Toolbar) can stop
    // an operation started by a different instance (e.g. MoveMessagesModal).
    const runId = storeRunId;
    if (!isRunningRef.current || !runId) return;
    try {
      await invoke("stop_current_operation", { runId });
    } catch (error) {
      logHandledError("Failed to stop current operation", error, { runId });
      // Non-fatal: the UI will still settle when script-done arrives (or won't if kill failed).
    }
  }, [storeRunId]);

  return { runOperation, isRunning, stop };
}
