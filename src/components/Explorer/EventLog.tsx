import { useShallow } from "zustand/react/shallow";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { journalMetadata } from "../../store/operationJournal";
import { ReplayFeedback } from "./ReplayFeedback";
import { OperationOutcomeSummary } from "./OperationOutcomeSummary";
import { useRef, useState } from "react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/appStore";
import type { EventLogEntry } from "../../types";

const PAGE_SIZES = [10, 25, 50] as const;

function OperationDetails({ entry, onClose }: { entry: EventLogEntry; onClose: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  useEscapeKey(onClose);
  const counts = entry.outcome?.counts ?? entry.checkpoint?.counts;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="operation-details-title" className="w-full max-w-xl max-h-[90vh] overflow-auto rounded-lg border border-zinc-300 bg-white p-5 text-sm text-zinc-800 shadow-xl dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="operation-details-title" className="font-semibold">{t("explorer.eventLog.result")}</h2>
          <button type="button" onClick={onClose} className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-600">{t("explorer.sendModal.close")}</button>
        </div>
        <p className="break-words font-medium">{entry.namespace} · {entry.entity}</p>
        <div className="my-3"><StatusBadge status={entry.status} replayed={!!entry.scope?.replaySource} returned={!!entry.replayReturn} /></div>
        <ReplayFeedback entry={entry} />
        {counts && <OperationOutcomeSummary counts={counts} />}
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">{entry.outcome?.finishedAt ? new Date(entry.outcome.finishedAt).toLocaleString() : t("explorer.eventLog.lastObserved", { time: entry.checkpoint?.at })}</p>
        {entry.scope && <p className="mt-2 break-words">{entry.scope.mode} → {entry.scope.destination || "—"}</p>}
        {entry.status === "unknown" && <p className="mt-3 text-amber-700 dark:text-amber-300">{t("explorer.eventLog.reconcile")}</p>}
        {entry.errorMessage && <p className="mt-3 break-words text-red-600 dark:text-red-400">{entry.errorMessage}</p>}
      </div>
    </div>
  );
}

