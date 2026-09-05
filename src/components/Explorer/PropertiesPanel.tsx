import { useShallow } from "zustand/react/shallow";
import { useEffect, useState } from "react";
import { MessageBody, ExpandedMessageBody } from "./MessageBody";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useResizable } from "../../hooks/useResizable";
import { formatTimestamp as formatTime } from "./entityDetailsFormat";
import { useScript } from "../../hooks/useScript";
import { addSingleMessageActionMetadata, findMessageReplay, isDeadLetterMessage, messageOperationKey } from "../../utils/messageOperation";
import { ReplayFeedback } from "./ReplayFeedback";
import { isCanonicalSequenceNumber } from "../../utils/sequenceNumber";
import { extractNamespace } from "../../utils/connection";
import { exitCodeToStatus } from "../../utils/exitCode";

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
      <span className="text-xs text-azure-dark dark:text-zinc-200 selectable break-words">
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
    propertiesPanelWidth,
    setPropertiesPanelWidth,
  } = useAppStore(useShallow((state) => ({
    selectedMessage: state.selectedMessage,
    setSelectedMessage: state.setSelectedMessage,
    propertiesPanelWidth: state.propertiesPanelWidth,
    setPropertiesPanelWidth: state.setPropertiesPanelWidth,
  })));
  const { runOperation, isRunning } = useScript();
  const pending = useAppStore((state) => {
    const key = state.selectedMessage && messageOperationKey(state.selectedMessage);
    return key ? state.pendingMessageOperations[key] != null : false;
  });
  const [resendError, setResendError] = useState<string | null>(null);
  const replayEntry = useAppStore((state) => state.selectedMessage
    ? findMessageReplay(state.eventLog, state.activeConnectionId, state.explorerSelection, state.selectedMessage) : undefined);
  const [tab, setTab] = useState<"body" | "properties" | "failure">("body");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setTab("body"); setExpanded(false); setResendError(null); }, [selectedMessage]);

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

  const handleResend = async () => {
    const state = useAppStore.getState();
    const conn = selectActiveConnection(state);
    const selection = state.explorerSelection;
    const target = state.selectedMessage;
    const key = target && messageOperationKey(target);
    if (!conn || !target || !key || !isCanonicalSequenceNumber(target.sequenceNumber) || selection.kind === "none" || state.isRunning || state.pendingMessageOperations[key]) return;

    const runId = crypto.randomUUID();
    const params: Record<string, unknown> = {
      action: "replay", connectionId: conn.id, sequenceNumber: target.sequenceNumber, isDlq: isDeadLetterMessage(target),
      ...(selection.kind === "queue"
        ? { queueName: selection.queueName, destQueue: selection.queueName }
        : { topicName: selection.topicName, subscriptionName: selection.subscriptionName, destTopic: selection.topicName }),
    };
    addSingleMessageActionMetadata(params, target);
    setResendError(null);
    state.addEventLogEntry({
      id: runId, time: new Date().toISOString(), namespace: extractNamespace(conn.connectionString),
      entity: `${selection.kind === "queue" ? selection.queueName : `${selection.topicName}/${selection.subscriptionName}`} #${target.sequenceNumber}`,
      entityType: selection.kind === "queue" ? "Queue" : "Subscription", operation: "ReplayMessage", status: "running",
    });
    state.startMessageOperation(key, { runId, operation: "ReplayMessage", startedAt: new Date().toISOString() });
    const showError = (error: string) => {
      const current = useAppStore.getState();
      if (current.connectionGeneration === state.connectionGeneration && current.selectedMessage === target) setResendError(error);
    };
    try {
      const { exitCode, errorMessage, contextCurrent } = await runOperation("single_message_action", params, { scope: "atomic", runId });
      state.updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
      if (exitCode === 0 && contextCurrent !== false) state.removePeekedMessageByKey(key);
      else if (exitCode !== 0) showError(errorMessage ?? t("explorer.properties.resendFailed"));
    } catch (error) {
      state.updateEventLogEntry(runId, "error", String(error));
      showError(String(error));
    } finally {
      state.finishMessageOperation(key, runId);
    }
  };

  return (
    <aside
      aria-label={t("explorer.properties.messageDetail")}
      className="relative shrink-0 flex flex-col border-l border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden"
      style={{ width: propertiesPanelWidth }}
    >
      {/* Drag handle — left edge */}
      <div
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("explorer.properties.resizePanel")}
        title={t("explorer.properties.resizePanel")}
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
          aria-label={t("explorer.properties.close")}
          title={t("explorer.properties.close")}
          className="shrink-0 rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:outline-none focus:ring-1 focus:ring-azure-primary transition-colors"
        >
          {t("explorer.properties.close")}
        </button>
      </div>

      {replayEntry && <ReplayFeedback entry={replayEntry} />}
      {selectedMessage.deadLetterReason && <p className="px-3 py-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 break-words">{selectedMessage.deadLetterReason}</p>}
      <div role="tablist" aria-label={t("explorer.properties.messageDetail")} className="flex border-b border-zinc-200 dark:border-zinc-700 px-2">
        {(["body", "properties", "failure"] as const).map((value, index, tabs) => <button key={value} role="tab" id={`message-tab-${value}`} aria-selected={tab === value} aria-controls={`message-panel-${value}`} tabIndex={tab === value ? 0 : -1}
          onClick={() => setTab(value)} onKeyDown={(event) => {
            const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!delta) return;
            event.preventDefault();
            const next = tabs[(index + delta + tabs.length) % tabs.length];
            setTab(next); document.getElementById(`message-tab-${next}`)?.focus();
          }}
          className={`px-3 py-2 text-xs border-b-2 ${tab === value ? "border-azure-primary text-azure-primary" : "border-transparent text-zinc-500"}`}>{t(`explorer.properties.${value}`)}</button>)}
      </div>
      <div role="tabpanel" id={`message-panel-${tab}`} aria-labelledby={`message-tab-${tab}`} className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        {tab === "body" && <MessageBody key={selectedMessage.messageId ?? selectedMessage.sequenceNumber} body={selectedMessage.body} onExpand={() => setExpanded(true)} />}
        {tab === "failure" && <div>
          <PropRow label={t("explorer.properties.deadLetterReason")} value={selectedMessage.deadLetterReason || t("explorer.properties.noFailure")} />
          <PropRow label={t("explorer.properties.deadLetterDescription")} value={selectedMessage.deadLetterErrorDescription || "—"} />
          <PropRow label={t("explorer.properties.source")} value={selectedMessage._source} />
        </div>}
        {tab === "properties" && <div>
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

        </div>}
          {/* Resend action */}
          <div className="px-3 pb-3">
            {resendError && <p role="alert" className="mb-2 text-xs text-red-600 dark:text-red-400 break-words">{resendError}</p>}
            <button
              type="button"
              onClick={() => void handleResend()}
              disabled={pending || isRunning || !isCanonicalSequenceNumber(selectedMessage.sequenceNumber)}
              aria-busy={pending}
              className="disabled:opacity-40 disabled:cursor-not-allowed w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded border border-azure-primary text-azure-primary hover:bg-azure-primary/10 focus:outline-none focus:ring-1 focus:ring-azure-primary transition-colors"
            >
              {t(pending ? "explorer.properties.resending" : "explorer.properties.resend")}
            </button>
          </div>
      </div>
      {expanded && <ExpandedMessageBody body={selectedMessage.body} onClose={() => setExpanded(false)} />}
    </aside>
  );
}
