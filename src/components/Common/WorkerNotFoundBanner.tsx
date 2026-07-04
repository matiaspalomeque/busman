import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

export function WorkerNotFoundBanner() {
  const { t } = useTranslation();
  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-amber-800 shadow-sm dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
      role="alert"
    >
      <Icon name="alertTriangle" size={16} className="mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
      <span className="text-sm font-medium">
        {t("worker.unavailable")}
      </span>
      <span className="min-w-0 text-sm text-amber-700 dark:text-amber-300">
        {t("worker.details")}
      </span>
    </div>
  );
}
