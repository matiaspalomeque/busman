import { useTranslation } from "react-i18next";
import type { OperationCounts } from "../../schemas/operation";

export function OperationOutcomeSummary({ counts }: { counts: OperationCounts }) {
  const { t } = useTranslation();
  return <div className="space-y-1 text-[11px] text-zinc-600 dark:text-zinc-300">
    <p>{t("explorer.progress.confirmedCounts", { sent: counts.sent, settled: counts.settled })}</p>
    {(counts.sendUnconfirmed > 0 || counts.settlementUnconfirmed > 0) && <p className="text-amber-700 dark:text-amber-300">
      {t("explorer.progress.unconfirmedCounts", { sent: counts.sendUnconfirmed, settled: counts.settlementUnconfirmed })}
    </p>}
    {Object.keys(counts.sources).length > 1 && <details>
      <summary className="cursor-pointer">{t("explorer.progress.bySource")}</summary>
      {Object.entries(counts.sources).map(([source, value]) => <p key={source}>
        {t(`modeSelector.${source}`, source)}: {t("explorer.progress.confirmedCounts", { sent: value.sent, settled: value.settled })}
      </p>)}
    </details>}
  </div>;
}
