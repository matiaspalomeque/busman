import type { PeekedMessage, SendMessageDraft } from "../../types";
import { bodyString } from "../../utils/messageSearch";
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
  void navigator.clipboard.writeText(JSON.stringify(msg, null, 2));
}

export function openResend(msg: PeekedMessage, store: Store): void {
  const raw = bodyString(msg.body);
  const draft: SendMessageDraft = {
    body: raw,
    contentType: msg.contentType ?? undefined,
    subject: msg.subject ?? undefined,
    correlationId: msg.correlationId ?? undefined,
    sessionId: msg.sessionId ?? undefined,
    applicationProperties: msg.applicationProperties ?? undefined,
  };
  store.setSendDraft(draft);
  store.setIsSendModalOpen(true);
}

export function openMoveSingle(msg: PeekedMessage, store: Store): void {
  store.setSingleMessageMoveTarget(msg);
  store.setIsMoveModalOpen(true);
}
