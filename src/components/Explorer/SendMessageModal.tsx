import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { Icon } from "../Common/Icon";
import { extractNamespace } from "../../utils/connection";
import type { ExplorerSelection } from "../../types";

interface AppProperty {
  key: string;
  value: string;
}

function extractEntityName(sel: ExplorerSelection): string {
  if (sel.kind === "queue") return sel.queueName;
  if (sel.kind === "subscription") return sel.subscriptionName;
  return "";
}

export function SendMessageModal() {
  const { t } = useTranslation();
  const conn = useAppStore(selectActiveConnection);
  const {
    explorerSelection,
    sendDraft,
    setSendDraft,
    setIsSendModalOpen,
    addEventLogEntry,
    updateEventLogEntry,
  } = useAppStore();

  const [entityName, setEntityName] = useState(extractEntityName(explorerSelection));
  const [body, setBody] = useState(sendDraft?.body ?? "");
  const [contentType, setContentType] = useState(sendDraft?.contentType ?? "application/json");
  const [subject, setSubject] = useState(sendDraft?.subject ?? "");
  const [messageId, setMessageId] = useState("");
  const [correlationId, setCorrelationId] = useState(sendDraft?.correlationId ?? "");
  const [sessionId, setSessionId] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [appProps, setAppProps] = useState<AppProperty[]>(() => {
    if (!sendDraft?.applicationProperties) return [];
    return Object.entries(sendDraft.applicationProperties).map(([key, value]) => ({
      key,
      value: String(value ?? ""),
    }));
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  const overlayRef = useRef<HTMLDivElement>(null);

  // Clear draft on mount
  useEffect(() => {
    setSendDraft(null);
  }, [setSendDraft]);

  const close = () => {
    setIsSendModalOpen(false);
    setSendDraft(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  const formatJson = () => {
    try {
      setBody(JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      /* ignore */
    }
  };

  const handleSend = async () => {
    if (!conn || !entityName.trim()) return;

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);

    const builtProps: Record<string, unknown> = {};
    for (const { key, value } of appProps) {
      if (key.trim()) builtProps[key.trim()] = value;
    }

    const message: Record<string, unknown> = {
      body,
      contentType: contentType || undefined,
      subject: subject || undefined,
      messageId: messageId || undefined,
      correlationId: correlationId || undefined,
      sessionId: sessionId || undefined,
      scheduledEnqueueTimeUtc: scheduled || undefined,
      applicationProperties: Object.keys(builtProps).length > 0 ? builtProps : undefined,
    };

    addEventLogEntry({
      id: runId,
      time: new Date().toISOString(),
      namespace,
      entity: entityName.trim(),
      entityType: "Queue",
      operation: "Send",
      status: "running",
    });

    setSending(true);
    setStatus(null);

    try {
      await invoke("send_message", {
        args: {
          entityName: entityName.trim(),
          env: { SERVICE_BUS_CONNECTION_STRING: conn.connectionString, ...conn.env },
          message,
        },
      });
      setStatus({ ok: true, text: t("explorer.sendModal.success") });
      updateEventLogEntry(runId, "success");
    } catch (err) {
      setStatus({ ok: false, text: String(err) });
      updateEventLogEntry(runId, "error");
    } finally {
      setSending(false);
    }
  };

  const addAppProp = () => setAppProps((p) => [...p, { key: "", value: "" }]);
  const removeAppProp = (i: number) => setAppProps((p) => p.filter((_, idx) => idx !== i));
  const updateAppProp = (i: number, field: "key" | "value", val: string) =>
    setAppProps((p) => p.map((row, idx) => (idx === i ? { ...row, [field]: val } : row)));

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) close();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-sm font-semibold text-azure-dark dark:text-azure-light flex items-center gap-2">
            <Icon name="send" size={14} className="text-azure-primary" />
            {t("explorer.sendModal.title")}
          </h2>
          <button
            onClick={close}
            className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {/* Entity */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
              {t("explorer.sendModal.entityName")} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={entityName}
              onChange={(e) => setEntityName(e.target.value)}
              placeholder="queue-name or topic-name"
              className="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
            />
          </div>

          {/* Body */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{t("explorer.sendModal.body")}</label>
              <button
                onClick={formatJson}
                className="text-[10px] text-azure-primary hover:underline"
              >
                {t("explorer.sendModal.formatJson")}
              </button>
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder='{"key": "value"}'
              className="selectable text-xs px-2.5 py-2 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary font-mono resize-y dark:text-zinc-200"
            />
          </div>

          {/* Content type */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
              {t("explorer.sendModal.contentType")}
            </label>
            <input
              type="text"
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              placeholder="application/json"
              className="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
            />
          </div>

          {/* Advanced */}
          <button
            onClick={() => setShowAdvanced((a) => !a)}
            className="text-xs text-zinc-500 dark:text-zinc-400 hover:text-azure-primary flex items-center gap-1"
          >
            <svg
              width={11}
              height={11}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            {t("explorer.sendModal.advancedProps")}
          </button>

          {showAdvanced && (
            <div className="space-y-3 pl-3 border-l-2 border-zinc-200 dark:border-zinc-700">
              {[
                { label: t("explorer.sendModal.subject"), value: subject, set: setSubject },
                { label: t("explorer.sendModal.correlationId"), value: correlationId, set: setCorrelationId },
                { label: t("explorer.sendModal.sessionId"), value: sessionId, set: setSessionId },
              ].map(({ label, value, set }) => (
                <div key={label} className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                    {label}
                  </label>
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    className="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
                  />
                </div>
              ))}

              {/* MessageId with UUID gen */}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  {t("explorer.sendModal.messageId")}
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={messageId}
                    onChange={(e) => setMessageId(e.target.value)}
                    className="flex-1 text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
                  />
                  <button
                    onClick={() => setMessageId(crypto.randomUUID())}
                    className="text-[10px] px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
                  >
                    {t("explorer.sendModal.uuid")}
                  </button>
                </div>
              </div>

              {/* Scheduled enqueue time */}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  {t("explorer.sendModal.scheduledTime")}
                </label>
                <input
                  type="datetime-local"
                  value={scheduled}
                  onChange={(e) => setScheduled(e.target.value)}
                  className="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
                />
              </div>

              {/* Application properties */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                    {t("explorer.sendModal.applicationProps")}
                  </label>
                  <button
                    onClick={addAppProp}
                    className="text-[10px] text-azure-primary hover:underline"
                  >
                    {t("explorer.sendModal.addProp")}
                  </button>
                </div>
                {appProps.map((row, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <input
                      type="text"
                      value={row.key}
                      onChange={(e) => updateAppProp(i, "key", e.target.value)}
                      placeholder="Key"
                      className="flex-1 text-xs px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
                    />
                    <input
                      type="text"
                      value={row.value}
                      onChange={(e) => updateAppProp(i, "value", e.target.value)}
                      placeholder="Value"
                      className="flex-1 text-xs px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
                    />
                    <button
                      onClick={() => removeAppProp(i)}
                      className="text-zinc-400 hover:text-red-500"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Status */}
          {status && (
            <div
              className={[
                "text-xs px-3 py-2 rounded",
                status.ok
                  ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
                  : "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400",
              ].join(" ")}
            >
              {status.text}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-200 dark:border-zinc-700">
          <button
            onClick={close}
            className="text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
          >
            {t("explorer.sendModal.close")}
          </button>
          <button
            onClick={() => void handleSend()}
            disabled={sending || !entityName.trim() || !conn}
            className="flex items-center gap-1.5 text-xs px-4 py-1.5 rounded bg-azure-primary text-white hover:bg-azure-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending && (
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            )}
            {t("explorer.sendModal.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
