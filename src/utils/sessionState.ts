export const MAX_SESSION_STATE_BYTES = (32 * 1024 * 1024 * 3) / 4 - 64 * 1024;
export const MAX_SESSION_STATE_BASE64_BYTES = Math.ceil(MAX_SESSION_STATE_BYTES / 3) * 4;

function standardBase64Sextet(charCode: number): number {
  if (charCode >= 65 && charCode <= 90) return charCode - 65;
  if (charCode >= 97 && charCode <= 122) return charCode - 71;
  if (charCode >= 48 && charCode <= 57) return charCode + 4;
  if (charCode === 43) return 62;
  if (charCode === 47) return 63;
  return -1;
}

export function sessionStateBase64ByteLength(value: string): number | null {
  if (value.length > MAX_SESSION_STATE_BASE64_BYTES || value.length % 4 !== 0) {
    return null;
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const byteLength = (value.length / 4) * 3 - padding;
  if (byteLength > MAX_SESSION_STATE_BYTES) return null;

  const contentLength = value.length - padding;
  let trailingSextet = 0;
  for (let index = 0; index < contentLength; index += 1) {
    trailingSextet = standardBase64Sextet(value.charCodeAt(index));
    if (trailingSextet < 0) return null;
  }

  if (padding === 2 && (trailingSextet & 0b1111) !== 0) return null;
  if (padding === 1 && (trailingSextet & 0b11) !== 0) return null;
  return byteLength;
}
