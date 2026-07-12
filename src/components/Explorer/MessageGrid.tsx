import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/appStore";
import type { PeekedMessage } from "../../types";
import { EntityDetailsPanel } from "./EntityDetailsPanel";
import { Icon } from "../Common/Icon";
import { messageOperationKey, type MessageOperation } from "../../utils/messageOperation";
import { logHandledError } from "../../utils/logging";

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
              aria-label={`${t("explorer.grid.filterTitle")} ${key}`}
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
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
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
        aria-label={t("explorer.grid.searchBody")}
        className="min-w-[14rem] flex-1 text-xs px-2 py-1 rounded border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={t("explorer.grid.clearBodyFilter")}
          title={t("explorer.grid.clearBodyFilter")}
          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-xs focus:outline-none focus:ring-1 focus:ring-azure-primary rounded"
        >
          ✕
        </button>
      )}
      {rightSlot}
    </div>
  );
}

// ─── Column header ────────────────────────────────────────────────────────────

type FilterKey = "messageId" | "deadLetterReason" | "deadLetterErrorDescription" | "body";
type SortKey = "enqueuedTimeUtc" | "messageId";

function ColHeader({
  label,
  filterKey,
  filterActive,
  onFilterToggle,
  sortKey,
  sortColumn,
  sortDirection,
  onSort,
}: {
  label: string;
  filterKey?: FilterKey;
  filterActive?: boolean;
  onFilterToggle?: () => void;
  sortKey?: SortKey;
  sortColumn?: SortKey | null;
  sortDirection?: "asc" | "desc";
  onSort?: (column: SortKey) => void;
}) {
  const { t } = useTranslation();
  const sortable = Boolean(sortKey && onSort);
  const isSorted = sortable && sortColumn === sortKey;
  const triggerSort = () => {
    if (sortKey && onSort) onSort(sortKey);
  };
  return (
    <th
      scope="col"
      aria-sort={isSorted ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}
      className="px-3 py-2.5 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700"
    >
      <div className="flex items-center gap-1">
        <span
          className={`flex-1 ${sortable ? "cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300 select-none" : ""}`}
          onClick={sortable ? triggerSort : undefined}
        >
          {label}
        </span>
        {sortable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              triggerSort();
            }}
            aria-label={`${t("explorer.grid.sortTitle")} ${label}`}
            className="p-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 focus:outline-none focus:ring-1 focus:ring-azure-primary"
            title={t("explorer.grid.sortTitle")}
          >
            <Icon
              name="chevronDown"
              size={10}
              className={
                isSorted
                  ? `transform ${sortDirection === "desc" ? "rotate-180" : ""}`
                  : "opacity-30"
              }
            />
          </button>
        )}
        {filterKey && onFilterToggle && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFilterToggle();
            }}
            aria-pressed={filterActive}
            aria-label={`${t("explorer.grid.filterTitle")} ${label}`}
            className={`p-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
              filterActive ? "text-azure-primary" : "text-zinc-400"
            } focus:outline-none focus:ring-1 focus:ring-azure-primary`}
            title={t("explorer.grid.filterTitle")}
          >
            <Icon name="search" size={10} />
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

// ─── Atomic operation banner ──────────────────────────────────────────────────

function AtomicOperationBanner() {
  const { t } = useTranslation();
  const pendingCount = useAppStore((s) => Object.keys(s.pendingMessageOperations).length);
  if (pendingCount === 0) return null;

  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-azure-primary/20 bg-azure-primary/5 dark:bg-azure-primary/10 text-xs">
      <svg
        className="animate-spin shrink-0 text-azure-primary"
        width={12}
        height={12}
        viewBox="0 0 24 24"
        fill="none"
      >
        <circle cx={12} cy={12} r={10} stroke="currentColor" strokeWidth={3} strokeOpacity={0.2} />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
      </svg>
      <span className="font-medium text-azure-primary">
        {t("explorer.grid.messageOperationsRunning", { count: pendingCount })}
      </span>
    </div>
  );
}

