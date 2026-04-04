export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "\u2014";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const DOTNET_MAX_TIMESPAN_ISO = /^P10675199DT2H48M5(?:\.4775807)?S$/i;
const DOTNET_MAX_TIMESPAN = /^10675199\.02:48:05(?:\.4775807)?$/i;

export function formatDuration(iso: string | null | undefined, neverLabel = "Never"): string {
  if (!iso) return "\u2014";
  if (DOTNET_MAX_TIMESPAN_ISO.test(iso) || DOTNET_MAX_TIMESPAN.test(iso)) {
    return neverLabel;
  }

  // Parse ISO 8601 duration: P[nD]T[nH][nM][nS]
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!m) return iso;

  const parts: string[] = [];
  if (m[1]) parts.push(`${m[1]}d`);
  if (m[2]) parts.push(`${m[2]}h`);
  if (m[3]) parts.push(`${m[3]}m`);
  if (m[4]) parts.push(`${parseFloat(m[4])}s`);
  return parts.length > 0 ? parts.join(" ") : iso;
}
