import type { PeekedMessage } from "../types";

export function bodyString(body: unknown): string {
  if (body == null) return "";
  return typeof body === "string" ? body : JSON.stringify(body, null, 2);
}

// Weak keys let released message results and their search text be collected together.
const bodyText = new WeakMap<PeekedMessage, string>();
function searchableBody(message: PeekedMessage): string {
  let text = bodyText.get(message);
  if (text === undefined) { text = bodyString(message.body).toLowerCase(); bodyText.set(message, text); }
  return text;
}

export interface MessageFilters { messageId: string; deadLetterReason: string; deadLetterErrorDescription: string; body: string }
export function filterMessages(messages: PeekedMessage[], filters: MessageFilters): PeekedMessage[] {
  const id = filters.messageId.toLowerCase(), reason = filters.deadLetterReason.toLowerCase();
  const description = filters.deadLetterErrorDescription.toLowerCase(), body = filters.body.toLowerCase();
  if (!id && !reason && !description && !body) return messages;
  return messages.filter((message) => (!id || (message.messageId ?? "").toLowerCase().includes(id))
    && (!reason || (message.deadLetterReason ?? "").toLowerCase().includes(reason))
    && (!description || (message.deadLetterErrorDescription ?? "").toLowerCase().includes(description))
    && (!body || searchableBody(message).includes(body)));
}
