import type { PeekedMessage, SendMessageDraft } from "../../types";
import { bodyString } from "./MessageGrid";
import type { useAppStore } from "../../store/appStore";

type Store = ReturnType<typeof useAppStore.getState>;

export function formatBodyJson(body: unknown): string {
  const raw = bodyString(body);
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function copyMessageId(msg: PeekedMessage): void {
  void navigator.clipboard.writeText(msg.messageId ?? "");
}

export function copySequenceNumber(msg: PeekedMessage): void {
  void navigator.clipboard.writeText(msg.sequenceNumber != null ? String(msg.sequenceNumber) : "");
}

export function copyMessageBody(msg: PeekedMessage): void {
  void navigator.clipboard.writeText(formatBodyJson(msg.body));
}

export function copyMessageJson(msg: PeekedMessage): void {
  const obj: Record<string, unknown> = {
    messageId: msg.messageId,
    sequenceNumber: msg.sequenceNumber,
    enqueuedTimeUtc: msg.enqueuedTimeUtc,
    subject: msg.subject,
    contentType: msg.contentType,
    correlationId: msg.correlationId,
    partitionKey: msg.partitionKey,
    applicationProperties: msg.applicationProperties,
    body: msg.body,
  };
  if (msg.deadLetterReason) obj.deadLetterReason = msg.deadLetterReason;
  if (msg.deadLetterErrorDescription) obj.deadLetterErrorDescription = msg.deadLetterErrorDescription;
  void navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
}

export function openResend(msg: PeekedMessage, store: Store): void {
  const raw = bodyString(msg.body);
  const draft: SendMessageDraft = {
    body: raw,
    contentType: msg.contentType ?? undefined,
    subject: msg.subject ?? undefined,
    correlationId: msg.correlationId ?? undefined,
    applicationProperties: msg.applicationProperties ?? undefined,
  };
  store.setSendDraft(draft);
  store.setIsSendModalOpen(true);
}

export function openMoveSingle(msg: PeekedMessage, store: Store): void {
  store.setSingleMessageMoveTarget(msg);
  store.setIsMoveModalOpen(true);
}
