import { filterMessages } from "../../utils/messageSearch";
import { MAX_LOADED_MESSAGES, MAX_LOADED_BYTES } from "../../store/messageSlice";
import { useShallow } from "zustand/react/shallow";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/appStore";
import type { PeekedMessage } from "../../types";
import { EntityDetailsPanel } from "./EntityDetailsPanel";
import { messageOperationKey, type MessageOperation } from "../../utils/messageOperation";
import { logHandledError } from "../../utils/logging";
import { BodyFilterBar, ColHeader, EmptyState, FilterRow, FirstRunState, bodyString, formatTime } from "./MessageGridPresentation";

function pendingOperationLabel(t: ReturnType<typeof useTranslation>["t"], operation: MessageOperation): string {
  if (operation === "DeleteMessage") return t("explorer.grid.pendingDelete");
  if (operation === "ReplayMessage") return t("explorer.grid.pendingReplay");
  if (operation === "MoveMessage") return t("explorer.grid.pendingMove");
  return t("explorer.grid.pendingOperation");
}

// ─── MessageGrid ──────────────────────────────────────────────────────────────

export function MessageGrid() {
  const { t } = useTranslation();
  const {
    peekMessages,
    loadedMessageBytes,
    messageBudgetReached,
    clearPeekResults,
    hasBrowsed,
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
    pendingMessageOperations,
    lastBrowseError,
    setLastBrowseError,
    connections,
    setIsSettingsModalOpen,
  } = useAppStore(useShallow((state) => ({
    peekMessages: state.peekMessages,
    loadedMessageBytes: state.loadedMessageBytes,
    messageBudgetReached: state.messageBudgetReached,
    clearPeekResults: state.clearPeekResults,
    hasBrowsed: state.hasBrowsed,
    explorerSelection: state.explorerSelection,
    selectedMessage: state.selectedMessage,
    setSelectedMessage: state.setSelectedMessage,
    setMessageContextMenu: state.setMessageContextMenu,
    gridFilters: state.gridFilters,
    setGridFilter: state.setGridFilter,
    gridPage: state.gridPage,
    gridPageSize: state.gridPageSize,
    setGridPage: state.setGridPage,
    setGridPageSize: state.setGridPageSize,
    pendingMessageOperations: state.pendingMessageOperations,
    lastBrowseError: state.lastBrowseError,
    setLastBrowseError: state.setLastBrowseError,
    connections: state.connections,
    setIsSettingsModalOpen: state.setIsSettingsModalOpen,
  })));

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
  const filtered = useMemo(() => filterMessages(sortedMessages, gridFilters), [sortedMessages, gridFilters]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / gridPageSize));
  const safePage = Math.min(gridPage, totalPages);
  const pageStart = (safePage - 1) * gridPageSize;
  const pageEnd = pageStart + gridPageSize;
  const pageRows = filtered.slice(pageStart, pageEnd);

  const hasSelection = explorerSelection.kind !== "none";
  // Preserve the current workspace while bulk operations run. Progress is shown
  // in a floating tray so the details or message grid never gets replaced.
  const showEntityDetails = hasSelection && !hasBrowsed;

  return (
    <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
      {hasBrowsed && <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[10px] text-zinc-500 border-b border-zinc-200 dark:border-zinc-700">
        <span>{t("explorer.grid.loadedBudget", { count: peekMessages.length, max: MAX_LOADED_MESSAGES, size: (loadedMessageBytes / 1024 / 1024).toFixed(1), bytes: MAX_LOADED_BYTES / 1024 / 1024 })}</span>
        <button onClick={clearPeekResults} className="ml-auto text-azure-primary hover:underline">{t("explorer.grid.clearLoaded")}</button>
        {messageBudgetReached && <p role="status" className="w-full text-amber-700 dark:text-amber-300">{t("explorer.grid.budgetReached")}</p>}
      </div>}
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
      ) : (
      <>
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
                    : !hasBrowsed
                      ? t("explorer.grid.emptyNoBrowse")
                      : peekMessages.length === 0
                        ? t("explorer.grid.emptyNoMessages")
                        : t("explorer.grid.emptyNoMatch")
                }
                icon={
                  !hasSelection
                    ? "search"
                    : !hasBrowsed || peekMessages.length === 0
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
      <div className="shrink-0 flex flex-wrap gap-2 items-center justify-between px-3 py-2 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
        <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="whitespace-nowrap">{t("explorer.grid.rowsPerPage")}</span>
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

        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
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
            <span className="px-2 whitespace-nowrap">
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
