import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/appStore";
import { Icon } from "../Common/Icon";
import type { PeekedMessage } from "../../types";

// ─── Analysis (single pass) ───────────────────────────────────────────────────

function computeInsights(messages: PeekedMessage[]) {
  const now = Date.now();
  const total = messages.length;

  let dlqCount = 0;
  let normalCount = 0;
  let jsonBodyCount = 0;
  let emptyBodyCount = 0;
  let expiredCount = 0;
  let noCorrelationCount = 0;
  let minTime: number | null = null;
  let maxTime: number | null = null;

  const uniqueCorrIds = new Set<string>();
  const msgIds: string[] = [];
  const reasonMap: Record<string, number> = {};
  const fieldFreq: Record<string, number> = {};
  const ctMap: Record<string, number> = {};
  const hourBuckets = new Array(24).fill(0) as number[];

  for (const m of messages) {
    // DLQ / normal split + reason frequency
    if (m._source.startsWith("Dead Letter")) {
      dlqCount++;
      const r = m.deadLetterReason ?? "(unknown)";
      reasonMap[r] = (reasonMap[r] ?? 0) + 1;
    } else {
      normalCount++;
    }

    // Correlation IDs
    if (m.correlationId) {
      uniqueCorrIds.add(m.correlationId);
    } else {
      noCorrelationCount++;
    }

    // Message IDs (for duplicate detection)
    if (m.messageId) msgIds.push(m.messageId);

    // Enqueue time — single Date construction per message
    if (m.enqueuedTimeUtc) {
      const d = new Date(m.enqueuedTimeUtc);
      const ts = d.getTime();
      if (minTime === null || ts < minTime) minTime = ts;
      if (maxTime === null || ts > maxTime) maxTime = ts;
      hourBuckets[d.getHours()]++;
    }

    // Content type
    const ct = m.contentType ?? "(none)";
    ctMap[ct] = (ctMap[ct] ?? 0) + 1;

    // Expiry
    if (m.expiresAtUtc && new Date(m.expiresAtUtc).getTime() < now) {
      expiredCount++;
    }

    // Body analysis
    const body = m.body;
    if (
      body === null ||
      body === undefined ||
      body === "" ||
      (typeof body === "string" && body.trim() === "")
    ) {
      emptyBodyCount++;
    } else if (typeof body === "object" && !Array.isArray(body)) {
      const keys = Object.keys(body as Record<string, unknown>);
      if (keys.length === 0) {
        emptyBodyCount++;
      } else {
        jsonBodyCount++;
        for (const key of keys) {
          fieldFreq[key] = (fieldFreq[key] ?? 0) + 1;
        }
      }
    }
  }

  const topReasons = Object.entries(reasonMap).sort(([, a], [, b]) => b - a).slice(0, 5);
  const topFields = Object.entries(fieldFreq).sort(([, a], [, b]) => b - a).slice(0, 8);
  const topContentTypes = Object.entries(ctMap).sort(([, a], [, b]) => b - a).slice(0, 5);
  const duplicateMsgIds = msgIds.length - new Set(msgIds).size;
  // hourBuckets is 24 elements — safe to spread
  const maxHourCount = Math.max(...hourBuckets, 1);

  // Time span label derived here so it's part of the memoized result
  let timeSpanLabel: string | null = null;
  if (minTime !== null && maxTime !== null && minTime !== maxTime) {
    const ms = maxTime - minTime;
    const h = ms / 3_600_000;
    timeSpanLabel = h < 1
      ? `${Math.round(ms / 60_000)}m span`
      : h < 24
        ? `${h.toFixed(1)}h span`
        : `${Math.round(h / 24)}d span`;
  }

  return {
    total,
    dlqCount,
    normalCount,
    dlqPct: total > 0 ? Math.round((dlqCount / total) * 100) : 0,
    topReasons,
    uniqueCorrIds: uniqueCorrIds.size,
    minTime,
    maxTime,
    timeSpanLabel,
    hourBuckets,
    maxHourCount,
    jsonBodyCount,
    topFields,
    topContentTypes,
    emptyBodyCount,
    expiredCount,
    duplicateMsgIds,
    noCorrelationCount,
  };
}

// ─── Module-level style constants ─────────────────────────────────────────────

const VALUE_COLORS = {
  red: "text-red-600 dark:text-red-400",
  blue: "text-blue-600 dark:text-blue-400",
  violet: "text-violet-600 dark:text-violet-400",
  default: "text-zinc-800 dark:text-zinc-100",
} as const;

const FINDING_STYLES = {
  error: "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800",
  warning: "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800",
  success: "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800",
  info: "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800",
} as const;

