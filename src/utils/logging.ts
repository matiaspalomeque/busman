import { invoke } from "@tauri-apps/api/core";

type LogLevel = "error" | "warn" | "info";

type LogContext = Record<string, unknown>;

const MAX_DETAIL_CHARS = 20_000;
const SENSITIVE_KEY_PATTERN = /(password|connectionstring|sharedaccesskey|sharedaccesssignature|secret|token)/i;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function truncate(value: string): string {
  return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}...[truncated]` : value;
}

function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const errorWithCause = error as Error & { cause?: unknown };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: errorWithCause.cause === undefined ? undefined : normalizeError(errorWithCause.cause),
    };
  }

  return { value: String(error) };
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (key, nestedValue) => {
        if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
        if (typeof nestedValue === "object" && nestedValue !== null) {
          if (seen.has(nestedValue)) return "[Circular]";
          seen.add(nestedValue);
        }
        return nestedValue;
      },
      2
    );
  } catch (error) {
    return JSON.stringify({ serializationError: String(error) });
  }
}

export function logFrontendEvent(level: LogLevel, message: string, details?: unknown): void {
  if (!isTauriRuntime()) return;

  const serializedDetails = details === undefined ? undefined : truncate(safeStringify(details));
  void invoke("log_frontend_event", {
    level,
    message,
    details: serializedDetails,
  }).catch(() => {
    // Logging must never break the user flow or recursively report itself.
  });
}

export function logHandledError(message: string, error: unknown, context: LogContext = {}): void {
  logFrontendEvent("error", message, {
    error: normalizeError(error),
    context,
  });
}

export function logHandledWarning(message: string, context: LogContext = {}): void {
  logFrontendEvent("warn", message, { context });
}
