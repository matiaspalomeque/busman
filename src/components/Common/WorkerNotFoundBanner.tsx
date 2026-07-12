import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

interface WorkerNotFoundBannerProps {
  retrying: boolean;
  onRetry: () => void;
  onManageConnections: () => void;
}

export function WorkerNotFoundBanner({ retrying, onRetry, onManageConnections }: WorkerNotFoundBannerProps) {
  const { t } = useTranslation();
  return (
    <div
      className="z-50 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-amber-900 shadow-sm dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100"
      role="alert"
    >
      <Icon name="alertTriangle" size={16} className="mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
      <span className="text-sm font-medium">
        {t("worker.unavailable")}
      </span>
      <span className="min-w-0 flex-1 text-sm text-amber-800 dark:text-amber-200">
        {t("worker.details")}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onManageConnections}
          className="min-h-9 rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-600 dark:border-amber-700 dark:hover:bg-amber-900/50"
        >
          {t("worker.manageConnections")}
        </button>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="min-h-9 rounded-md bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-60 dark:bg-amber-600 dark:hover:bg-amber-500 dark:focus:ring-offset-amber-950"
        >
          {retrying ? t("worker.retrying") : t("worker.retry")}
        </button>
      </div>
    </div>
  );
}
