import type { EventLogEntry } from "../types";

export function operationWasStopped(entry?: EventLogEntry): boolean {
  return entry?.status === "stopped" || (entry?.status === "unknown" && entry.outcome?.errorCode === "cancelled");
}
