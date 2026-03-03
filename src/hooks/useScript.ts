import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import type { ScriptOutputEvent, ScriptProgressEvent, ScriptDoneEvent } from "../types";

export function useScript() {
  const { isRunning, setRunning, appendOutputLine, setProgress, clearOutput } =
    useAppStore();

  // Track whether an operation is running via ref so the callback stays stable.
  const isRunningRef = useRef(isRunning);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  // Track the active runId so stop() can reference it without being recreated.
  const activeRunIdRef = useRef<string | null>(null);

  // Store active unlisten functions so they can be cleaned up if the component unmounts.
  const unlistenersRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    return () => {
      unlistenersRef.current.forEach((fn) => fn());
      unlistenersRef.current = [];
    };
  }, []);

  const runOperation = useCallback(
    async (
      command: string,
      params: Record<string, unknown>
    ): Promise<number> => {
      if (isRunningRef.current) throw new Error("An operation is already running");

      clearOutput();
      const runId = crypto.randomUUID();
      activeRunIdRef.current = runId;
      setRunning(true, runId);

      let resolveDone: (code: number) => void = () => {};
      const exitCodePromise = new Promise<number>((resolve) => {
        resolveDone = resolve;
      });

      // Set up all listeners BEFORE invoking to avoid race conditions.
      const [unlistenOutput, unlistenProgress, unlistenDone] = await Promise.all([
        listen<ScriptOutputEvent>(`script-output:${runId}`, (ev) => {
          appendOutputLine(ev.payload.line, ev.payload.isStderr, ev.payload.elapsedMs);
        }),
        listen<ScriptProgressEvent>(`script-progress:${runId}`, (ev) => {
          setProgress({ text: ev.payload.text, elapsedMs: ev.payload.elapsedMs });
        }),
        listen<ScriptDoneEvent>(`script-done:${runId}`, (ev) => {
          resolveDone(ev.payload.exitCode);
        }),
      ]);

      // Register for cleanup-on-unmount.
      unlistenersRef.current = [unlistenOutput, unlistenProgress, unlistenDone];

      try {
        await invoke(command, {
          args: { ...params, runId },
        });
      } catch (e: unknown) {
        appendOutputLine(`Error: ${String(e)}`, true, 0);
        // If backend returns an error before emitting script-done,
        // resolve locally to avoid leaving the UI in a running state.
        resolveDone(-1);
      }

      // Wait for the done event.
      const code = await exitCodePromise;

      unlistenOutput();
      unlistenProgress();
      unlistenDone();
      unlistenersRef.current = [];
      activeRunIdRef.current = null;
      setRunning(false);

      return code;
    },
    // isRunning intentionally omitted — read via ref to keep the callback stable.
    [setRunning, appendOutputLine, setProgress, clearOutput]
  );

  // Kill the in-flight worker. The Rust layer emits script-done with exit code 130.
  const stop = useCallback(async () => {
    const runId = activeRunIdRef.current;
    if (!isRunningRef.current || !runId) return;
    try {
      await invoke("stop_current_operation", { runId });
    } catch {
      // Non-fatal: the UI will still settle when script-done arrives (or won't if kill failed).
    }
  }, []);

  return { runOperation, isRunning, stop };
}
