export const MAX_SEQUENCE_NUMBER = "9223372036854775807";

const MAX_SEQUENCE_NUMBER_BIGINT = BigInt(MAX_SEQUENCE_NUMBER);
const CANONICAL_SEQUENCE_NUMBER = /^(0|[1-9][0-9]*)$/;

function parseCanonicalSequenceNumber(value: string): bigint {
  if (!CANONICAL_SEQUENCE_NUMBER.test(value)) {
    throw new Error("Sequence number must be a canonical non-negative decimal string");
  }

  const parsed = BigInt(value);
  if (parsed > MAX_SEQUENCE_NUMBER_BIGINT) {
    throw new Error("Sequence number exceeds the signed 64-bit range");
  }
  return parsed;
}

/**
 * Normalizes worker/IPC sequence numbers without allowing an already-rounded
 * JavaScript number into application state. Numeric input is retained only for
 * compatibility with older worker payloads inside Number's exact integer range.
 */
export function normalizeSequenceNumber(value: unknown): string {
  if (typeof value === "string") {
    parseCanonicalSequenceNumber(value);
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  throw new Error("Sequence number must be an exact non-negative 64-bit integer");
}

export function isCanonicalSequenceNumber(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    parseCanonicalSequenceNumber(value);
    return true;
  } catch {
    return false;
  }
}

export function compareSequenceNumbers(left: string, right: string): number {
  const leftValue = parseCanonicalSequenceNumber(left);
  const rightValue = parseCanonicalSequenceNumber(right);
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

export function incrementSequenceNumber(value: string): string | null {
  const parsed = parseCanonicalSequenceNumber(value);
  if (parsed === MAX_SEQUENCE_NUMBER_BIGINT) return null;
  return String(parsed + 1n);
}
