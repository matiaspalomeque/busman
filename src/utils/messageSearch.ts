import type { PeekedMessage } from "../types";
import { bodyString, formatBodyJson } from "./messageBody";

type SearchForm = string | { text: string; padding: Uint8Array | Uint32Array; maxIndent: number };
type SearchText = { raw: string; formatted?: SearchForm; decoded?: SearchForm };
const bodyText = new WeakMap<PeekedMessage, SearchText>();

function bodyQuery(value: string) {
  return {
    value,
    multiline: value.includes("\n"),
    leading: value.match(/^ */)![0].length,
    unindented: value.replace(/(^|\n) +/g, "$1"),
    formatted: /^\s|\s$|["{}\[\],:]/.test(value),
    literal: value.match(/[a-z0-9_]+/)?.[0] ?? "",
  };
}

function indexForm(value: string, rawLength: number): SearchForm {
  if (value.length <= rawLength * 3 + 64) return value;
  // Store one width per line instead of retaining the expanded indentation of dense arrays.
  const widths = [0];
  let maxIndent = 0;
  const text = value.replace(/\n */g, (prefix) => {
    const width = prefix.length - 1;
    widths.push(width);
    maxIndent = Math.max(maxIndent, width);
    return "\n";
  });
  const padding = maxIndent <= 255 ? Uint8Array.from(widths) : Uint32Array.from(widths);
  return { text, padding, maxIndent };
}

function includesForm(form: SearchForm, query: ReturnType<typeof bodyQuery>): boolean {
  if (typeof form === "string") return form.includes(query.value);
  const { text, padding, maxIndent } = form;
  if (query.multiline) {
    if (!text.includes(query.unindented)) return false;
    // Rebuild the line breaks once. Overlapping occurrences of a long snippet can share most of their text.
    let row = 0;
    const original = text.replace(/\n/g, () => "\n" + " ".repeat(padding[++row]));
    return original.includes(query.value);
  }

  if (text.includes(query.value)) return true;
  if (!query.leading || query.leading > maxIndent) return false;
  if (!query.unindented) return true;
  // A single-line match still missing from compact text must begin in an indented line's padding.
  if (!text.includes("\n" + query.unindented)) return false;
  let newline = text.indexOf("\n");
  for (let row = 1; newline !== -1; row++) {
    if (padding[row] >= query.leading && text.startsWith(query.unindented, newline + 1)) return true;
    newline = text.indexOf("\n", newline + 1);
  }
  return false;
}

function matchesBody(message: PeekedMessage, query: ReturnType<typeof bodyQuery>): boolean {
  let text = bodyText.get(message);
  if (!text) {
    text = { raw: bodyString(message.body).toLowerCase() };
    bodyText.set(message, text);
  }
  if (text.raw.includes(query.value)) return true;
  if (!message.bodyIsJson || typeof message.body !== "string") return false;

  const matchesFormat = (key: "formatted" | "decoded") => {
    const form = text[key] ??= indexForm(
      formatBodyJson(message.body, { decodeStrings: key === "decoded" }).toLowerCase(),
      text.raw.length,
    );
    return includesForm(form, query);
  };
  // Formatting cannot introduce letters or digits. Decoding an escaped string can.
  if (query.formatted && text.raw.includes(query.literal) && matchesFormat("formatted")) return true;
  return text.raw.includes("\\") && matchesFormat("decoded");
}

export interface MessageFilters { messageId: string; deadLetterReason: string; deadLetterErrorDescription: string; body: string }
export function filterMessages(messages: PeekedMessage[], filters: MessageFilters): PeekedMessage[] {
  const id = filters.messageId.toLowerCase(), reason = filters.deadLetterReason.toLowerCase();
  const description = filters.deadLetterErrorDescription.toLowerCase(), body = filters.body.toLowerCase();
  if (!id && !reason && !description && !body) return messages;
  const query = body ? bodyQuery(body) : null;
  return messages.filter((message) => (!id || (message.messageId ?? "").toLowerCase().includes(id))
    && (!reason || (message.deadLetterReason ?? "").toLowerCase().includes(reason))
    && (!description || (message.deadLetterErrorDescription ?? "").toLowerCase().includes(description))
    && (!query || matchesBody(message, query)));
}
