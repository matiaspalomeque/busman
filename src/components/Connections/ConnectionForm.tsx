import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnections } from "../../hooks/useConnections";
import type { Connection } from "../../types";

interface ConfigField {
  key: string;
  labelKey: string;
  descKey: string;
  type: "number" | "boolean";
  placeholder?: string;
  min?: number;
}

const CONFIG_FIELDS: ConfigField[] = [
  {
    key: "MAX_WAIT_TIME_IN_MS",
    labelKey: "connectionForm.fieldMaxWaitMs",
    descKey: "connectionForm.fieldMaxWaitMsDesc",
    type: "number",
    placeholder: "60000",
    min: 1,
  },
  {
    key: "RECEIVE_MESSAGES_COUNT",
    labelKey: "connectionForm.fieldReceiveCount",
    descKey: "connectionForm.fieldReceiveCountDesc",
    type: "number",
    placeholder: "50",
    min: 1,
  },
  {
    key: "DRAIN_IDLE_WAIT_TIME_IN_MS",
    labelKey: "connectionForm.fieldDrainIdleMs",
    descKey: "connectionForm.fieldDrainIdleMsDesc",
    type: "number",
    placeholder: "3000",
    min: 1,
  },
  {
    key: "MOVE_PROGRESS_INTERVAL_MS",
    labelKey: "connectionForm.fieldProgressIntervalMs",
    descKey: "connectionForm.fieldProgressIntervalMsDesc",
    type: "number",
    placeholder: "500",
    min: 50,
  },
  {
    key: "BATCH_SIZE",
    labelKey: "connectionForm.fieldBatchSize",
    descKey: "connectionForm.fieldBatchSizeDesc",
    type: "number",
    placeholder: "50",
    min: 1,
  },
];

const KNOWN_KEYS = new Set(CONFIG_FIELDS.map((f) => f.key));

interface Props {
  initial: Partial<Connection>;
  onClose: () => void;
}

export function ConnectionForm({ initial, onClose }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name ?? "");
  const [connStr, setConnStr] = useState(initial.connectionString ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { saveConnection } = useConnections();

  // Config state: one entry per known field, initialised from initial.env
  const [config, setConfig] = useState<Record<string, string>>(() => {
    const env = initial.env ?? {};
    return Object.fromEntries(CONFIG_FIELDS.map((f) => [f.key, env[f.key] ?? ""]));
  });

  // Auto-expand if any field already has a stored value
  const [showAdvanced, setShowAdvanced] = useState(() =>
    CONFIG_FIELDS.some((f) => !!(initial.env ?? {})[f.key])
  );

  const setField = (key: string, value: string) =>
    setConfig((prev) => ({ ...prev, [key]: value }));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !connStr.trim()) return;
    setSaving(true);
    setError(null);

    // Preserve any unknown env keys not managed by this form
    const configEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(initial.env ?? {})) {
      if (!KNOWN_KEYS.has(k)) configEnv[k] = v;
    }
    // Write non-empty structured values
    for (const f of CONFIG_FIELDS) {
      const val = config[f.key];
      if (val !== "") configEnv[f.key] = val;
    }

    try {
      await saveConnection({
        id: initial.id ?? "",
        name: name.trim(),
        connectionString: connStr.trim(),
        env: configEnv,
      });
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white dark:bg-azure-secondary rounded-xl shadow-xl p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
      <h2 className="text-lg font-semibold text-azure-dark dark:text-azure-light mb-4">
        {initial.id ? t("connectionForm.titleEdit") : t("connectionForm.titleAdd")}
      </h2>

      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-azure-dark/90 dark:text-azure-light/70 mb-1">
            {t("connectionForm.labelName")}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Production"
            autoFocus
            className="w-full px-3 py-2 rounded-md border border-azure-secondary/20 dark:border-azure-secondary/60 bg-white dark:bg-azure-dark text-azure-dark dark:text-azure-light text-sm focus:outline-none focus:ring-2 focus:ring-azure-primary/50"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-azure-dark/90 dark:text-azure-light/70 mb-1">
            {t("connectionForm.labelConnectionString")}
          </label>
          <textarea
            value={connStr}
            onChange={(e) => setConnStr(e.target.value)}
            placeholder="Endpoint=sb://your-namespace.servicebus.windows.net/;SharedAccessKeyName=..."
            rows={3}
            className="selectable w-full px-3 py-2 rounded-md border border-azure-secondary/20 dark:border-azure-secondary/60 bg-white dark:bg-azure-dark text-azure-dark dark:text-azure-light text-sm font-mono focus:outline-none focus:ring-2 focus:ring-azure-primary/50 resize-none"
          />
        </div>

        {/* Advanced settings */}
        <div className="border border-azure-secondary/20 dark:border-azure-secondary/60 rounded-md overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-azure-dark/80 dark:text-azure-light/60 bg-azure-secondary/5 dark:bg-azure-dark/40 hover:bg-azure-secondary/10 dark:hover:bg-azure-dark/60 transition-colors"
          >
            <span>
              {showAdvanced
                ? t("connectionForm.advancedToggleHide")
                : t("connectionForm.advancedToggle")}
            </span>
            <span className="text-azure-dark/40 dark:text-azure-light/30 text-xs">
              {showAdvanced ? "▲" : "▼"}
            </span>
          </button>

          {showAdvanced && (
            <div className="px-3 py-2 grid grid-cols-2 gap-x-3 gap-y-2">
              {CONFIG_FIELDS.map((field) =>
                field.type === "boolean" ? (
                  <label
                    key={field.key}
                    className="col-span-2 flex items-center gap-2 cursor-pointer py-1"
                    title={t(field.descKey)}
                  >
                    <input
                      type="checkbox"
                      checked={config[field.key] === "true"}
                      onChange={(e) =>
                        setField(field.key, e.target.checked ? "true" : "")
                      }
                      className="h-4 w-4 rounded border-azure-secondary/40 text-azure-primary focus:ring-azure-primary/50 accent-azure-primary"
                    />
                    <span className="text-sm font-medium text-azure-dark/90 dark:text-azure-light/70">
                      {t(field.labelKey)}
                    </span>
                  </label>
                ) : (
                  <div key={field.key} title={t(field.descKey)}>
                    <label className="block text-xs font-medium text-azure-dark/80 dark:text-azure-light/60 mb-1">
                      {t(field.labelKey)}
                    </label>
                    <input
                      type="number"
                      value={config[field.key]}
                      onChange={(e) => setField(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      min={field.min}
                      className="w-full px-2 py-1.5 rounded-md border border-azure-secondary/20 dark:border-azure-secondary/60 bg-white dark:bg-azure-dark text-azure-dark dark:text-azure-light text-sm focus:outline-none focus:ring-2 focus:ring-azure-primary/50"
                    />
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md border border-azure-secondary/20 dark:border-azure-secondary/60 text-azure-dark/90 dark:text-azure-light/70 hover:bg-azure-secondary/10 dark:hover:bg-azure-dark transition-colors"
          >
            {t("connectionForm.cancel")}
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim() || !connStr.trim()}
            className="px-4 py-2 text-sm rounded-md bg-azure-primary text-white hover:bg-azure-primary/90 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-azure-primary/20"
          >
            {saving ? t("connectionForm.saving") : t("connectionForm.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