function pendingOperationLabel(t: ReturnType<typeof useTranslation>["t"], operation: MessageOperation): string {
  if (operation === "DeleteMessage") return t("explorer.grid.pendingDelete");
  if (operation === "ReplayMessage") return t("explorer.grid.pendingReplay");
  if (operation === "MoveMessage") return t("explorer.grid.pendingMove");
  return t("explorer.grid.pendingOperation");
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
    } catch (error) {
      logHandledError("Failed to cancel running operation", error, { runId });
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

function EmptyState({ message, icon = "search" }: { message: string; icon?: "search" | "box" | "alertTriangle" }) {
  const { t } = useTranslation();
  return (
    <tr>
      <td colSpan={5} className="px-4 py-16 text-center">
        <div className="flex flex-col items-center justify-center gap-4 animate-fade-in">
          <div className="w-16 h-16 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
            <Icon name={icon} size={32} className="text-zinc-300 dark:text-zinc-600" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{message}</p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">{t("explorer.grid.emptyHint")}</p>
          </div>
        </div>
      </td>
    </tr>
  );
}

function FirstRunState({ hasConnections, onManageConnections }: { hasConnections: boolean; onManageConnections: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10 text-center">
      <div className="flex max-w-sm flex-col items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-azure-primary/10 text-azure-primary">
          <Icon name="server" size={30} />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
            {hasConnections ? t("explorer.grid.emptySelectEntity") : t("explorer.grid.emptyNoConnection")}
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            {hasConnections ? t("explorer.grid.emptySelectEntityHint") : t("explorer.grid.emptyNoConnectionHint")}
          </p>
        </div>
        <button
          type="button"
          onClick={onManageConnections}
          className="min-h-11 rounded-lg bg-azure-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-azure-600 focus:outline-none focus:ring-2 focus:ring-azure-primary focus:ring-offset-2 dark:focus:ring-offset-zinc-900"
        >
          {hasConnections ? t("explorer.grid.manageConnections") : t("explorer.grid.addConnection")}
        </button>
      </div>
    </div>
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
    setMessageContextMenu,
    gridFilters,
    setGridFilter,
    gridPage,
    gridPageSize,
    setGridPage,
    setGridPageSize,
    isRunning,
    operationScope,
    pendingMessageOperations,
    lastBrowseError,
    setLastBrowseError,
    connections,
    setIsSettingsModalOpen,
  } = useAppStore();

  // Track which column filter inputs are visible
  const [visibleFilters, setVisibleFilters] = useState<Set<string>>(new Set());
  
  // Track sorting state
  const [sortColumn, setSortColumn] = useState<"enqueuedTimeUtc" | "messageId" | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  // Apply sorting to filtered messages
  const sortedMessages = useMemo(() => {
    if (!sortColumn) return peekMessages;
    
    return [...peekMessages].sort((a, b) => {
      let comparison = 0;
      
      if (sortColumn === "enqueuedTimeUtc") {
        const aTime = a.enqueuedTimeUtc ? new Date(a.enqueuedTimeUtc).getTime() : 0;
        const bTime = b.enqueuedTimeUtc ? new Date(b.enqueuedTimeUtc).getTime() : 0;
        comparison = aTime - bTime;
      } else if (sortColumn === "messageId") {
        comparison = (a.messageId || "").localeCompare(b.messageId || "");
      }
      
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [peekMessages, sortColumn, sortDirection]);

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
      logHandledError("Failed to export messages", err, {
        path,
        messageCount: peekMessages.length,
        selection: explorerSelection,
      });
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

  const handleSort = (column: "enqueuedTimeUtc" | "messageId") => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  // Apply client-side filters to sorted messages
  const filtered = sortedMessages.filter((msg) => {
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
  const atomicRunning = Object.keys(pendingMessageOperations).length > 0;
  const browsing = isRunning && operationScope !== "atomic";

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

      {!hasSelection ? (
        <FirstRunState
          hasConnections={connections.length > 0}
          onManageConnections={() => setIsSettingsModalOpen(true, "connections")}
        />
      ) : showEntityDetails ? (
        <EntityDetailsPanel />
      ) : browsing ? (
        <OperationProgressPanel />
      ) : (
      <>
      {atomicRunning && <AtomicOperationBanner />}
      {/* Body filter bar */}
      <BodyFilterBar
        value={gridFilters.body}
        onChange={(v) => setGridFilter("body", v)}
        rightSlot={
          peekMessages.length > 0 ? (
            <button
              type="button"
              onClick={() => void handleExport()}
              title="Export all loaded messages to a JSON file"
              aria-label={t("explorer.grid.exportJson")}
              className="ml-1 flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 focus:outline-none focus:ring-1 focus:ring-azure-primary transition-colors whitespace-nowrap"
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

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full min-w-[640px] text-xs border-collapse table-fixed">
          <thead className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-800">
            <tr>
              <ColHeader label={t("explorer.grid.colIndex")} />
              <ColHeader
                label={t("explorer.grid.colEnqueuedTime")}
                sortKey="enqueuedTimeUtc"
                sortColumn={sortColumn}
                sortDirection={sortDirection}
                onSort={handleSort}
              />
              <ColHeader
                label={t("explorer.grid.colMessageId")}
                filterKey="messageId"
                filterActive={visibleFilters.has("messageId")}
                onFilterToggle={() => toggleFilter("messageId")}
                sortKey="messageId"
                sortColumn={sortColumn}
                sortDirection={sortDirection}
                onSort={handleSort}
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
                icon={
                  !hasSelection
                    ? "search"
                    : peekFilename === null || peekMessages.length === 0
                      ? "box"
                      : "search"
                }
              />
            ) : (
              pageRows.map((msg, idx) => (
                (() => {
                  const pendingKey = messageOperationKey(msg);
                  const pendingOperation = pendingKey ? pendingMessageOperations[pendingKey] : undefined;
                  return (
                    <MessageRow
                      key={pendingKey ?? msg.messageId ?? idx}
                      msg={msg}
                      index={pageStart + idx + 1}
                      isSelected={selectedMessage === msg}
                      pendingOperation={pendingOperation?.operation}
                      onClick={() => {
                        if (pendingOperation) return;
                        setSelectedMessage(msg === selectedMessage ? null : msg);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (pendingOperation) return;
                        setMessageContextMenu({ x: e.clientX, y: e.clientY, msg });
                      }}
                    />
                  );
                })()
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
            aria-label={t("explorer.grid.rowsPerPage")}
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
              type="button"
              onClick={() => setGridPage(1)}
              disabled={safePage === 1}
              aria-label={t("explorer.grid.firstPage")}
              title={t("explorer.grid.firstPage")}
              className="px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700 focus:outline-none focus:ring-1 focus:ring-azure-primary"
            >
              ««
            </button>
            <button
              type="button"
              onClick={() => setGridPage(safePage - 1)}
              disabled={safePage === 1}
              aria-label={t("explorer.grid.previousPage")}
              title={t("explorer.grid.previousPage")}
              className="px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700 focus:outline-none focus:ring-1 focus:ring-azure-primary"
            >
              ‹
            </button>
            <span className="px-2">
              {safePage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setGridPage(safePage + 1)}
              disabled={safePage === totalPages}
              aria-label={t("explorer.grid.nextPage")}
              title={t("explorer.grid.nextPage")}
              className="px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700 focus:outline-none focus:ring-1 focus:ring-azure-primary"
            >
              ›
            </button>
            <button
              type="button"
              onClick={() => setGridPage(totalPages)}
              disabled={safePage === totalPages}
              aria-label={t("explorer.grid.lastPage")}
              title={t("explorer.grid.lastPage")}
              className="px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700 focus:outline-none focus:ring-1 focus:ring-azure-primary"
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
  pendingOperation?: MessageOperation;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function MessageRow({ msg, index, isSelected, pendingOperation, onClick, onContextMenu }: MessageRowProps) {
  const { t } = useTranslation();
  if (pendingOperation) {
    const skeleton = "h-3 rounded bg-zinc-200 dark:bg-zinc-700";
    return (
      <tr
        aria-busy="true"
        className="animate-pulse bg-zinc-50 dark:bg-zinc-800/50"
      >
        <td className="px-3 py-2 text-zinc-400 dark:text-zinc-500 tabular-nums whitespace-nowrap">
          {index}
        </td>
        <td className="px-3 py-2">
          <div className={`${skeleton} w-28`} />
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 border-2 border-azure-primary border-t-transparent rounded-full animate-spin shrink-0" />
            <span className="text-[11px] font-medium text-azure-primary whitespace-nowrap">
              {pendingOperationLabel(t, pendingOperation)}
            </span>
            <div className={`${skeleton} flex-1 max-w-[120px]`} />
          </div>
        </td>
        <td className="px-3 py-2">
          <div className={`${skeleton} w-20`} />
        </td>
        <td className="px-3 py-2">
          <div className={`${skeleton} w-32`} />
        </td>
      </tr>
    );
  }

  return (
    <tr
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      aria-selected={isSelected}
      className={[
        "cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-azure-primary/50",
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
      <td
        className="px-3 py-2 text-azure-secondary dark:text-zinc-300 font-mono truncate"
        title={msg.messageId ?? undefined}
      >
        {msg.messageId ?? <span className="text-zinc-300 dark:text-zinc-600">—</span>}
      </td>
      <td className="px-3 py-2">
        {msg.deadLetterReason ? (
          <span
            className="inline-flex max-w-full items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 truncate"
            title={msg.deadLetterReason}
          >
            {msg.deadLetterReason}
          </span>
        ) : (
          <span className="text-zinc-300 dark:text-zinc-600">—</span>
        )}
      </td>
      <td
        className="px-3 py-2 text-zinc-500 dark:text-zinc-400 truncate"
        title={msg.deadLetterErrorDescription ?? undefined}
      >
        {msg.deadLetterErrorDescription ?? (
          <span className="text-zinc-300 dark:text-zinc-600">—</span>
        )}
      </td>
    </tr>
  );
}

export { bodyString };
