import { useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/appStore";
import type { PeekedMessage } from "../../types";
import { EntityDetailsPanel } from "./EntityDetailsPanel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function bodyString(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body, null, 2);
}

// ─── Column filter row ────────────────────────────────────────────────────────

interface FilterRowProps {
  filters: Record<string, string>;
  visibleFilters: Set<string>;
  onChange: (key: string, value: string) => void;
}

function FilterRow({ filters, visibleFilters, onChange }: FilterRowProps) {
  const { t } = useTranslation();
  if (visibleFilters.size === 0) return null;
  return (
    <tr className="bg-zinc-50 dark:bg-zinc-800/60">
      <td className="px-2 py-1 border-b border-zinc-200 dark:border-zinc-700" />
      <td className="px-2 py-1 border-b border-zinc-200 dark:border-zinc-700" />
      {(["messageId", "deadLetterReason", "deadLetterErrorDescription"] as const).map((key) => (
        <td key={key} className="px-2 py-1 border-b border-zinc-200 dark:border-zinc-700">
          {visibleFilters.has(key) ? (
            <input
              type="text"
              value={filters[key]}
              onChange={(e) => onChange(key, e.target.value)}
              placeholder={t("explorer.grid.filterPlaceholder")}
              className="w-full text-xs px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
            />
          ) : null}
        </td>
      ))}
    </tr>
  );
}

// ─── Body filter bar ──────────────────────────────────────────────────────────

interface BodyFilterBarProps {
  value: string;
  onChange: (v: string) => void;
  rightSlot?: React.ReactNode;
}

function BodyFilterBar({ value, onChange, rightSlot }: BodyFilterBarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
      <span className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider whitespace-nowrap">
        {t("explorer.grid.bodyFilter")}
      </span>
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300">
        {t("explorer.grid.contains")}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("explorer.grid.searchBody")}
        className="flex-1 text-xs px-2 py-1 rounded border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-xs"
        >
          ✕
        </button>
      )}
      {rightSlot}
    </div>
  );
}

// ─── Column header ────────────────────────────────────────────────────────────

interface ColHeaderProps {
  label: string;
  filterKey?: string;
  filterActive?: boolean;
  onFilterToggle?: () => void;
}

function ColHeader({ label, filterKey, filterActive, onFilterToggle }: ColHeaderProps) {
  return (
    <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700 whitespace-nowrap">
      <div className="flex items-center gap-1">
        <span>{label}</span>
        {filterKey && (
          <button
            onClick={onFilterToggle}
            title="Toggle column filter"
            className={[
              "p-0.5 rounded transition-colors",
              filterActive
                ? "text-azure-primary bg-azure-primary/10"
                : "text-zinc-300 dark:text-zinc-600 hover:text-zinc-500 dark:hover:text-zinc-400",
            ].join(" ")}
          >
            {/* Filter funnel icon */}
            <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <path d="M3 4h18l-7 8v7l-4-2v-5L3 4z" />
            </svg>
          </button>
        )}
      </div>
    </th>
  );
}

// ─── Operation progress ───────────────────────────────────────────────────────

