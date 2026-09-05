/** Exit code emitted after the worker acknowledges cancellation without uncertain work. */
export const STOP_EXIT_CODE = 130;

/** Map a worker exit code to an event-log status string. */
export function exitCodeToStatus(exitCode: number): "success" | "stopped" | "error" | "unknown" {
  if (exitCode === -2) return "unknown";
  if (exitCode === 0) return "success";
  if (exitCode === STOP_EXIT_CODE) return "stopped";
  return "error";
}
