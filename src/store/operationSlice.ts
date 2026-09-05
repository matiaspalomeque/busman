import type { StateCreator } from "zustand";
import type { AppState } from "./appStore";
import type { OutputLine, ProgressUpdate } from "../types";

export interface ActiveOperationRun {
  scope: "bulk" | "atomic";
  phase: "running" | "stopRequested" | "unknown";
  target?: string;
  error?: string;
}

export interface OperationSlice {
  activeOperationRuns: Record<string, ActiveOperationRun>;
  startOperationRun: (id: string, scope: "bulk" | "atomic", target?: string) => void;
  setOperationRunPhase: (id: string, phase: ActiveOperationRun["phase"], error?: string) => void;
  finishOperationRun: (id: string) => void;
  // Script execution state
  isRunning: boolean;
  operationPhase: "running" | "stopRequested" | "unknown" | null;
  operationError: string | null;
  operationScope: "atomic" | "bulk" | null;
  runId: string | null;
  outputLines: OutputLine[];
  progress: ProgressUpdate | null;

  setRunning: (running: boolean, runId?: string, scope?: "atomic" | "bulk") => void;
  appendOutputLine: (line: string, isStderr: boolean, elapsedMs: number) => void;
  setProgress: (progress: ProgressUpdate | null) => void;
  clearOutput: () => void;
}

export const createOperationSlice: StateCreator<AppState, [["zustand/immer", never]], [], OperationSlice> = (set) => ({
  activeOperationRuns: {},
  startOperationRun: (id, scope, target) => set((state) => { state.activeOperationRuns[id] = { scope, target, phase: "running" }; }),
  setOperationRunPhase: (id, phase, error) => set((state) => {
    const run = state.activeOperationRuns[id];
    if (run) { run.phase = phase; run.error = error; }
  }),
  finishOperationRun: (id) => set((state) => { delete state.activeOperationRuns[id]; }),
  isRunning: false,
  operationPhase: null,
  operationError: null,
  operationScope: null,
  runId: null,
  outputLines: [],
  progress: null,
  setRunning: (running, runId, scope) =>
    set((state) => {
      state.isRunning = running;
      state.operationPhase = running ? "running" : null;
      state.operationError = null;
      state.runId = runId ?? null;
      state.operationScope = running ? (scope ?? "bulk") : null;
      if (!running) {
        state.progress = null;
      }
    }),

  appendOutputLine: (line, isStderr, elapsedMs) =>
    set((state) => {
      state.outputLines.push({
        id: crypto.randomUUID(),
        text: line,
        isStderr,
        elapsedMs,
      });
      // Cap at 2000 lines to prevent unbounded memory growth.
      if (state.outputLines.length > 2000) {
        state.outputLines.splice(0, state.outputLines.length - 2000);
      }
    }),

  setProgress: (progress) =>
    set((state) => {
      state.progress = progress;
    }),

  clearOutput: () =>
    set((state) => {
      state.outputLines = [];
      state.progress = null;
    }),

});
