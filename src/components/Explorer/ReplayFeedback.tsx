import { useTranslation } from "react-i18next";
import type { EventLogEntry } from "../../types";

export function ReplayFeedback({ entry }: { entry: EventLogEntry }) {
  const { t } = useTranslation();
  if (entry.status !== "success" || !entry.scope?.replaySource) return null;
  const returned = entry.replayReturn;
  return (
    <div role="status" className={`p-3 text-xs break-words ${returned ? "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200" : "bg-zinc-50 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"}`}>
      <p className="font-medium">{t(returned ? "explorer.replayFeedback.returned" : "explorer.replayFeedback.sent")}</p>
      <p className="mt-1">{returned
        ? t("explorer.replayFeedback.observed", { time: new Date(returned.observedAt).toLocaleString(), sequence: returned.sequenceNumber })
        : t("explorer.replayFeedback.checkOnBrowse")}</p>
    </div>
  );
}
