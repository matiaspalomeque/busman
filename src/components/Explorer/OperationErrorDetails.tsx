import { useTranslation } from "react-i18next";
import type { EventLogEntry } from "../../types";
import { operationWasStopped } from "../../utils/operationOutcome";

export function OperationErrorDetails({ entry }: { entry: EventLogEntry }) {
  const { t } = useTranslation();
  const message = entry.errorMessage ?? entry.outcome?.errorMessage;
  if (!message) return null;
  if (operationWasStopped(entry) || entry.status === "unknown") {
    return <details className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
      <summary className="cursor-pointer">{t("explorer.eventLog.technicalDetails")}</summary>
      <p className="mt-1 max-h-32 overflow-auto selectable break-words">{message}</p>
    </details>;
  }
  return <p className="mt-2 max-h-32 overflow-auto selectable break-words text-[11px] text-red-600 dark:text-red-400">{message}</p>;
}
