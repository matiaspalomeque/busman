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

export function isDeadLetterMessage(
  msg: Pick<PeekedMessage, "sourceSubQueue" | "_source">
): boolean {
  if (msg.sourceSubQueue != null) return msg.sourceSubQueue !== "active";
  return msg._source.toLowerCase().startsWith("dead letter");
}

export function addSingleMessageActionMetadata(
  params: Record<string, unknown>,
  msg: Pick<PeekedMessage, "messageId" | "sessionId" | "state" | "sourceSubQueue" | "_source">,
): void {
  if (msg.messageId != null) params.messageId = msg.messageId;
  if (msg.sessionId != null) params.sessionId = msg.sessionId;
  if (msg.state != null) params.state = msg.state;
  if (msg.sourceSubQueue != null) params.sourceSubQueue = msg.sourceSubQueue;
  params.source = msg._source;
}