function StatusBadge({ status, replayed = false, returned = false }: { status: EventLogEntry["status"]; replayed?: boolean; returned?: boolean }) {
  const { t } = useTranslation();
  const styles =
    status === "success" && returned
      ? "bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300"
      : status === "success"
      ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
      : status === "running"
        ? "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 animate-pulse"
        : status === "stopped"
          ? "bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400"
          : "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400";

  return (
    <span
      title={status}
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${styles}`}
    >
      {status === "unknown" ? t("explorer.eventLog.statusUnknown") : status === "running"
        ? t("explorer.eventLog.statusRunning")
        : status === "success"
          ? t(returned ? "explorer.replayFeedback.returnedBadge" : replayed ? "explorer.replayFeedback.sentBadge" : "explorer.eventLog.statusOk")
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
  const { eventLog, clearEventLog, isRunning, journalError, reconcileOperation } = useAppStore(useShallow((state) => ({
    eventLog: state.eventLog,
    clearEventLog: state.clearEventLog,
    isRunning: state.isRunning,
    journalError: state.journalError,
    reconcileOperation: state.reconcileOperation,
  })));
  const [exportError, setExportError] = useState<string | null>(null);
  const exportJournal = async () => {
    try {
      const path = await save({ defaultPath: "busman-operation-journal.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      await invoke("write_json_file", { path, content: JSON.stringify({ version: 1, entries: journalMetadata(eventLog) }, null, 2) });
      setExportError(null);
    } catch (error) { setExportError(String(error)); }
  };

  const [collapsed, setCollapsed] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const detailsEntry = eventLog.find((entry) => entry.id === detailsId);

  const totalPages = Math.max(1, Math.ceil(eventLog.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = eventLog.slice((safePage - 1) * pageSize, safePage * pageSize);
  const returnedEntries = eventLog.filter((entry) => entry.status === "success" && entry.replayReturn);
  const unknownCount = eventLog.filter((entry) => entry.status === "unknown" && !entry.reconciledAt).length;

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
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          title={t("explorer.eventLog.title")}
          className="flex items-center gap-1 text-xs font-semibold text-zinc-600 dark:text-zinc-300 hover:text-azure-primary focus:outline-none focus:ring-1 focus:ring-azure-primary rounded transition-colors"
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

        {unknownCount > 0 && <button type="button" onClick={() => setCollapsed(false)} className="text-[10px] text-amber-700 dark:text-amber-300 hover:underline">{unknownCount} · {t("explorer.eventLog.needsReview")}</button>}
        {returnedEntries.length > 0 && <button type="button" onClick={() => setDetailsId(returnedEntries[0].id)} className="text-[10px] text-amber-700 dark:text-amber-300 hover:underline">{t("explorer.replayFeedback.returnedCount", { count: returnedEntries.length })}</button>}
        <button type="button" onClick={() => void exportJournal()} className="ml-auto text-[10px] text-azure-primary hover:underline">{t("explorer.eventLog.export")}</button>
        <button
          type="button"
          onClick={() => { clearEventLog(); setPage(1); setDetailsId(null); }}
          disabled={eventLog.length === 0 || isRunning || unknownCount > 0 || eventLog.some((entry) => entry.status === "running")}
          title={t("explorer.eventLog.clearHelp")}
          className="text-[10px] text-azure-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
        >{t("explorer.eventLog.clear")}</button>
        {(journalError || exportError) && <span role="alert" className="text-[10px] text-red-600" title={journalError ?? exportError ?? ""}>{t("explorer.eventLog.saveError")}</span>}
        {/* Running indicator */}
        {isRunning && (
          <span className="flex items-center gap-1.5 ml-1" role="status">
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
              <span className="text-[10px] text-zinc-600 dark:text-zinc-300">{t("explorer.eventLog.rows")}</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value) as (typeof PAGE_SIZES)[number]);
                  setPage(1);
                }}
                aria-label={t("explorer.eventLog.rows")}
                className="text-[10px] w-12 px-1 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-300 appearance-none select-custom-arrow pr-4"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            {/* Pagination */}
            <div className="flex items-center gap-1 text-[10px] text-zinc-600 dark:text-zinc-300">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage === 1}
                aria-label={t("explorer.eventLog.previousPage")}
                title={t("explorer.eventLog.previousPage")}
                className="px-1 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700 focus:outline-none focus:ring-1 focus:ring-azure-primary"
              >
                ‹
              </button>
              <span>
                {safePage}/{totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
                aria-label={t("explorer.eventLog.nextPage")}
                title={t("explorer.eventLog.nextPage")}
                className="px-1 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-700 focus:outline-none focus:ring-1 focus:ring-azure-primary"
              >
                ›
              </button>
            </div>
          </>
        )}
      </div>

      {/* Table */}
      {!collapsed && (
        <div className="flex-1 overflow-auto">
          {eventLog.length === 0 ? (
            <div className="flex items-center justify-center h-full px-3 text-center text-xs text-zinc-600 dark:text-zinc-300">
              {t("explorer.eventLog.noOperations")}
            </div>
          ) : (
            <table className="w-full min-w-[900px] text-[10px] border-collapse table-fixed">
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
                      className="px-3 py-1 text-zinc-600 dark:text-zinc-300 truncate"
                      title={entry.namespace}
                    >
                      {entry.namespace}
                    </td>
                    <td
                      className="px-3 py-1 text-zinc-600 dark:text-zinc-300 truncate"
                      title={entry.entity}
                    >
                      {entry.entity}
                    </td>
                    <td className="px-3 py-1 text-zinc-500 dark:text-zinc-400">
                      {entry.entityType}
                    </td>
                    <td className="px-3 py-1 text-zinc-600 dark:text-zinc-300">
                      {entry.operation === "Receive" ? t("explorer.toolbar.receive") : entry.operation}
                    </td>
                    <td className="px-3 py-1">
                      <StatusBadge status={entry.status} replayed={!!entry.scope?.replaySource} returned={!!entry.replayReturn} />
                      {entry.status === "unknown" && !entry.reconciledAt && <button onClick={() => reconcileOperation(entry.id)} title={t("explorer.eventLog.reviewedHelp")} className="block mt-1 text-azure-primary underline">{t("explorer.eventLog.reviewed")}</button>}
                      {entry.reconciledAt && <span className="block text-zinc-500">{t("explorer.eventLog.reviewedAt", { time: new Date(entry.reconciledAt).toLocaleString() })}</span>}
                    </td>
                    <td
                      className="px-3 py-1 text-red-500 dark:text-red-400 truncate"
                      title={entry.errorMessage}
                    >
                      {(entry.outcome || entry.checkpoint || entry.scope?.replaySource) && <button type="button" aria-haspopup="dialog" onClick={() => setDetailsId(entry.id)} className="block text-azure-primary underline">{t("explorer.eventLog.result")}</button>}
                      {entry.status === "unknown" ? <span title={t("explorer.eventLog.reconcile")}>{t("explorer.eventLog.reconcile")}</span> : entry.errorMessage ?? (entry.outcome ? null : <span className="text-zinc-300 dark:text-zinc-600">—</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {detailsEntry && <OperationDetails entry={detailsEntry} onClose={() => setDetailsId(null)} />}
    </footer>
  );
}
