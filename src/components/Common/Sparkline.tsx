interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
}

/**
 * Tiny inline SVG sparkline for entity count history.
 * Only renders when there are at least 3 data points.
 * Color reflects trend: amber = accumulating, green = draining, zinc = flat.
 */
export function Sparkline({ data, width = 32, height = 10 }: SparklineProps) {
  if (data.length < 3) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;

  // Padding so the stroke doesn't clip at edges
  const pad = 1.5;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const points = data
    .map((v, i) => {
      const x = pad + (i / (data.length - 1)) * innerW;
      const y = range === 0 ? pad + innerH / 2 : pad + innerH - ((v - min) / range) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Compare recent average vs early average for trend direction
  const half = Math.max(1, Math.floor(data.length / 2));
  const earlyAvg = data.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const recentAvg = data.slice(-half).reduce((a, b) => a + b, 0) / half;
  const delta = recentAvg - earlyAvg;

  // Use a relative threshold to ignore noise (1% of max, min 0.5)
  const threshold = Math.max(0.5, max * 0.01);
  const stroke =
    range === 0 || Math.abs(delta) < threshold
      ? "#a1a1aa" // zinc-400 — flat
      : delta > 0
        ? "#f59e0b" // amber-500 — accumulating
        : "#22c55e"; // green-500 — draining

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 opacity-70"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
