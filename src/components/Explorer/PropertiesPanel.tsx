import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/appStore";
import { useResizable } from "../../hooks/useResizable";
import { bodyString } from "./MessageGrid";
import { formatTimestamp as formatTime } from "./entityDetailsFormat";

function formatBodyJson(body: unknown): string {
  const raw = bodyString(body);
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
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
  const {
    selectedMessage,
    setSelectedMessage,
    setIsSendModalOpen,
    setSendDraft,
    propertiesPanelWidth,
    setPropertiesPanelWidth,
  } = useAppStore();

  const { widthRef, onPointerDown } = useResizable({
    initialWidth: propertiesPanelWidth,
    minWidth: 200,
    maxWidth: 600,
    direction: "left",
    onDragEnd: setPropertiesPanelWidth,
  });
  widthRef.current = propertiesPanelWidth;
  if (!selectedMessage) return null;

  const appProps = selectedMessage.applicationProperties;

  const handleResend = () => {
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

      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            {t("explorer.properties.messageDetail")}
          </div>
          <div className="text-xs text-azure-dark dark:text-zinc-200 truncate selectable">
            {selectedMessage.messageId ?? "—"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSelectedMessage(null)}
          className="shrink-0 rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          {t("explorer.properties.close")}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
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
      </div>
    </aside>
  );
}
