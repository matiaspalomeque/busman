import type { ExplorerSelection, QueueMode } from "../../types";

export function getDisplayEntity(selection: ExplorerSelection): string | null {
  if (selection.kind === "queue") {
    return selection.queueName;
  }
  if (selection.kind === "subscription") {
    return `${selection.topicName}/${selection.subscriptionName}`;
  }
  return null;
}

export function canReplaySelection(selection: ExplorerSelection): boolean {
  return selection.kind === "queue";
}

export function canRepublishSelection(selection: ExplorerSelection): boolean {
  return selection.kind === "subscription";
}

export function buildEmptyMessagesParams(
  selection: ExplorerSelection,
  mode: QueueMode,
  connectionId: string,
): Record<string, unknown> | null {
  if (selection.kind === "none") return null;

  if (selection.kind === "queue") {
    return {
      queueName: selection.queueName,
      mode,
      connectionId,
    };
  }

  return {
    topicName: selection.topicName,
    subscriptionName: selection.subscriptionName,
    mode,
    connectionId,
  };
}

export function buildReplayParams(
  selection: ExplorerSelection,
  connectionId: string,
): Record<string, unknown> | null {
  if (selection.kind !== "queue") return null;

  return {
    sourceQueue: selection.queueName,
    destQueue: selection.queueName,
    mode: "dlq",
    connectionId,
  };
}

export function buildRepublishSubscriptionDlqParams(
  selection: ExplorerSelection,
  connectionId: string,
): Record<string, unknown> | null {
  if (selection.kind !== "subscription") return null;

  return {
    topicName: selection.topicName,
    subscriptionName: selection.subscriptionName,
    connectionId,
  };
}
