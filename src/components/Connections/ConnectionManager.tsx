import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useConnections } from "../../hooks/useConnections";
import { ConnectionForm } from "./ConnectionForm";
import type { Connection } from "../../types";

export function ConnectionManager() {
  const { t } = useTranslation();
  const connections = useAppStore((s) => s.connections);
  const activeConn = useAppStore(selectActiveConnection);
  const { deleteConnection, setActive } = useConnections();
  const [editing, setEditing] = useState<Partial<Connection> | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-azure-dark dark:text-azure-light">
            {t("connections.title")}
          </h1>
          <p className="text-sm text-azure-dark/70 dark:text-azure-light/50 mt-1">
            {t("connections.subtitle")}
          </p>
        </div>
        <button
          onClick={() => setEditing({})}
          className="flex-shrink-0 px-3 py-2 text-sm rounded-md bg-azure-primary text-white hover:bg-azure-primary/90 font-medium transition-colors shadow-sm shadow-azure-primary/20"
        >
          {t("connections.addButton")}
        </button>
      </div>

      {/* Empty state */}
      {connections.length === 0 && !editing && (
        <div className="text-center py-20 text-azure-dark/60 dark:text-azure-light/40">
          <p className="text-5xl mb-4">🔗</p>
          <p className="text-sm font-medium">{t("connections.noConnectionsTitle")}</p>
          <p className="text-xs mt-1 text-azure-dark/50 dark:text-azure-light/30">
            {t("connections.noConnectionsSubtitle")}
          </p>
        </div>
      )}

      {/* Connection list */}
      <div className="space-y-3">
        {connections.map((conn) => {
          const isActive = conn.id === activeConn?.id;
          const envCount = Object.keys(conn.env).length;
          return (
            <div
              key={conn.id}
              className={[
                "p-4 rounded-lg border transition-all duration-200",
                isActive
                  ? "border-azure-primary bg-azure-primary/5 dark:bg-azure-primary/10 shadow-sm"
                  : "border-azure-secondary/20 dark:border-azure-secondary/60 bg-white dark:bg-azure-secondary/20 hover:border-azure-secondary/40 dark:hover:border-azure-secondary",
              ].join(" ")}
            >
              <div className="flex items-start justify-between gap-3">
                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-semibold text-sm text-azure-dark dark:text-azure-light truncate">
                      {conn.name}
                    </p>
                    {isActive && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-azure-primary/10 dark:bg-azure-primary/20 text-azure-primary font-medium flex-shrink-0 border border-azure-primary/30">
                        {t("connections.active")}
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-mono text-azure-dark/60 dark:text-azure-light/40 truncate">
                    {conn.connectionString.substring(0, 70)}
                    {conn.connectionString.length > 70 ? "…" : ""}
                  </p>
                  {envCount > 0 && (
                    <p className="text-xs text-azure-dark/60 dark:text-azure-light/40 mt-1">
                      {t("connections.envOverride", {
                        count: envCount,
                        keys: Object.keys(conn.env).join(", "),
                      })}
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!isActive && (
                    <button
                      onClick={() => setActive(conn.id)}
                      className="text-xs px-3 py-1.5 rounded-md border border-azure-secondary/20 dark:border-azure-secondary text-azure-dark/90 dark:text-azure-light/70 hover:bg-azure-secondary/10 dark:hover:bg-azure-secondary/50 transition-colors font-medium shadow-sm"
                    >
                      {t("connections.setActive")}
                    </button>
                  )}
                  <button
                    onClick={() => setEditing(conn)}
                    className="text-xs text-azure-dark/70 dark:text-azure-light/50 hover:text-azure-dark dark:hover:text-azure-light px-2 py-1.5 transition-colors font-medium"
                  >
                    {t("connections.edit")}
                  </button>
                  {confirmDelete === conn.id ? (
                    <>
                      <button
                        onClick={() => {
                          deleteConnection(conn.id).catch((err) =>
                            console.error("Failed to delete connection:", err)
                          );
                          setConfirmDelete(null);
                        }}
                        className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-medium px-2 py-1.5"
                      >
                        {t("connections.confirmDelete")}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="text-xs text-azure-dark/70 hover:text-azure-dark dark:text-azure-light/50 dark:hover:text-azure-light px-2 py-1.5 font-medium"
                      >
                        {t("connections.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(conn.id)}
                      className="text-xs text-azure-dark/70 hover:text-red-600 dark:text-azure-light/50 dark:hover:text-red-400 px-2 py-1.5 transition-colors font-medium"
                    >
                      {t("connections.delete")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Connection form modal */}
      {editing !== null && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
          <ConnectionForm initial={editing} onClose={() => setEditing(null)} />
        </div>
      )}
    </div>
  );
}
