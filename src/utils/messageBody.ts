import type { PeekedMessage } from "../types";

export function bodyString(body: unknown): string {
  if (body == null) return "";
  return typeof body === "string" ? body : JSON.stringify(body, null, 2);
}

/** Preserve number tokens. Only the search index asks for normalized string escapes. */
export function formatBodyJson(body: unknown, { decodeStrings = false } = {}): string {
  const source = bodyString(body);
  try {
    JSON.parse(source);
  } catch {
    return source;
  }

  let result = "";
  let depth = 0;
  let previous = "";
  const tokens = /["{}\[\],:]|[^\s"{}\[\],:]+/g;
  let match;
  while ((match = tokens.exec(source)) !== null) {
    let token = match[0];
    if (token === '"') {
      // Scan string literals iteratively, including multi-megabyte broker payloads.
      let end = tokens.lastIndex;
      while (end < source.length) {
        const char = source[end++];
        if (char === '"') break;
        if (char === "\\") end++;
      }
      token = source.slice(match.index, end);
      tokens.lastIndex = end;
      if (decodeStrings && token.includes("\\")) {
        const decoded: string = JSON.parse(token);
        // A JSON string at the root was searchable as plain text before raw bodies were retained.
        if (depth === 0) return decoded;
        token = JSON.stringify(decoded);
      }
    }
    const closing = token === "}" || token === "]";
    const afterOpen = previous === "{" || previous === "[";
    if (closing) depth--;
    if (!(afterOpen && closing) && (afterOpen || previous === "," || closing)) {
      // A deeply nested body can require far more space to indent than to store.
      if (result.length + depth * 2 > source.length + 4 * 1024 * 1024) return source;
      result += "\n" + "  ".repeat(depth);
    } else if (previous === ":") {
      result += " ";
    }
    result += token;
    if (token === "{" || token === "[") depth++;
    previous = token;
  }
  return result;
}

/** Embed the worker's original JSON value in the exported record. */
export function serializeMessage({ body, bodyIsJson, ...metadata }: PeekedMessage): string {
  const value = bodyIsJson && typeof body === "string" ? body : JSON.stringify(body ?? null);
  return `{\n  "body": ${value},${JSON.stringify(metadata, null, 2).slice(1)}`;
}
