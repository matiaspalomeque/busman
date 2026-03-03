import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/appStore";
import { useConnections } from "../../hooks/useConnections";
import { Icon } from "../Common/Icon";
import type { Connection } from "../../types";

type FormMode = { kind: "add" } | { kind: "edit"; connection: Connection };

interface ConnectionFormProps {
  initial?: Partial<Connection>;
  onSave: (c: Partial<Connection> & { name: string; connectionString: string }) => Promise<void>;
  onCancel: () => void;
}

function ConnectionForm({ initial, onSave, onCancel }: ConnectionFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [connectionString, setConnectionString] = useState(initial?.connectionString ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !connectionString.trim()) {
      setError(t("explorer.connectionsModal.required"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({ ...initial, name: name.trim(), connectionString: connectionString.trim() });
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3 pt-2">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {t("explorer.connectionsModal.name")} <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Production"
          autoFocus
          className="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {t("explorer.connectionsModal.connectionString")} <span className="text-red-500">*</span>
        </label>
        <textarea
          value={connectionString}
          onChange={(e) => setConnectionString(e.target.value)}
          rows={3}
          placeholder="Endpoint=sb://your-namespace.servicebus.windows.net/;SharedAccessKeyName=...;SharedAccessKey=..."
          className="selectable text-xs px-2.5 py-2 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary font-mono resize-none dark:text-zinc-200"
        />
      </div>

      {error && (
        <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
        >
          {t("explorer.connectionsModal.cancel")}
        </button>
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-1.5 text-xs px-4 py-1.5 rounded bg-azure-primary text-white hover:bg-azure-primary/90 disabled:opacity-40"
        >
          {saving && (
            <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
          )}
          {t("explorer.connectionsModal.save")}
        </button>
      </div>
    </form>
  );
}

export function ConnectionsModal() {
  const { t } = useTranslation();
  const { connections, activeConnectionId, setIsConnectionsModalOpen } = useAppStore();
  const { saveConnection, deleteConnection, setActive } = useConnections();

  const overlayRef = useRef<HTMLDivElement>(null);
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const close = () => setIsConnectionsModalOpen(false);

  const handleSave = async (
    c: Partial<Connection> & { name: string; connectionString: string }
  ) => {
    await saveConnection(c);
    setFormMode(null);
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await deleteConnection(id);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-lg max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-sm font-semibold text-azure-dark dark:text-azure-light flex items-center gap-2">
            <Icon name="server" size={14} className="text-azure-primary" />
            {t("explorer.connectionsModal.title")}
          </h2>
          <button
            onClick={close}
            className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {connections.length === 0 && !formMode && (
            <p className="text-xs text-zinc-400 dark:text-zinc-500 py-2">
              {t("explorer.connectionsModal.noConnections")}
            </p>
          )}

          {/* Connection list */}
          {connections.map((c) => (
            <div key={c.id}>
              {formMode?.kind === "edit" && formMode.connection.id === c.id ? (
                <div className="p-3 rounded-lg border border-azure-primary/40 bg-azure-primary/5">
                  <p className="text-[10px] font-semibold text-azure-primary mb-2 uppercase tracking-wider">
                    {t("explorer.connectionsModal.editing", { name: c.name })}
                  </p>
                  <ConnectionForm
                    initial={c}
                    onSave={handleSave}
                    onCancel={() => setFormMode(null)}
                  />
                </div>
              ) : (
                <div
                  className={[
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors",
                    activeConnectionId === c.id
                      ? "border-azure-primary/40 bg-azure-primary/5"
                      : "border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800",
                  ].join(" ")}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-azure-dark dark:text-zinc-200 truncate">
                        {c.name}
                      </span>
                      {activeConnectionId === c.id && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-azure-primary/10 text-azure-primary font-semibold">
                          {t("explorer.connectionsModal.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate font-mono mt-0.5">
                      {c.connectionString.slice(0, 60)}…
                    </p>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => void setActive(c.id)}
                      disabled={activeConnectionId === c.id}
                      className="text-[10px] px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                    >
                      {t("explorer.connectionsModal.use")}
                    </button>
                    <button
                      onClick={() => setFormMode({ kind: "edit", connection: c })}
                      className="p-1 rounded text-zinc-400 hover:text-azure-primary hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      title={t("explorer.connectionsModal.editTitle")}
                    >
                      <Icon name="settings" size={13} />
                    </button>
                    <button
                      onClick={() => void handleDelete(c.id)}
                      disabled={deleting === c.id}
                      className="p-1 rounded text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                      title={t("explorer.connectionsModal.deleteTitle")}
                    >
                      {deleting === c.id ? (
                        <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin block" />
                      ) : (
                        <Icon name="trash" size={13} />
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Add form */}
          {formMode?.kind === "add" && (
            <div className="p-3 rounded-lg border border-azure-primary/40 bg-azure-primary/5">
              <p className="text-[10px] font-semibold text-azure-primary mb-2 uppercase tracking-wider">
                {t("explorer.connectionsModal.newConnection")}
              </p>
              <ConnectionForm onSave={handleSave} onCancel={() => setFormMode(null)} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-zinc-200 dark:border-zinc-700">
          {formMode?.kind !== "add" ? (
            <button
              onClick={() => setFormMode({ kind: "add" })}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-azure-primary text-white hover:bg-azure-primary/90"
            >
              <span>+</span>
              {t("explorer.connectionsModal.addConnection")}
            </button>
          ) : (
            <div />
          )}
          <button
            onClick={close}
            className="text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
          >
            {t("explorer.connectionsModal.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
