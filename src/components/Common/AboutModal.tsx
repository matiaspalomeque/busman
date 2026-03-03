import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import logo from "../../assets/logo.png";
import { version as APP_VERSION } from "../../../package.json";

interface Props {
  onClose: () => void;
}

export function AboutModal({ onClose }: Props) {
  const { t } = useTranslation();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("about.title")}
    >
      <div
        className="bg-white dark:bg-azure-secondary rounded-xl shadow-xl overflow-hidden max-w-md w-full mx-4 flex"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: logo panel */}
        <div className="flex items-center justify-center bg-azure-secondary/5 dark:bg-azure-dark/60 flex-shrink-0">
          <img src={logo} alt="Busman" className="w-48 h-48 object-cover" />
        </div>

        {/* Right: content */}
        <div className="flex-1 p-6 flex flex-col">
          <h2 className="text-lg font-semibold text-azure-dark dark:text-azure-light mb-4">
            {t("about.title")}
          </h2>

          <div className="space-y-2 text-sm mb-4 flex-1">
            <div className="flex justify-between">
              <span className="text-azure-dark/70 dark:text-azure-light/50">{t("about.version")}</span>
              <span className="font-mono text-azure-dark dark:text-azure-light">{APP_VERSION}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-azure-dark/70 dark:text-azure-light/50">{t("about.author")}</span>
              <span className="text-azure-dark dark:text-azure-light">Matías Palomeque</span>
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
