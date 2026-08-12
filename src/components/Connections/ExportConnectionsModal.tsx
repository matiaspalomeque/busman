import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnections } from "../../hooks/useConnections";
import { logHandledError } from "../../utils/logging";

interface Props {
  onClose: () => void;
}

export function ExportConnectionsModal({ onClose }: Props) {
  const { t } = useTranslation();
  const { exportConnections } = useConnections();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const validationError =
    !password.trim()
      ? t("connections.exportModal.passwordEmpty")
      : password !== confirm
      ? t("connections.exportModal.passwordMismatch")
      : null;
  const feedback = error ?? ((password || confirm) ? validationError : null);

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (validationError) return;
    setExporting(true);
    setError(null);
    try {
      await exportConnections(password);
      setSuccess(true);
    } catch (err) {
      logHandledError("Failed to export connections from modal", err);
      setError(String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-connections-title"
      className="flex min-h-[22rem] w-full max-w-md flex-col rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="shrink-0 px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-700">
        <h2 id="export-connections-title" className="text-sm font-semibold text-azure-dark dark:text-azure-light">
          {t("connections.exportModal.title")}
        </h2>
      </div>

      <div className="flex flex-1 flex-col px-5 py-4">
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          {t("connections.exportModal.description")}
        </p>

        {success ? (
          <div className="flex flex-1 flex-col">
            <p role="status" aria-live="polite" className="text-xs text-green-600 dark:text-green-400 font-medium">
              {t("connections.exportModal.success")}
            </p>
            <div className="mt-auto flex justify-end">
              <button
                onClick={onClose}
                className="text-xs px-4 py-1.5 rounded bg-azure-primary text-white hover:bg-azure-primary/90"
              >
                {t("connections.close")}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleExport} className="flex flex-1 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="export-connections-password" className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                {t("connections.exportModal.password")}
              </label>
              <input
                id="export-connections-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                className="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="export-connections-confirm" className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                {t("connections.exportModal.confirmPassword")}
              </label>
              <input
                id="export-connections-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
              />
            </div>

            <div className="h-8 overflow-y-auto" aria-live="assertive">
              {feedback && <p role="alert" className="break-words text-xs text-red-500 dark:text-red-400">{feedback}</p>}
            </div>

            <div className="mt-auto flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
              >
                {t("connections.cancel")}
              </button>
              <button
                type="submit"
                disabled={exporting || !!validationError}
                className="text-xs px-4 py-1.5 rounded bg-azure-primary text-white hover:bg-azure-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {exporting
                  ? t("connections.exportModal.exporting")
                  : t("connections.exportModal.export")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
