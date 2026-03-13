import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useResizable } from "../../hooks/useResizable";
import { bodyString } from "./MessageGrid";
import { extractNamespace } from "../../utils/connection";

function formatBodyJson(body: unknown): string {
  const raw = bodyString(body);
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ─── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-3 py-1.5 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-700">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
    </div>
  );
}

// ─── Property row ─────────────────────────────────────────────────────────────

function PropRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col px-3 py-1.5 border-b border-zinc-100 dark:border-zinc-800">
      <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{label}</span>
      <span className="text-xs text-azure-dark dark:text-zinc-200 selectable break-all">
        {value}
      </span>
    </div>
  );
}

// ─── PropertiesPanel ─────────────────────────────────────────────────────────

export function PropertiesPanel() {
  const { t } = useTranslation();
  const conn = useAppStore(selectActiveConnection);
  const { explorerSelection, selectedMessage, setIsSendModalOpen, setSendDraft, propertiesPanelWidth, setPropertiesPanelWidth } = useAppStore();

  const { widthRef, onPointerDown } = useResizable({
    initialWidth: propertiesPanelWidth,
    minWidth: 200,
    maxWidth: 600,
    direction: "left",
    onDragEnd: setPropertiesPanelWidth,
  });
  widthRef.current = propertiesPanelWidth;

  const namespace = conn ? extractNamespace(conn.connectionString) : "—";

  const entityName =
    explorerSelection.kind === "queue"
      ? explorerSelection.queueName
      : explorerSelection.kind === "subscription"
        ? `${explorerSelection.topicName} / ${explorerSelection.subscriptionName}`
        : null;

  const entityType =
    explorerSelection.kind === "queue"
      ? t("explorer.properties.typeQueue")
      : explorerSelection.kind === "subscription"
        ? t("explorer.properties.typeSubscription")
        : null;

  const appProps = selectedMessage?.applicationProperties;

  const handleResend = () => {
    if (!selectedMessage) return;
    const raw = bodyString(selectedMessage.body);
    setSendDraft({
      body: raw,
      contentType: selectedMessage.contentType ?? undefined,
      subject: selectedMessage.subject ?? undefined,
      correlationId: selectedMessage.correlationId ?? undefined,
      applicationProperties: selectedMessage.applicationProperties ?? undefined,
    });
    setIsSendModalOpen(true);
  };

  return (
    <aside
      className="relative shrink-0 flex flex-col border-l border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden"
      style={{ width: propertiesPanelWidth }}
    >
      {/* Drag handle — left edge */}
      <div
        onPointerDown={onPointerDown}
        className="absolute top-0 left-0 h-full w-1.5 cursor-col-resize group z-10"
      >
        <div className="absolute inset-y-0 left-0 w-px bg-transparent group-hover:bg-azure-primary/40 group-active:bg-azure-primary/70 transition-colors" />
      </div>

      {/* Entity Info */}
      <SectionHeader label={t("explorer.properties.entityInfo")} />
      <div className="flex flex-col px-3 py-2.5 gap-1 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex flex-col">
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{t("explorer.properties.namespace")}</span>
          <span
            className="text-xs font-medium text-azure-dark dark:text-zinc-200 truncate selectable"
            title={namespace}
          >
            {namespace}
          </span>
        </div>
        {entityName ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-azure-dark dark:text-zinc-200 truncate selectable">
              {entityName}
            </span>
            {entityType && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-azure-primary/10 text-azure-primary font-semibold">
                {entityType}
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-zinc-400">{t("explorer.properties.noEntitySelected")}</span>
        )}
      </div>

      {/* Message Detail */}
      <SectionHeader label={t("explorer.properties.messageDetail")} />
      <div className="flex-1 overflow-y-auto">
        {!selectedMessage ? (
          <div className="px-3 py-6 text-xs text-zinc-400 dark:text-zinc-500 text-center">
            {t("explorer.properties.clickToInspect")}
          </div>
        ) : (
          <>
            {/* System properties */}
            <PropRow label={t("explorer.properties.messageId")} value={selectedMessage.messageId ?? "—"} />
            {selectedMessage.sequenceNumber != null && (
              <PropRow label={t("explorer.properties.sequenceNumber")} value={String(selectedMessage.sequenceNumber)} />
            )}
            <PropRow label={t("explorer.properties.enqueuedTime")} value={formatTime(selectedMessage.enqueuedTimeUtc)} />
            <PropRow label={t("explorer.properties.expiresAt")} value={formatTime(selectedMessage.expiresAtUtc)} />
            {selectedMessage.subject && (
              <PropRow label={t("explorer.properties.subject")} value={selectedMessage.subject} />
            )}
            {selectedMessage.contentType && (
              <PropRow label={t("explorer.properties.contentType")} value={selectedMessage.contentType} />
            )}
            {selectedMessage.correlationId && (
              <PropRow label={t("explorer.properties.correlationId")} value={selectedMessage.correlationId} />
            )}
            {selectedMessage.deadLetterReason && (
              <PropRow
                label={t("explorer.properties.deadLetterReason")}
                value={
                  <span className="text-amber-600 dark:text-amber-400">
                    {selectedMessage.deadLetterReason}
                  </span>
                }
              />
            )}
            {selectedMessage.deadLetterErrorDescription && (
              <PropRow
                label={t("explorer.properties.deadLetterDescription")}
                value={selectedMessage.deadLetterErrorDescription}
              />
            )}
            {selectedMessage._source && (
              <PropRow label={t("explorer.properties.source")} value={selectedMessage._source} />
            )}

            {/* Application properties */}
            {appProps && Object.keys(appProps).length > 0 && (
              <>
                <SectionHeader label={t("explorer.properties.applicationProperties")} />
                {Object.entries(appProps).map(([k, v]) => (
                  <PropRow key={k} label={k} value={String(v ?? "")} />
                ))}
              </>
            )}

            {/* Body */}
            <SectionHeader label={t("explorer.properties.body")} />
            <div className="relative">
              <pre className="selectable px-3 py-2 text-[10px] leading-relaxed font-mono text-azure-dark dark:text-zinc-200 overflow-x-auto whitespace-pre-wrap break-words">
                {formatBodyJson(selectedMessage.body) || (
                  <span className="text-zinc-400">{t("explorer.properties.bodyEmpty")}</span>
                )}
              </pre>
            </div>

            {/* Resend action */}
            <div className="px-3 pb-3">
              <button
                onClick={handleResend}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded border border-azure-primary text-azure-primary hover:bg-azure-primary/10 transition-colors"
              >
                {t("explorer.properties.resend")}
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
