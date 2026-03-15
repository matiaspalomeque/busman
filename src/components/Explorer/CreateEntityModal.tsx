import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useEntityList } from "../../hooks/useEntityList";
import { Icon } from "../Common/Icon";
import { extractNamespace } from "../../utils/connection";

type EntityType = "queue" | "topic" | "subscription";

const MAX_SIZE_OPTIONS = [1024, 2048, 3072, 4096, 5120];

export function CreateEntityModal() {
  const { t } = useTranslation();
  const conn = useAppStore(selectActiveConnection);
  const { entities, setIsCreateEntityModalOpen, addEventLogEntry, updateEventLogEntry } = useAppStore();
  const { refreshEntities } = useEntityList();

  const [entityType, setEntityType] = useState<EntityType>("queue");
  const [name, setName] = useState("");
  const [topicName, setTopicName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Advanced options
  const [maxSizeMb, setMaxSizeMb] = useState(1024);
  const [defaultTtl, setDefaultTtl] = useState("");
  const [lockDuration, setLockDuration] = useState("");
  const [enablePartitioning, setEnablePartitioning] = useState(false);
  const [requiresSession, setRequiresSession] = useState(false);
  const [maxDeliveryCount, setMaxDeliveryCount] = useState(10);
  const [deadLetteringOnExpiration, setDeadLetteringOnExpiration] = useState(false);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const namespace = conn ? extractNamespace(conn.connectionString) : "";
  const topicNames = entities ? Object.keys(entities.topics).sort() : [];

  const close = () => setIsCreateEntityModalOpen(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const validate = (): string | null => {
    if (!name.trim()) return t("explorer.entityManagement.nameRequired");
    if (entityType === "subscription" && !topicName) return t("explorer.entityManagement.topicRequired");
    return null;
  };

  const typeLabel = (type: EntityType) => t(`explorer.entityManagement.${type}`);

  const handleCreate = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!conn) return;

    setCreating(true);
    setError(null);

    const logId = crypto.randomUUID();
    const entityTypeLabel = typeLabel(entityType);
    addEventLogEntry({
      id: logId,
      time: new Date().toISOString(),
      namespace,
      entity: entityType === "subscription" ? `${topicName}/${name.trim()}` : name.trim(),
      entityType: entityType === "queue" ? "Queue" : entityType === "topic" ? "Topic" : "Subscription",
      operation: "Create",
      status: "running",
    });

    try {
      const options: Record<string, unknown> = {};
      if (entityType !== "subscription") {
        options.maxSizeInMegabytes = maxSizeMb;
        options.enablePartitioning = enablePartitioning;
      }
      if (defaultTtl.trim()) options.defaultMessageTimeToLive = defaultTtl.trim();
      if (lockDuration.trim()) options.lockDuration = lockDuration.trim();
      if (entityType !== "topic") {
        options.maxDeliveryCount = maxDeliveryCount;
        options.deadLetteringOnMessageExpiration = deadLetteringOnExpiration;
      }
      if (entityType === "queue") {
        options.requiresSession = requiresSession;
      }
      if (entityType === "subscription") {
        options.requiresSession = requiresSession;
      }

      if (entityType === "queue") {
        await invoke("create_queue", { args: { env: { SERVICE_BUS_CONNECTION_STRING: conn.connectionString, ...conn.env }, name: name.trim(), options } });
      } else if (entityType === "topic") {
        await invoke("create_topic", { args: { env: { SERVICE_BUS_CONNECTION_STRING: conn.connectionString, ...conn.env }, name: name.trim(), options } });
      } else {
        await invoke("create_subscription", {
          args: { env: { SERVICE_BUS_CONNECTION_STRING: conn.connectionString, ...conn.env }, topicName, subscriptionName: name.trim(), options },
        });
      }

      updateEventLogEntry(logId, "success");
      close();
      void refreshEntities();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(t("explorer.entityManagement.createError", { type: entityTypeLabel, error: msg }));
      updateEventLogEntry(logId, "error", msg);
    } finally {
      setCreating(false);
    }
  };

  const inputClass =
    "w-full text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200";
  const labelClass = "block text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1";
  const checkboxRowClass = "flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div role="dialog" aria-modal="true" className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden border border-zinc-200 dark:border-zinc-700">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            {t("explorer.entityManagement.createEntity")}
          </h2>
          <button onClick={close} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
          {/* Entity type */}
          <div>
            <label className={labelClass}>{t("explorer.entityManagement.entityType")}</label>
            <div className="flex gap-1">
              {(["queue", "topic", "subscription"] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => { setEntityType(type); setError(null); }}
                  className={[
                    "flex-1 px-3 py-1.5 text-xs rounded border transition-colors",
                    entityType === type
                      ? "bg-azure-primary text-white border-azure-primary"
                      : "border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800",
                  ].join(" ")}
                >
                  {typeLabel(type)}
                </button>
              ))}
            </div>
          </div>

          {/* Topic selector (for subscriptions) */}
          {entityType === "subscription" && (
            <div>
              <label className={labelClass}>{t("explorer.entityManagement.selectTopic")}</label>
              <select
                value={topicName}
                onChange={(e) => setTopicName(e.target.value)}
                className={inputClass}
              >
                <option value="">--</option>
                {topicNames.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          )}

          {/* Name */}
          <div>
            <label className={labelClass}>{t("explorer.entityManagement.entityName")}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              autoFocus
            />
          </div>

          {/* Advanced options toggle */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-azure-primary hover:underline flex items-center gap-1"
          >
            <Icon name={showAdvanced ? "chevronDown" : "chevronRight"} size={12} />
            {showAdvanced
              ? t("explorer.entityManagement.hideAdvancedOptions")
              : t("explorer.entityManagement.advancedOptions")}
          </button>

          {showAdvanced && (
            <div className="space-y-3 pl-2 border-l-2 border-zinc-200 dark:border-zinc-700">
              {/* Max Size (queue/topic only) */}
              {entityType !== "subscription" && (
                <div>
                  <label className={labelClass}>{t("explorer.entityManagement.maxSizeMb")}</label>
                  <select value={maxSizeMb} onChange={(e) => setMaxSizeMb(Number(e.target.value))} className={inputClass}>
                    {MAX_SIZE_OPTIONS.map((v) => (
                      <option key={v} value={v}>{v} MB</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Default TTL */}
              <div>
                <label className={labelClass}>{t("explorer.entityManagement.defaultTtl")}</label>
                <input
                  type="text"
                  value={defaultTtl}
                  onChange={(e) => setDefaultTtl(e.target.value)}
                  placeholder={t("explorer.entityManagement.ttlPlaceholder")}
                  className={inputClass}
                />
              </div>

              {/* Lock Duration */}
              <div>
                <label className={labelClass}>{t("explorer.entityManagement.lockDuration")}</label>
                <input
                  type="text"
                  value={lockDuration}
                  onChange={(e) => setLockDuration(e.target.value)}
                  placeholder={t("explorer.entityManagement.lockDurationPlaceholder")}
                  className={inputClass}
                />
              </div>

              {/* Partitioning (queue/topic only) */}
              {entityType !== "subscription" && (
                <label className={checkboxRowClass}>
                  <input
                    type="checkbox"
                    checked={enablePartitioning}
                    onChange={(e) => setEnablePartitioning(e.target.checked)}
                    className="accent-azure-primary"
                  />
                  {t("explorer.entityManagement.enablePartitioning")}
                </label>
              )}

              {/* Requires Session (queue/subscription) */}
              {entityType !== "topic" && (
                <label className={checkboxRowClass}>
                  <input
                    type="checkbox"
                    checked={requiresSession}
                    onChange={(e) => setRequiresSession(e.target.checked)}
                    className="accent-azure-primary"
                  />
                  {t("explorer.entityManagement.requiresSession")}
                </label>
              )}

              {/* Max Delivery Count (queue/subscription) */}
              {entityType !== "topic" && (
                <div>
                  <label className={labelClass}>{t("explorer.entityManagement.maxDeliveryCount")}</label>
                  <input
                    type="number"
                    min={1}
                    value={maxDeliveryCount}
                    onChange={(e) => setMaxDeliveryCount(Number(e.target.value) || 10)}
                    className={inputClass}
                  />
                </div>
              )}

              {/* Dead Lettering on Expiration (queue/subscription) */}
              {entityType !== "topic" && (
                <label className={checkboxRowClass}>
                  <input
                    type="checkbox"
                    checked={deadLetteringOnExpiration}
                    onChange={(e) => setDeadLetteringOnExpiration(e.target.checked)}
                    className="accent-azure-primary"
                  />
                  {t("explorer.entityManagement.deadLetteringOnExpiration")}
                </label>
              )}
            </div>
          )}

          {/* Error */}
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
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-1.5 text-xs rounded bg-azure-primary text-white hover:bg-azure-primary/90 disabled:opacity-50"
          >
            {creating ? t("explorer.entityManagement.creating") : t("explorer.entityManagement.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
