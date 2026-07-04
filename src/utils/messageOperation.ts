import type { EventLogEntry, PeekedMessage } from "../types";

export type MessageOperation = Extract<
  EventLogEntry["operation"],
  "DeleteMessage" | "ReplayMessage" | "MoveMessage"
>;

export function messageOperationKey(
  msg: Pick<PeekedMessage, "_source" | "sequenceNumber">
): string | null {
  if (msg.sequenceNumber == null) return null;
  return `${msg._source}\0${msg.sequenceNumber}`;
}
