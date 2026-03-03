import { useTranslation } from "react-i18next";

export function WorkerNotFoundBanner() {
  const { t } = useTranslation();
  return (
    <div className="fixed top-0 inset-x-0 z-50 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-700 px-4 py-2 flex items-center gap-3">
      <span className="text-amber-700 dark:text-amber-300 font-medium text-sm">
        {t("worker.unavailable")}
      </span>
      <span className="text-sm text-amber-600 dark:text-amber-400">
        {t("worker.details")}
      </span>
    </div>
  );
}
