import type { EventLogEntry, ExplorerSelection, PeekedMessage } from "../types";

export const REPLAY_RUN_ID_PROPERTY = "BusmanReplayRunId";

export function replaySourceKey(selection: ExplorerSelection): string | undefined {
  if (selection.kind === "queue") return JSON.stringify(["queue", selection.queueName]);
  if (selection.kind === "subscription") return JSON.stringify(["subscription", selection.topicName, selection.subscriptionName]);
  return undefined;
}

export function findMessageReplay(
  entries: EventLogEntry[], connectionId: string | null, selection: ExplorerSelection, message: PeekedMessage,
): EventLogEntry | undefined {
  if (!isDeadLetterMessage(message)) return undefined;
  const runId = message.applicationProperties?.[REPLAY_RUN_ID_PROPERTY];
  const source = replaySourceKey(selection);
  if (typeof runId !== "string" || !source || !connectionId) return undefined;
  return entries.find((entry) => entry.id === runId && entry.operation === "ReplayMessage" && entry.status === "success"
    && entry.scope?.connectionId === connectionId && entry.scope.replaySource === source);
}

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
