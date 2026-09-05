import { OperationCountsSchema, OperationOutcomeSchema } from "../schemas/operation";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback } from "react";
import { useAppStore } from "../store/appStore";
import type { ScriptOutputEvent, ScriptProgressEvent, ScriptDoneEvent } from "../types";
import { logHandledError } from "../utils/logging";
import { replaySourceKey } from "../utils/messageOperation";

// Inactivity is a loss of observation, never proof that broker work stopped.
export const OPERATION_INACTIVITY_MS = 90_000;

export function useScript() {
  const isRunning = useAppStore((state) => state.isRunning);
  const runOperation = useCallback(async (
    command: string,
    params: Record<string, unknown>,
    options?: { scope?: "atomic" | "bulk"; runId?: string },
  ): Promise<{ exitCode: number; errorMessage?: string; result?: unknown; contextCurrent?: boolean }> => {
    const scope = options?.scope ?? "bulk";
    const state = useAppStore.getState();
    const generation = state.connectionGeneration;
    const destructive = ["move_messages", "empty_messages", "republish_subscription_dlq", "single_message_action"].includes(command);
    if (destructive && Object.values(state.activeOperationRuns).some((run) => run.phase === "unknown")) {
      throw new Error("A worker operation has an unknown outcome. Stop it and wait for confirmation before starting conflicting work.");
    }
    if (destructive && state.eventLog.some((entry) => entry.status === "unknown" && !entry.reconciledAt && (!entry.scope?.connectionId || entry.scope.connectionId === params.connectionId))) {
      throw new Error("An earlier operation has an unknown outcome. Check its source and destination, then mark it reviewed in Event Log before retrying.");
    }
    if (state.isRunning) throw new Error("An operation is already running");
    if (scope === "bulk" && (Object.keys(state.pendingMessageOperations).length > 0 || Object.keys(state.activeOperationRuns).length > 0)) {
      throw new Error("Wait for message operations to finish before starting a bulk operation");
    }
    const runId = options?.runId ?? (typeof params.runId === "string" ? params.runId : crypto.randomUUID());
    const target = scope === "atomic" && params.sequenceNumber != null
      ? JSON.stringify([params.connectionId, params.queueName, params.topicName, params.subscriptionName, params.isDlq, params.sequenceNumber]) : undefined;
    if (state.activeOperationRuns[runId] || (target && Object.values(state.activeOperationRuns).some((run) => run.target === target))) {
      throw new Error("An operation on this message is already running");
    }
    state.startOperationRun(runId, scope, target);
    if (scope === "bulk") { state.clearOutput(); state.setRunning(true, runId, scope); }
    state.recordOperationScope(runId, {
      connectionId: typeof params.connectionId === "string" ? params.connectionId : "",
      mode: typeof params.mode === "string" ? params.mode : params.isDlq ? "dlq" : "normal",
      destination: typeof params.destQueue === "string" ? params.destQueue : typeof params.destTopic === "string" ? params.destTopic : "",
      ...(command === "single_message_action" && params.action === "replay" ? {
        replaySource: typeof params.queueName === "string" ? replaySourceKey({ kind: "queue", queueName: params.queueName, topicName: null, subscriptionName: null })
          : typeof params.topicName === "string" && typeof params.subscriptionName === "string"
            ? replaySourceKey({ kind: "subscription", topicName: params.topicName, subscriptionName: params.subscriptionName, queueName: null }) : undefined,
      } : {}),
    });
    let lastCheckpointAt = -Infinity;
    let lastStderrLine = "";
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const unlisteners: Array<() => void> = [];
    let resolveDone!: (result: ScriptDoneEvent) => void;
    const done = new Promise<ScriptDoneEvent>((resolve) => {
      resolveDone = (result) => { if (!settled) { settled = true; resolve(result); } };
    });
    const observe = () => {
      if (settled) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        const error = "Worker updates stopped. Outcome unknown; conflicting work remains blocked. Try Stop and wait for confirmation.";
        state.setOperationRunPhase(runId, "unknown", error);
        if (scope === "bulk") useAppStore.setState({ operationPhase: "unknown", operationError: error });
        state.appendOutputLine(error, true, 0);
      }, OPERATION_INACTIVITY_MS);
    };
    try {
      // Register sequentially so partial registration failures still release every listener.
      unlisteners.push(await listen<ScriptOutputEvent>(`script-output:${runId}`, (event) => {
        if (settled) return;
        observe();
        state.appendOutputLine(event.payload.line, event.payload.isStderr, event.payload.elapsedMs);
        if (event.payload.isStderr && event.payload.line.trim()) lastStderrLine = event.payload.line.trim();
      }));
      unlisteners.push(await listen<ScriptProgressEvent>(`script-progress:${runId}`, (event) => {
        if (settled) return;
        observe();
        const counts = OperationCountsSchema.safeParse(event.payload.counts);
        if (counts.success && Date.now() - lastCheckpointAt >= 5000) {
          state.recordOperationCheckpoint(runId, counts.data);
          lastCheckpointAt = Date.now();
        }
        if (scope === "bulk" && (counts.success || !event.payload.heartbeat)) state.setProgress({
          text: event.payload.heartbeat ? (useAppStore.getState().progress?.text ?? "") : event.payload.text,
          elapsedMs: event.payload.elapsedMs,
          counts: counts.success ? counts.data : undefined,
        });
      }));
      unlisteners.push(await listen<ScriptDoneEvent>(`script-done:${runId}`, (event) => resolveDone(event.payload)));
      observe();
      // Command response and event are independent terminal acknowledgments.
      // Never await invoke before the event: the IPC response itself may be lost.
      void invoke<ScriptDoneEvent | undefined>(command, { args: { ...params, runId } }).then((result) => {
        if (result && typeof result.exitCode === "number") resolveDone(result);
      }).catch((error: unknown) => {
        if (settled) return;
        const message = String(error);
        logHandledError(`Operation command failed: ${command}`, error, { command, runId, scope });
        state.appendOutputLine(`Error: ${message}`, true, 0);
        resolveDone({ exitCode: -1, elapsedMs: 0, errorMessage: message });
      });
      const result = await done;
      if (result.result != null && ["move_messages", "empty_messages", "republish_subscription_dlq", "single_message_action"].includes(command)) {
        const parsed = OperationOutcomeSchema.safeParse(result.result);
        if (!parsed.success || parsed.data.runId !== runId) {
          const errorMessage = "Invalid operation outcome. Reconcile with the broker before retrying.";
          state.updateEventLogEntry(runId, "unknown", errorMessage);
          return { exitCode: -2, errorMessage };
        }
        state.recordOperationOutcome(runId, parsed.data);
      }
      if (result.exitCode === -2) state.updateEventLogEntry(runId, "unknown", result.errorMessage);
      const current = useAppStore.getState();
      const selection = current.explorerSelection;
      const targetMatches = selection.kind === "queue" ? params.queueName === selection.queueName
        : selection.kind === "subscription" && params.topicName === selection.topicName && params.subscriptionName === selection.subscriptionName;
      return {
        ...(scope === "atomic" && (current.connectionGeneration !== generation || ((params.queueName != null || params.topicName != null) && !targetMatches)) ? { contextCurrent: false } : {}),
        exitCode: result.exitCode,
        errorMessage: result.errorMessage ?? (result.exitCode !== 0 && lastStderrLine ? lastStderrLine : undefined),
        ...(result.result != null ? { result: result.result } : {}),
      };
    } catch (error) {
      settled = true;
      logHandledError(`Operation failed before dispatch: ${command}`, error, { command, runId, scope });
      return { exitCode: -1, errorMessage: String(error) };
    } finally {
      clearTimeout(watchdog);
      unlisteners.forEach((unlisten) => unlisten());
      state.finishOperationRun(runId);
      if (scope === "bulk" && useAppStore.getState().runId === runId) state.setRunning(false);
    }
  }, []);

  const stop = useCallback(async (requestedRunId?: string) => {
    const state = useAppStore.getState();
    const runId = requestedRunId ?? state.runId;
    const run = runId ? state.activeOperationRuns[runId] : undefined;
    if (!runId || !run || run.phase === "stopRequested") return;
    state.setOperationRunPhase(runId, "stopRequested");
    if (state.runId === runId) useAppStore.setState({ operationPhase: "stopRequested", operationError: null });
    try {
      await invoke("stop_current_operation", { runId });
      // Acknowledgment of the terminal operation, not a click on Stop, releases the lock.
    } catch (error) {
      if (!useAppStore.getState().activeOperationRuns[runId]) return;
      logHandledError("Failed to stop current operation", error, { runId });
      state.setOperationRunPhase(runId, "unknown", `Stop failed: ${String(error)}`);
      if (useAppStore.getState().runId === runId) useAppStore.setState({ operationPhase: "unknown", operationError: `Stop failed: ${String(error)}` });
      state.appendOutputLine(`Stop failed: ${String(error)}`, true, 0);
    }
  }, []);
  return { runOperation, isRunning, stop };
}
