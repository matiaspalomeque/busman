import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { useScript } from "../../hooks/useScript";
import { useAppStore } from "../../store/appStore";
import { operationWasStopped } from "../../utils/operationOutcome";
import { Icon } from "../Common/Icon";
import { OperationOutcomeSummary } from "./OperationOutcomeSummary";
import { OperationErrorDetails } from "./OperationErrorDetails";

// ─── Operation progress ───────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

// ─── Atomic operation banner ──────────────────────────────────────────────────

export function AtomicOperationBanner() {
  const { t } = useTranslation();
  const runs = useAppStore((s) => s.activeOperationRuns);
  const { stop } = useScript();
  const atomicRuns = Object.entries(runs).filter(([, run]) => run.scope === "atomic");
  const pendingCount = atomicRuns.length;
  const error = atomicRuns.find(([, run]) => run.error)?.[1].error;
  if (pendingCount === 0) return null;

  return (
    <div role="status" className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-azure-primary/20 bg-azure-primary/5 dark:bg-azure-primary/10 text-xs">
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
      <button type="button" disabled={atomicRuns.every(([, run]) => run.phase === "stopRequested")} onClick={() => { for (const [id] of atomicRuns) void stop(id); }} className="ml-auto rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">
        {t("explorer.grid.stopMessageOperations")}
      </button>
      {error && <p role="alert" className="w-full text-amber-700 dark:text-amber-300">{error}</p>}
    </div>
  );
}

// ─── Operation status tray ────────────────────────────────────────────────────

export function OperationStatusTray() {
  const { t } = useTranslation();
  const { progress, eventLog, operationTrayRunId, dismissOperationTray, isRunning, operationScope, operationPhase, operationError } = useAppStore(useShallow((state) => ({
    progress: state.progress,
    eventLog: state.eventLog,
    operationTrayRunId: state.operationTrayRunId,
    dismissOperationTray: state.dismissOperationTray,
    isRunning: state.isRunning,
    operationScope: state.operationScope,
    operationPhase: state.operationPhase,
    operationError: state.operationError,
  })));
  const { stop } = useScript();
  const bulkRunning = isRunning && operationScope !== "atomic";
  const visibleRunId = operationTrayRunId;
  const entry = visibleRunId
    ? eventLog.find((candidate) => candidate.id === visibleRunId)
    : undefined;
  const operationRunning = bulkRunning || entry?.status === "running";
  const completed = !operationRunning && entry != null;

  if ((!operationRunning && !completed) || !visibleRunId) {
    return null;
  }

  const operation = entry?.operation ?? "Operation";
  const entity = entry?.entity ?? "";

  const counts = (operationRunning ? progress?.counts : entry?.outcome?.counts ?? entry?.checkpoint?.counts) ?? undefined;
  const count = counts?.settled ?? 0;
  const rate = progress && progress.elapsedMs > 0 ? Math.round(count * 1000 / progress.elapsedMs) : 0;
  const elapsed = progress ? formatElapsed(progress.elapsedMs) : "0:00";

  const isReceive = operation === "Receive";
  const isReplay = operation === "Replay";

  const accentClass = completed
    ? entry.status === "success"
      ? "text-green-600 dark:text-green-400"
      : entry.status === "unknown"
        ? "text-amber-700 dark:text-amber-300"
        : entry.status === "error"
          ? "text-red-600 dark:text-red-400"
          : "text-zinc-500 dark:text-zinc-400"
    : isReceive
      ? "text-red-500 dark:text-red-400"
      : isReplay
        ? "text-amber-500 dark:text-amber-400"
        : "text-azure-primary";

  const barClass = isReceive
    ? "bg-red-500"
    : isReplay
      ? "bg-amber-500"
      : "bg-azure-primary";

  const handleCancel = stop;

  const stopping = operationRunning && operationPhase === "stopRequested";
  const statusLabel = stopping ? t("explorer.progress.stopRequested") :
    operationRunning ? t(operationPhase === "unknown" ? "explorer.eventLog.statusUnknown" : "explorer.eventLog.statusRunning") :
    entry?.status === "unknown" ? t(operationWasStopped(entry) ? "explorer.eventLog.statusStoppedUnknown" : "explorer.eventLog.statusUnknown") :
    entry?.status === "success"
      ? t("explorer.eventLog.statusOk")
      : entry?.status === "error"
        ? t("explorer.eventLog.statusError")
        : entry?.status === "stopped"
          ? t("explorer.eventLog.statusStopped")
          : t("explorer.eventLog.statusRunning");
  const iconName = isReceive ? "trash" : isReplay ? "refresh" : "move";

  return (
    <aside
      role={entry?.status === "error" ? "alert" : "status"}
      aria-live={entry?.status === "error" ? "assertive" : "polite"}
      className="absolute bottom-14 right-3 z-30 w-[min(26rem,calc(100%-1.5rem))] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="flex items-start gap-3 px-3 py-3">
        <div className={`mt-0.5 rounded-md bg-zinc-100 p-2 dark:bg-zinc-800 ${accentClass}`}>
          <Icon name={iconName} size={16} className={operationRunning ? "animate-pulse" : ""} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">
              {operationRunning && !stopping ? t("explorer.progress.inProgress", { operation }) : operation}
            </span>
            <span className={`shrink-0 text-[10px] font-semibold ${accentClass}`}>{statusLabel}</span>
          </div>
          {entity && (
            <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400" title={entity}>
              {entity}
            </div>
          )}

          {(operationRunning || counts || entry?.status === "unknown") && <div className="mt-2"><OperationOutcomeSummary counts={counts} operation={entry?.operation ?? "Move"} isRunning={operationRunning} needsReview={entry?.status === "unknown"} /></div>}
          {stopping && <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{t("explorer.progress.stoppingHelp")}</p>}
          {operationError && <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-300">{operationError}</p>}
          {operationRunning ? (
            <>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                <span>{t("explorer.progress.processed")}: <strong className="font-mono text-zinc-700 dark:text-zinc-200">{count > 0 ? count.toLocaleString() : "—"}</strong></span>
                <span>{t("explorer.progress.rate")}: <strong className="font-mono text-zinc-700 dark:text-zinc-200">{rate > 0 ? `${rate.toLocaleString()}/s` : "—"}</strong></span>
                <span>{t("explorer.progress.elapsed")}: <strong className="font-mono text-zinc-700 dark:text-zinc-200">{elapsed}</strong></span>
              </div>
              <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                <div
                  className={`h-full w-[45%] rounded-full ${barClass}`}
                  style={{ animation: "indeterminate 1.4s linear infinite" }}
                />
              </div>
            </>
          ) : entry ? <OperationErrorDetails entry={entry} /> : null}
        </div>

        {bulkRunning ? (
          <button
            type="button"
            onClick={() => void handleCancel()}
            disabled={operationPhase === "stopRequested"}
            className="shrink-0 rounded border border-zinc-300 px-2.5 py-1 text-[10px] font-medium text-zinc-600 hover:border-red-400 hover:bg-red-50 hover:text-red-600 dark:border-zinc-600 dark:text-zinc-300 dark:hover:border-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
          >
            {t(operationPhase === "stopRequested" ? "explorer.progress.stopRequested" : "explorer.toolbar.stop")}
          </button>
        ) : completed ? (
          <button
            type="button"
            onClick={dismissOperationTray}
            aria-label={t("explorer.sendModal.close")}
            title={t("explorer.sendModal.close")}
            className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </div>
    </aside>
  );
}