const FINDING_ICONS = { error: "✕", warning: "⚠", success: "✓", info: "ℹ" } as const;

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatTime(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  accent = false,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
  color?: "red" | "blue" | "violet";
}) {
  const valueClass = color ? VALUE_COLORS[color] : VALUE_COLORS.default;
  return (
    <div
      className={[
        "rounded-xl p-4 border flex flex-col gap-0.5",
        accent
          ? "bg-violet-50 dark:bg-violet-900/15 border-violet-200 dark:border-violet-800"
          : "bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700",
      ].join(" ")}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      <span className={`text-3xl font-bold tabular-nums leading-tight ${valueClass}`}>{value}</span>
      {sub && <span className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">{sub}</span>}
    </div>
  );
}

function BarRow({
  label,
  count,
  pctOf,
  maxCount,
  colorClass,
}: {
  label: string;
  count: number;
  pctOf: number;
  maxCount: number;
  colorClass: string;
}) {
  const pct = pctOf > 0 ? Math.round((count / pctOf) * 100) : 0;
  const barWidth = maxCount > 0 ? (count / maxCount) * 100 : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-zinc-600 dark:text-zinc-300 truncate flex-1 font-mono" title={label}>
          {label}
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums shrink-0">
          {count} <span className="text-zinc-400 dark:text-zinc-500">({pct}%)</span>
        </span>
      </div>
      <div className="h-1.5 bg-zinc-100 dark:bg-zinc-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${colorClass} rounded-full transition-all duration-700 ease-out`}
          style={{ width: `${barWidth}%` }}
        />
      </div>
    </div>
  );
}

