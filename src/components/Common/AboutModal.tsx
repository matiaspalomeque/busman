import { useTranslation } from "react-i18next";
import logo from "../../../src-tauri/icons/128x128@2x.png";
import { version as APP_VERSION } from "../../../package.json";
import { useEscapeKey } from "../../hooks/useEscapeKey";

interface Props {
  onClose: () => void;
}

export function AboutModal({ onClose }: Props) {
  const { t } = useTranslation();
  useEscapeKey(onClose);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-modal-title"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-azure-secondary sm:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: logo panel */}
        <div className="flex flex-shrink-0 items-center justify-center bg-azure-secondary/5 dark:bg-azure-dark/60">
          <img src={logo} alt="Busman" className="h-24 w-24 object-cover sm:h-48 sm:w-48" />
        </div>

        {/* Right: content */}
        <div className="flex min-w-0 flex-1 flex-col p-6">
          <h2 id="about-modal-title" className="mb-4 text-lg font-semibold text-azure-dark dark:text-azure-light">
            {t("about.title")}
          </h2>

          <div className="mb-4 flex-1 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-azure-dark/70 dark:text-azure-light/50">{t("about.version")}</span>
              <span className="font-mono text-azure-dark dark:text-azure-light">{APP_VERSION}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-azure-dark/70 dark:text-azure-light/50">{t("about.author")}</span>
              <span className="truncate text-azure-dark dark:text-azure-light">Matías Palomeque</span>
            </div>
            <p className="text-azure-dark/80 dark:text-azure-light/60 pt-2 border-t border-azure-secondary/10 dark:border-azure-secondary/60">
              {t("about.description")}
            </p>
          </div>

          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md border border-azure-secondary/20 dark:border-azure-secondary/60 text-azure-dark/90 dark:text-azure-light/70 hover:bg-azure-secondary/10 dark:hover:bg-azure-dark transition-colors"
            >
              {t("about.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
