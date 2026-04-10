import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store/appStore";
import { useConnections } from "../../hooks/useConnections";
import { Icon } from "../Common/Icon";
import { safeColor } from "../../utils/color";
import { ExportConnectionsModal } from "../Connections/ExportConnectionsModal";
import { ImportConnectionsModal } from "../Connections/ImportConnectionsModal";
import type { Connection } from "../../types";

type FormMode = { kind: "add" } | { kind: "edit"; connection: Connection };

const ENV_PRESETS: { value: string; color: string }[] = [
  { value: "dev", color: "#22c55e" },
  { value: "staging", color: "#f59e0b" },
  { value: "prod", color: "#ef4444" },
];

type TestResult =
  | { ok: true; queueCount: number; topicCount: number }
  | { ok: false; error: string };

interface ConnectionFormProps {
  initial?: Partial<Connection>;
  onSave: (c: Partial<Connection> & { name: string; connectionString: string }) => Promise<void>;
  onCancel: () => void;
}

function ConnectionForm({ initial, onSave, onCancel }: ConnectionFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [connectionString, setConnectionString] = useState(initial?.connectionString ?? "");
  const [environment, setEnvironment] = useState(initial?.environment ?? "");
  const [environmentColor, setEnvironmentColor] = useState(initial?.environmentColor ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const handleEnvironmentChange = (value: string) => {
    setEnvironment(value);
    const preset = ENV_PRESETS.find((p) => p.value === value);
    setEnvironmentColor(preset?.color ?? "");
  };

  const handleConnectionStringChange = (value: string) => {
    setConnectionString(value);
    setTestResult(null);
  };

  const handleTest = async () => {
    if (!connectionString.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invoke<{ queueCount: number; topicCount: number }>(
        "test_connection",
        { connectionString: connectionString.trim() }
      );
      setTestResult({ ok: true, queueCount: result.queueCount, topicCount: result.topicCount });
    } catch (err) {
      const msg = String(err);
      setTestResult({ ok: false, error: msg.length > 200 ? `${msg.slice(0, 200)}…` : msg });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !connectionString.trim()) {
      setError(t("explorer.connectionsModal.required"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({
        ...initial,
        name: name.trim(),
        connectionString: connectionString.trim(),
        environment: environment || undefined,
        environmentColor: environmentColor || undefined,
      });
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
          onChange={(e) => handleConnectionStringChange(e.target.value)}
          rows={3}
          placeholder="Endpoint=sb://your-namespace.servicebus.windows.net/;SharedAccessKeyName=...;SharedAccessKey=..."
          className="selectable text-xs px-2.5 py-2 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary font-mono resize-none dark:text-zinc-200"
        />
      </div>

      {/* Environment selector */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {t("explorer.connectionsModal.environment")}
        </label>
        <div className="flex items-center gap-2">
          <select
            value={environment}
            onChange={(e) => handleEnvironmentChange(e.target.value)}
            className="flex-1 text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200 select-custom-arrow"
          >
            <option value="">{t("explorer.connectionsModal.envNone")}</option>
            {ENV_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {t(`explorer.connectionsModal.env.${p.value}`)}
              </option>
            ))}
          </select>
          {environment && (
            <span
              className="w-4 h-4 rounded-full border border-zinc-300 dark:border-zinc-600 shrink-0"
              style={{ backgroundColor: safeColor(environmentColor) }}
              title={environmentColor}
            />
          )}
        </div>
      </div>

      {/* Test result */}
      {testResult && (
        <p
          className={[
            "text-xs px-2.5 py-1.5 rounded",
            testResult.ok
              ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
              : "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400",
          ].join(" ")}
        >
          {testResult.ok
            ? t("explorer.connectionsModal.testSuccess", {
                queues: testResult.queueCount,
                topics: testResult.topicCount,
              })
            : t("explorer.connectionsModal.testError", { error: testResult.error })}
        </p>
      )}

      {error && (
        <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
      )}

      <div className="flex justify-between gap-2">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={testing || !connectionString.trim()}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {testing && (
            <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          )}
          {testing
            ? t("explorer.connectionsModal.testing")
            : t("explorer.connectionsModal.test")}
        </button>
        <div className="flex gap-2">
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
      </div>
    </form>
  );
}

function EnvironmentBadge({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  const color = safeColor(connection.environmentColor);
  if (!connection.environment || !color) return null;
  return (
    <span
      aria-label={t(`explorer.connectionsModal.env.${connection.environment}`, connection.environment)}
      className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded"
      style={{
        backgroundColor: `${color}20`,
        color,
      }}
    >
      <span
        aria-hidden="true"
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {t(`explorer.connectionsModal.env.${connection.environment}`, connection.environment)}
    </span>
  );
}

export function ConnectionsPanel() {
  const { t } = useTranslation();
  const { connections, activeConnectionId } = useAppStore();
  const { saveConnection, deleteConnection, setActive } = useConnections();

  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);

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
    <div className="flex flex-col flex-1 min-h-0">
      {/* Connection list */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
        {connections.length === 0 && !formMode && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 py-2">
            {t("explorer.connectionsModal.noConnections")}
          </p>
        )}

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
                    <EnvironmentBadge connection={c} />
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
      <div className="flex items-center justify-between px-5 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
          >
            {t("connections.importButton")}
          </button>
          <button
            onClick={() => setShowExport(true)}
            disabled={connections.length === 0}
            className="text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t("connections.exportButton")}
          </button>
        </div>
      </div>

      {showExport && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <ExportConnectionsModal onClose={() => setShowExport(false)} />
        </div>
      )}
      {showImport && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <ImportConnectionsModal onClose={() => setShowImport(false)} />
        </div>
      )}
    </div>
  );
}
