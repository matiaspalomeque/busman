import { useTranslation } from "react-i18next";
import type { OperationCounts } from "../../schemas/operation";
import type { EventLogEntry } from "../../types";

export function OperationOutcomeSummary({ counts, operation, isRunning, needsReview = false }: {
  counts?: OperationCounts; operation: EventLogEntry["operation"]; isRunning: boolean; needsReview?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const removalOnly = operation === "Receive" || operation === "DeleteMessage";
  const confirmedCounts = (sent: number, settled: number) => t(
    removalOnly ? "explorer.progress.confirmedRemovals" : "explorer.progress.confirmedCounts",
    { sent: sent.toLocaleString(i18n.language), settled: settled.toLocaleString(i18n.language) },
  );
  const sendUnconfirmed = counts?.sendUnconfirmed ?? 0;
  const settlementUnconfirmed = counts?.settlementUnconfirmed ?? 0;
  const warning = !isRunning && (needsReview || sendUnconfirmed > 0 || settlementUnconfirmed > 0);
  return <div className="space-y-1 text-[11px] text-zinc-600 dark:text-zinc-300">
    {(counts || isRunning) && <p className="tabular-nums">{confirmedCounts(counts?.sent ?? 0, counts?.settled ?? 0)}</p>}
    {warning && <p className="text-amber-700 dark:text-amber-300">
      {[
        sendUnconfirmed > 0 && t("explorer.progress.unconfirmedSends", { count: sendUnconfirmed }),
        settlementUnconfirmed > 0 && t("explorer.progress.unconfirmedRemovals", { count: settlementUnconfirmed }),
        t(removalOnly ? "explorer.eventLog.reconcileRemoval" : "explorer.eventLog.reconcile"),
      ].filter(Boolean).join(" ")}
    </p>}
    {!isRunning && counts && Object.keys(counts.sources).length > 1 && <details>
      <summary className="cursor-pointer">{t("explorer.progress.bySource")}</summary>
      {Object.entries(counts.sources).map(([source, value]) => <p key={source}>
        {t(`modeSelector.${source}`, source)}: {confirmedCounts(value.sent, value.settled)}
      </p>)}
    </details>}
  </div>;
}
