import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { Icon } from "../Common/Icon";
import { extractNamespace } from "../../utils/connection";

export function DeleteEntityDialog() {
  const { t } = useTranslation();
  const conn = useAppStore(selectActiveConnection);
  const {
    deleteEntityTarget,
    setDeleteEntityTarget,
    explorerSelection,
    clearExplorerSelection,
    clearPeekResults,
    addEventLogEntry,
    updateEventLogEntry,
    removeEntity,
  } = useAppStore();

  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!deleteEntityTarget) return null;

  const { type, name, topicName } = deleteEntityTarget;
  const namespace = conn ? extractNamespace(conn.connectionString) : "";
  const typeLabel = t(`explorer.entityManagement.${type}`);
  const displayName = type === "subscription" ? `${topicName}/${name}` : name;

  const close = () => {
    setDeleteEntityTarget(null);
    setError(null);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isSelectedEntity = () => {
    if (type === "queue") {
      return explorerSelection.kind === "queue" && explorerSelection.queueName === name;
    }
    if (type === "subscription") {
      return (
        explorerSelection.kind === "subscription" &&
        explorerSelection.topicName === topicName &&
        explorerSelection.subscriptionName === name
      );
    }
    // For topics, check if any subscription of this topic is selected
    if (type === "topic") {
      return explorerSelection.kind === "subscription" && explorerSelection.topicName === name;
    }
    return false;
  };

  const handleDelete = async () => {
    if (!conn) return;

    setDeleting(true);
    setError(null);

    const logId = crypto.randomUUID();
    addEventLogEntry({
      id: logId,
      time: new Date().toISOString(),
      namespace,
      entity: displayName,
      entityType: type === "queue" ? "Queue" : type === "topic" ? "Topic" : "Subscription",
      operation: "Delete",
      status: "running",
    });

    try {
      if (type === "queue") {
        await invoke("delete_queue", { args: { env: { SERVICE_BUS_CONNECTION_STRING: conn.connectionString, ...conn.env }, name } });
      } else if (type === "topic") {
        await invoke("delete_topic", { args: { env: { SERVICE_BUS_CONNECTION_STRING: conn.connectionString, ...conn.env }, name } });
      } else {
        if (!topicName) {
          setError(t("explorer.entityManagement.deleteError", { type: typeLabel, error: "Missing topic name" }));
          updateEventLogEntry(logId, "error", "Missing topic name");
          return;
        }
        await invoke("delete_subscription", {
          args: { env: { SERVICE_BUS_CONNECTION_STRING: conn.connectionString, ...conn.env }, topicName, subscriptionName: name },
        });
      }

      updateEventLogEntry(logId, "success");

      // Clear selection if the deleted entity was selected
      if (isSelectedEntity()) {
        clearExplorerSelection();
        clearPeekResults();
      }

      removeEntity(type, name, topicName);
      close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(t("explorer.entityManagement.deleteError", { type: typeLabel, error: msg }));
      updateEventLogEntry(logId, "error", msg);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div role="dialog" aria-modal="true" className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-sm mx-4 overflow-hidden border border-zinc-200 dark:border-zinc-700">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-sm font-semibold text-red-600 dark:text-red-400 flex items-center gap-2">
            <Icon name="trash" size={15} />
            {t("explorer.entityManagement.delete")} {typeLabel}
          </h2>
          <button onClick={close} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-3">
          <p className="text-xs text-zinc-600 dark:text-zinc-300">
            {t("explorer.entityManagement.deleteConfirm", { type: typeLabel, name: displayName })}
          </p>

          {type === "topic" && (
            <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 rounded">
              {t("explorer.entityManagement.deleteTopicWarning")}
            </p>
          )}

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">
          <button
            onClick={close}
            className="px-3 py-1.5 text-xs rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            {t("explorer.entityManagement.cancel")}
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-4 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {deleting ? t("explorer.entityManagement.deleting") : t("explorer.entityManagement.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