function FindingBadge({ text, kind }: { text: string; kind: keyof typeof FINDING_STYLES }) {
  return (
    <div className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-xs leading-snug ${FINDING_STYLES[kind]}`}>
      <span className="shrink-0 font-bold mt-px">{FINDING_ICONS[kind]}</span>
      <span>{text}</span>
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-zinc-100 dark:border-zinc-700/60">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          {title}
        </span>
        {sub && <span className="ml-2 text-[10px] text-zinc-400 dark:text-zinc-600">{sub}</span>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function HourHeatmap({ buckets, maxCount }: { buckets: number[]; maxCount: number }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-0.5">
        {buckets.map((count, h) => {
          const intensity = count > 0 ? 0.15 + (count / maxCount) * 0.85 : 0;
          return (
            <div key={h} className="flex-1 flex flex-col items-center gap-1">
              <div
                className={[
                  "w-full h-10 rounded-sm transition-all cursor-default",
                  count === 0
                    ? "bg-zinc-100 dark:bg-zinc-700/50 border border-zinc-200 dark:border-zinc-600/50"
                    : "border border-violet-400/40 dark:border-violet-500/40",
                ].join(" ")}
                style={count > 0 ? { backgroundColor: `rgba(139, 92, 246, ${intensity})` } : undefined}
                title={`${String(h).padStart(2, "0")}:00 — ${count} msg${count !== 1 ? "s" : ""}`}
              />
              {h % 3 === 0 && (
                <span className="text-[9px] text-zinc-400 dark:text-zinc-500 tabular-nums select-none">
                  {String(h).padStart(2, "0")}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 justify-end">
        <span className="text-[10px] text-zinc-400">Less</span>
        <div className="flex gap-0.5">
          {[0.1, 0.3, 0.5, 0.7, 0.9].map((v) => (
            <div key={v} className="w-3 h-3 rounded-sm" style={{ backgroundColor: `rgba(139, 92, 246, ${v})` }} />
          ))}
        </div>
        <span className="text-[10px] text-zinc-400">More</span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function MessageInsightsPanel() {
  const { t } = useTranslation();
  const { peekMessages, setIsInsightsPanelOpen } = useAppStore();
  const ins = useMemo(() => computeInsights(peekMessages), [peekMessages]);

  const findings = useMemo(() => {
    const list: Array<{ text: string; kind: keyof typeof FINDING_STYLES }> = [];
    if (ins.duplicateMsgIds > 0)
      list.push({ text: t("insights.duplicateIds", { count: ins.duplicateMsgIds }), kind: "error" });
    if (ins.emptyBodyCount > 0)
      list.push({ text: t("insights.emptyBodies", { count: ins.emptyBodyCount }), kind: "warning" });
    if (ins.expiredCount > 0)
      list.push({ text: t("insights.expired", { count: ins.expiredCount }), kind: "warning" });
    if (ins.noCorrelationCount > 0 && ins.noCorrelationCount < ins.total)
      list.push({ text: t("insights.missingCorrelation", { count: ins.noCorrelationCount }), kind: "info" });
    if (ins.dlqCount > 0 && ins.normalCount === 0)
      list.push({ text: t("insights.allDlq"), kind: "warning" });
    if (list.length === 0)
      list.push({ text: t("insights.noIssues"), kind: "success" });
    return list;
  }, [ins, t]);

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950/40">
      {/* Header bar */}
      <div className="shrink-0 flex items-center justify-between px-6 py-3 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex items-center gap-2.5">
          <Icon name="chartBar" size={14} className="text-violet-500" />
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            {t("insights.title")}
          </span>
          <span className="text-xs text-zinc-400 dark:text-zinc-500 border border-zinc-200 dark:border-zinc-700 rounded-full px-2 py-0.5">
            {t("insights.analyzedCount", { count: ins.total })}
          </span>
        </div>
        <button
          onClick={() => setIsInsightsPanelOpen(false)}
          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors p-1 rounded"
          title={t("insights.close")}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-5 max-w-5xl mx-auto">

          {/* Stat cards */}
          <div className="grid grid-cols-4 gap-3">
            <StatCard
              label={t("insights.totalMessages")}
              value={ins.total}
              sub={ins.timeSpanLabel ?? undefined}
              accent
            />
            <StatCard
              label={t("insights.dlqMessages")}
              value={ins.dlqCount}
              sub={ins.total > 0 ? `${ins.dlqPct}% of total` : undefined}
              color={ins.dlqCount > 0 ? "red" : undefined}
            />
            <StatCard
              label={t("insights.normalMessages")}
              value={ins.normalCount}
              sub={ins.total > 0 ? `${100 - ins.dlqPct}% of total` : undefined}
              color="blue"
            />
            <StatCard
              label={t("insights.uniqueCorrelations")}
              value={ins.uniqueCorrIds}
              color="violet"
            />
          </div>

          {/* Error distribution + Findings */}
          <div className="grid grid-cols-2 gap-5">
            <Section title={t("insights.errorDistribution")}>
              {ins.topReasons.length === 0 ? (
                <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">
                  {t("insights.noDlqMessages")}
                </p>
              ) : (
                <div className="space-y-4">
                  {ins.topReasons.map(([reason, count]) => (
                    <BarRow
                      key={reason}
                      label={reason}
                      count={count}
                      pctOf={ins.dlqCount}
                      maxCount={ins.topReasons[0]?.[1] ?? 1}
                      colorClass="bg-red-400 dark:bg-red-500"
                    />
                  ))}
                </div>
              )}
            </Section>

            <Section title={t("insights.actionableInsights")}>
              <div className="space-y-2">
                {findings.map((f, i) => (
                  <FindingBadge key={i} text={f.text} kind={f.kind} />
                ))}
              </div>
            </Section>
          </div>

          {/* Time heatmap */}
          <Section
            title={t("insights.timeDistribution")}
            sub={ins.minTime ? `${formatTime(ins.minTime)} → ${formatTime(ins.maxTime)}` : undefined}
          >
            <HourHeatmap buckets={ins.hourBuckets} maxCount={ins.maxHourCount} />
          </Section>

          {/* JSON schema + Content types */}
          <div className="grid grid-cols-2 gap-5">
            <Section
              title={t("insights.jsonSchema")}
              sub={ins.jsonBodyCount > 0 ? t("insights.jsonSchemaDesc", { count: ins.jsonBodyCount }) : undefined}
            >
              {ins.topFields.length === 0 ? (
                <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">
                  {t("insights.noJsonBodies")}
                </p>
              ) : (
                <div className="space-y-3">
                  {ins.topFields.map(([field, count]) => (
                    <BarRow
                      key={field}
                      label={field}
                      count={count}
                      pctOf={ins.jsonBodyCount}
                      maxCount={ins.topFields[0]?.[1] ?? 1}
                      colorClass="bg-blue-400 dark:bg-blue-500"
                    />
                  ))}
                </div>
              )}
            </Section>

            <Section title={t("insights.contentTypes")}>
              {ins.topContentTypes.length === 0 ? (
                <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">
                  {t("insights.noData")}
                </p>
              ) : (
                <div className="space-y-3">
                  {ins.topContentTypes.map(([ct, count]) => (
                    <BarRow
                      key={ct}
                      label={ct}
                      count={count}
                      pctOf={ins.total}
                      maxCount={ins.topContentTypes[0]?.[1] ?? 1}
                      colorClass="bg-amber-400 dark:bg-amber-500"
                    />
                  ))}
                </div>
              )}
            </Section>
          </div>

        </div>
      </div>
    </div>
  );
}
