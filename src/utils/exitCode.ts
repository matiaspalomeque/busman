/** Exit code emitted by the Rust layer when the worker is killed via SIGINT. */
export const STOP_EXIT_CODE = 130;

/** Map a worker exit code to an event-log status string. */
export function exitCodeToStatus(exitCode: number): "success" | "stopped" | "error" {
  if (exitCode === 0) return "success";
  if (exitCode === STOP_EXIT_CODE) return "stopped";
  return "error";
}
