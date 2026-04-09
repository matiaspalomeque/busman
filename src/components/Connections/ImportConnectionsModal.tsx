import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnections } from "../../hooks/useConnections";

interface Props {
  onClose: () => void;
}

export function ImportConnectionsModal({ onClose }: Props) {
  const { t } = useTranslation();
  const { importConnections } = useConnections();
  const [password, setPassword] = useState("");
  const [merge, setMerge] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<number | null>(null);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setImporting(true);
    setError(null);
    try {
      const count = await importConnections(password, merge);
      setImported(count);
    } catch (err) {
      const msg = String(err);
      setError(
        msg.includes("Invalid password") || msg.includes("corrupted")
          ? t("connections.importModal.wrongPassword")
          : msg
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md">
      <div className="px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-700">
        <h2 className="text-sm font-semibold text-azure-dark dark:text-azure-light">
          {t("connections.importModal.title")}
        </h2>
      </div>

      <div className="px-5 py-4">
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          {t("connections.importModal.description")}
        </p>

        {imported !== null ? (
          <div className="space-y-4">
            <p className="text-xs text-green-600 dark:text-green-400 font-medium">
              {t("connections.importModal.success", { count: imported })}
            </p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="text-xs px-4 py-1.5 rounded bg-azure-primary text-white hover:bg-azure-primary/90"
              >
                {t("connections.close")}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleImport} className="space-y-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                {t("connections.importModal.password")}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                className="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
              />
            </div>

            <div className="space-y-1.5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={merge}
                  onChange={() => setMerge(true)}
                  className="accent-azure-primary"
                />
                <span className="text-xs text-zinc-600 dark:text-zinc-300">
                  {t("connections.importModal.mergeLabel")}
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={!merge}
                  onChange={() => setMerge(false)}
                  className="accent-azure-primary"
                />
                <span className="text-xs text-zinc-600 dark:text-zinc-300">
                  {t("connections.importModal.replaceLabel")}
                </span>
              </label>
            </div>

            {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
              >
                {t("connections.cancel")}
              </button>
              <button
                type="submit"
                disabled={importing || !password.trim()}
                className="text-xs px-4 py-1.5 rounded bg-azure-primary text-white hover:bg-azure-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {importing
                  ? t("connections.importModal.importing")
                  : t("connections.importModal.import")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
