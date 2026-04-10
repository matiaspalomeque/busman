import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/appStore";
import type { EventLogEntry } from "../../types";

const PAGE_SIZES = [10, 25, 50] as const;

function StatusBadge({ status }: { status: EventLogEntry["status"] }) {
  const { t } = useTranslation();
  const styles =
    status === "success"
      ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
      : status === "running"
        ? "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 animate-pulse"
        : status === "stopped"
          ? "bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400"
          : "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400";

  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${styles}`}>
      {status === "running"
        ? t("explorer.eventLog.statusRunning")
        : status === "success"
          ? t("explorer.eventLog.statusOk")
          : status === "stopped"
            ? t("explorer.eventLog.statusStopped")
            : t("explorer.eventLog.statusError")}
    </span>
  );
}

function formatLogTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

export function EventLog() {
  const { t } = useTranslation();
  const { eventLog, isRunning } = useAppStore();

  const [collapsed, setCollapsed] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);

  const totalPages = Math.max(1, Math.ceil(eventLog.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = eventLog.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <footer
      className={[
        "shrink-0 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 flex flex-col transition-all duration-200",
        collapsed ? "h-8" : "h-44",
      ].join(" ")}
    >
      {/* Header bar */}
      <div className="flex items-center px-3 h-8 gap-2 shrink-0 border-b border-zinc-200 dark:border-zinc-700">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1 text-xs font-semibold text-zinc-600 dark:text-zinc-300 hover:text-azure-primary transition-colors"
        >
          <svg
            width={11}
            height={11}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${collapsed ? "rotate-180" : ""}`}
          >
            <polyline points="18 15 12 9 6 15" />
          </svg>
          {t("explorer.eventLog.title")}
          {eventLog.length > 0 && (
            <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400">
              {eventLog.length}
            </span>
          )}
        </button>

        {/* Running indicator */}
        {isRunning && (
          <span className="flex items-center gap-1.5 ml-1">
            <span className="w-2.5 h-2.5 border-[1.5px] border-azure-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-[10px] font-semibold text-azure-primary">
              {t("explorer.eventLog.statusRunning")}
            </span>
          </span>
        )}

        {!collapsed && (
          <>
            <div className="flex-1" />
            {/* Page size selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-400">{t("explorer.eventLog.rows")}</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value) as (typeof PAGE_SIZES)[number]);
                  setPage(1);
                }}
                className="text-[10px] w-12 px-1 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none dark:text-zinc-300 appearance-none select-custom-arrow pr-4"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            {/* Pagination */}
            <div className="flex items-center gap-1 text-[10px] text-zinc-400">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage === 1}
                className="px-1 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700"
              >
                ‹
              </button>
              <span>
                {safePage}/{totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
                className="px-1 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700"
              >
                ›
              </button>
            </div>
          </>
        )}
      </div>

      {/* Table */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto">
          {eventLog.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs text-zinc-400 dark:text-zinc-500">
              {t("explorer.eventLog.noOperations")}
            </div>
          ) : (
            <table className="w-full text-[10px] border-collapse">
              <thead className="sticky top-0 bg-zinc-100 dark:bg-zinc-800 z-10">
                <tr>
                  {[
                    t("explorer.eventLog.colTime"),
                    t("explorer.eventLog.colNamespace"),
                    t("explorer.eventLog.colEntity"),
                    t("explorer.eventLog.colType"),
                    t("explorer.eventLog.colOperation"),
                    t("explorer.eventLog.colStatus"),
                    t("explorer.eventLog.colError"),
                  ].map((h) => (
                    <th
                      key={h}
                      className="px-3 py-1 text-left font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 border-b border-zinc-200 dark:border-zinc-700 whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((entry) => (
                  <tr
                    key={entry.id}
                    className="hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors"
                  >
                    <td className="px-3 py-1 text-zinc-500 dark:text-zinc-400 tabular-nums whitespace-nowrap">
                      {formatLogTime(entry.time)}
                    </td>
                    <td
                      className="px-3 py-1 text-zinc-600 dark:text-zinc-300 truncate max-w-[180px]"
                      title={entry.namespace}
                    >
                      {entry.namespace}
                    </td>
                    <td
                      className="px-3 py-1 text-zinc-600 dark:text-zinc-300 truncate max-w-[140px]"
                      title={entry.entity}
                    >
                      {entry.entity}
                    </td>
                    <td className="px-3 py-1 text-zinc-500 dark:text-zinc-400">
                      {entry.entityType}
                    </td>
                    <td className="px-3 py-1 text-zinc-600 dark:text-zinc-300">
                      {entry.operation}
                    </td>
                    <td className="px-3 py-1">
                      <StatusBadge status={entry.status} />
                    </td>
                    <td
                      className="px-3 py-1 text-red-500 dark:text-red-400 truncate max-w-[240px]"
                      title={entry.errorMessage}
                    >
                      {entry.errorMessage ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </footer>
  );
}