function parseProgressText(text: string): { count: number; rate: number } | null {
  const match = text.match(/(\d+)\s*\|\s*Avg Rate:\s*(\d+)/);
  if (!match) return null;
  return { count: parseInt(match[1], 10), rate: parseInt(match[2], 10) };
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

// ─── Operation progress panel ─────────────────────────────────────────────────

function OperationProgressPanel() {
  const { t } = useTranslation();
  const { progress, eventLog, runId } = useAppStore();

  const runningEntry = eventLog.find((e) => e.status === "running");
  const operation = runningEntry?.operation ?? "Operation";
  const entity = runningEntry?.entity ?? "";

  const parsed = progress ? parseProgressText(progress.text) : null;
  const count = parsed?.count ?? 0;
  const rate = parsed?.rate ?? 0;
  const elapsed = progress ? formatElapsed(progress.elapsedMs) : "0:00";

  const isReceive = operation === "Receive";
  const isReplay = operation === "Replay";

  const accentClass = isReceive
    ? "text-red-500 dark:text-red-400"
    : isReplay
      ? "text-amber-500 dark:text-amber-400"
      : "text-azure-primary";

  const barClass = isReceive
    ? "bg-red-500"
    : isReplay
      ? "bg-amber-500"
      : "bg-azure-primary";

  const handleCancel = async () => {
    if (!runId) return;
    try {
      await invoke("stop_current_operation", { runId });
    } catch {
      // Non-fatal
    }
  };

  const OperationIcon = () =>
    isReceive ? (
      <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      </svg>
    ) : isReplay ? (
      <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
      </svg>
    ) : (
      <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14M12 5l7 7-7 7" />
      </svg>
    );

  return (
    <div className="flex-1 flex items-center justify-center py-8">
      <div className="flex flex-col items-center gap-6 w-full max-w-[260px] px-4">

        {/* Icon + title */}
        <div className="flex flex-col items-center gap-2 text-center">
          <div className={`p-3 rounded-full bg-zinc-100 dark:bg-zinc-800/80 ${accentClass}`}>
            <OperationIcon />
          </div>
          <div className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
            {t("explorer.progress.inProgress", { operation })}
          </div>
          {entity && (
            <div className="text-[11px] text-zinc-400 dark:text-zinc-500 break-words text-center w-full">
              {entity}
            </div>
          )}
        </div>

        {/* Indeterminate progress bar */}
        <div className="w-full h-[3px] bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
          <div
            className={`h-full w-[45%] rounded-full ${barClass} opacity-90`}
            style={{ animation: "indeterminate 1.4s linear infinite" }}
          />
        </div>

        {/* Stats */}
        <div className="flex items-start gap-4 justify-center w-full">
          <div className="flex flex-col items-center gap-1 min-w-[68px]">
            <span className="text-[15px] font-mono font-semibold text-zinc-800 dark:text-zinc-100 tabular-nums leading-none">
              {count > 0 ? count.toLocaleString() : "—"}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {t("explorer.progress.processed")}
            </span>
          </div>
          <div className="w-px h-8 bg-zinc-200 dark:bg-zinc-700 self-center" />
          <div className="flex flex-col items-center gap-1 min-w-[68px]">
            <span className="text-[15px] font-mono font-semibold text-zinc-800 dark:text-zinc-100 tabular-nums leading-none">
              {rate > 0 ? `${rate.toLocaleString()}/s` : "—"}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {t("explorer.progress.rate")}
            </span>
          </div>
          <div className="w-px h-8 bg-zinc-200 dark:bg-zinc-700 self-center" />
          <div className="flex flex-col items-center gap-1 min-w-[52px]">
            <span className="text-[15px] font-mono font-semibold text-zinc-800 dark:text-zinc-100 tabular-nums leading-none">
              {elapsed}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {t("explorer.progress.elapsed")}
            </span>
          </div>
        </div>

        {/* Cancel button */}
        <button
          onClick={() => void handleCancel()}
          className="flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-medium border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 rounded-md hover:border-red-400 hover:text-red-600 dark:hover:border-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        >
          <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          {t("explorer.toolbar.stop")}
        </button>

      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ message }: { message: string }) {
  return (
    <tr>
      <td colSpan={5} className="px-4 py-12 text-center text-sm text-zinc-400 dark:text-zinc-500">
        {message}
      </td>
    </tr>
  );
}

// ─── MessageGrid ──────────────────────────────────────────────────────────────

export function MessageGrid() {
  const { t } = useTranslation();
  const {
    peekMessages,
    peekFilename,
    explorerSelection,
    selectedMessage,
    setSelectedMessage,
    gridFilters,
    setGridFilter,
    gridPage,
    gridPageSize,
    setGridPage,
    setGridPageSize,
    isRunning,
    lastBrowseError,
    setLastBrowseError,
  } = useAppStore();

  // Track which column filter inputs are visible
  const [visibleFilters, setVisibleFilters] = useState<Set<string>>(new Set());

  const handleExport = async () => {
    const sanitize = (s: string) => s.replace(/[/\\:*?"<>|]/g, "-");
    const baseName =
      explorerSelection.kind === "queue"
        ? `${sanitize(explorerSelection.queueName)}-messages`
        : explorerSelection.kind === "subscription"
          ? `${sanitize(explorerSelection.topicName)}-${sanitize(explorerSelection.subscriptionName)}-messages`
          : "messages";
    const path = await save({
      defaultPath: `${baseName}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await invoke("write_json_file", { path, content: JSON.stringify(peekMessages, null, 2) });
    } catch (err) {
      setLastBrowseError(`Export failed: ${String(err)}`);
    }
  };

  const toggleFilter = (key: string) => {
    setVisibleFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        setGridFilter(
          key as "messageId" | "deadLetterReason" | "deadLetterErrorDescription" | "body",
          ""
        );
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Apply client-side filters
  const filtered = peekMessages.filter((msg) => {
    const { messageId, deadLetterReason, deadLetterErrorDescription, body } = gridFilters;
    if (messageId && !String(msg.messageId ?? "").toLowerCase().includes(messageId.toLowerCase()))
      return false;
    if (
      deadLetterReason &&
      !String(msg.deadLetterReason ?? "").toLowerCase().includes(deadLetterReason.toLowerCase())
    )
      return false;
    if (
      deadLetterErrorDescription &&
      !String(msg.deadLetterErrorDescription ?? "")
        .toLowerCase()
        .includes(deadLetterErrorDescription.toLowerCase())
    )
      return false;
    if (body && !bodyString(msg.body).toLowerCase().includes(body.toLowerCase())) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / gridPageSize));
  const safePage = Math.min(gridPage, totalPages);
  const pageStart = (safePage - 1) * gridPageSize;
  const pageEnd = pageStart + gridPageSize;
  const pageRows = filtered.slice(pageStart, pageEnd);

  const hasSelection = explorerSelection.kind !== "none";
  const browsing = isRunning;

  // Show entity details panel when entity selected but no browse performed yet
  const showEntityDetails = hasSelection && peekFilename === null && !browsing;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Error banner */}
      {lastBrowseError && (
        <div className="shrink-0 flex items-start gap-2 px-3 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-400">
          <span className="font-semibold shrink-0">{t("explorer.grid.browseError")}</span>
          <span className="selectable break-all">{lastBrowseError}</span>
        </div>
      )}

      {showEntityDetails ? (
        <EntityDetailsPanel />
      ) : browsing ? (
        <OperationProgressPanel />
      ) : (
      <>
      {/* Body filter bar */}
      <BodyFilterBar
        value={gridFilters.body}
        onChange={(v) => setGridFilter("body", v)}
        rightSlot={
          peekMessages.length > 0 ? (
            <button
              onClick={() => void handleExport()}
              title="Export all loaded messages to a JSON file"
              className="ml-1 flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors whitespace-nowrap"
            >
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {t("explorer.grid.exportJson")}
            </button>
          ) : null
        }
      />

      {peekMessages.length > 0 && !selectedMessage && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-azure-primary/15 bg-azure-primary/5 dark:border-azure-primary/20 dark:bg-azure-primary/10">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-azure-primary">
            {t("explorer.properties.messageDetail")}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {t("explorer.properties.clickToInspect")}
          </span>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-800">
            <tr>
              <ColHeader label={t("explorer.grid.colIndex")} />
              <ColHeader label={t("explorer.grid.colEnqueuedTime")} />
              <ColHeader
                label={t("explorer.grid.colMessageId")}
                filterKey="messageId"
                filterActive={visibleFilters.has("messageId")}
                onFilterToggle={() => toggleFilter("messageId")}
              />
              <ColHeader
                label={t("explorer.grid.colDeadLetterReason")}
                filterKey="deadLetterReason"
                filterActive={visibleFilters.has("deadLetterReason")}
                onFilterToggle={() => toggleFilter("deadLetterReason")}
              />
              <ColHeader
                label={t("explorer.grid.colDeadLetterError")}
                filterKey="deadLetterErrorDescription"
                filterActive={visibleFilters.has("deadLetterErrorDescription")}
                onFilterToggle={() => toggleFilter("deadLetterErrorDescription")}
              />
            </tr>

            <FilterRow
              filters={gridFilters}
              visibleFilters={visibleFilters}
              onChange={(k, v) =>
                setGridFilter(
                  k as "messageId" | "deadLetterReason" | "deadLetterErrorDescription" | "body",
                  v
                )
              }
            />
          </thead>

          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {pageRows.length === 0 ? (
              <EmptyState
                message={
                  !hasSelection
                    ? t("explorer.grid.emptySelectEntity")
                    : peekFilename === null
                      ? t("explorer.grid.emptyNoBrowse")
                      : peekMessages.length === 0
                        ? t("explorer.grid.emptyNoMessages")
                        : t("explorer.grid.emptyNoMatch")
                }
              />
            ) : (
              pageRows.map((msg, idx) => (
                <MessageRow
                  key={msg.messageId ?? msg.sequenceNumber ?? idx}
                  msg={msg}
                  index={pageStart + idx + 1}
                  isSelected={selectedMessage === msg}
                  onClick={() => setSelectedMessage(msg === selectedMessage ? null : msg)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
        <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{t("explorer.grid.rowsPerPage")}</span>
          <select
            value={gridPageSize}
            onChange={(e) => setGridPageSize(Number(e.target.value))}
            className="text-xs px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-300 appearance-none select-custom-arrow pr-7 min-w-[4rem]"
          >
            {[25, 50, 100, 250, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="whitespace-nowrap tabular-nums">
            {filtered.length === 0
              ? t("explorer.grid.zeroMessages")
              : t("explorer.grid.messageRange", {
                  start: pageStart + 1,
                  end: Math.min(pageEnd, filtered.length),
                  total: filtered.length,
                })}
            {peekMessages.length !== filtered.length &&
              ` ${t("explorer.grid.filteredFrom", { total: peekMessages.length })}`}
          </span>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setGridPage(1)}
              disabled={safePage === 1}
              className="px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              ««
            </button>
            <button
              onClick={() => setGridPage(safePage - 1)}
              disabled={safePage === 1}
              className="px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              ‹
            </button>
            <span className="px-2">
              {safePage} / {totalPages}
            </span>
            <button
              onClick={() => setGridPage(safePage + 1)}
              disabled={safePage === totalPages}
              className="px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              ›
            </button>
            <button
              onClick={() => setGridPage(totalPages)}
              disabled={safePage === totalPages}
              className="px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              »»
            </button>
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

// ─── Message row ──────────────────────────────────────────────────────────────

interface MessageRowProps {
  msg: PeekedMessage;
  index: number;
  isSelected: boolean;
  onClick: () => void;
}

function MessageRow({ msg, index, isSelected, onClick }: MessageRowProps) {
  return (
    <tr
      onClick={onClick}
      className={[
        "cursor-pointer transition-colors",
        isSelected
          ? "bg-azure-primary/10 dark:bg-azure-primary/15"
          : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60",
      ].join(" ")}
    >
      <td className="px-3 py-2 text-zinc-400 dark:text-zinc-500 tabular-nums whitespace-nowrap">
        {index}
      </td>
      <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300 whitespace-nowrap tabular-nums">
        {formatTime(msg.enqueuedTimeUtc)}
      </td>
      <td className="px-3 py-2 text-azure-secondary dark:text-zinc-300 font-mono truncate max-w-[200px]">
        {msg.messageId ?? <span className="text-zinc-300 dark:text-zinc-600">—</span>}
      </td>
      <td className="px-3 py-2">
        {msg.deadLetterReason ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
            {msg.deadLetterReason}
          </span>
        ) : (
          <span className="text-zinc-300 dark:text-zinc-600">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400 truncate max-w-[200px]">
        {msg.deadLetterErrorDescription ?? (
          <span className="text-zinc-300 dark:text-zinc-600">—</span>
        )}
      </td>
    </tr>
  );
}

export { bodyString };
